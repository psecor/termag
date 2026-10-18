/**
 * Which workstream a pull request belongs to. The pipeline's own link (prPipeline.ts
 * linkWorkstream) only holds while a workstream's checkout is on the PR's
 * branch, and agents often open a PR from a plain git worktree that no
 * workstream owns. So the link is also stored, one per user and PR:
 *
 *   created  the workstream's agent ran `gh pr create` (the pr_created milestone)
 *   branch   the workstream's checkout was seen on the PR's branch
 *   manual   the user attached it from the PR overlay
 *
 * A manual link is only ever replaced by hand. Otherwise the first link wins,
 * so a reviewer's checkout of the branch does not take a PR from the session
 * that opened it. On read, a manual link beats the live checkout, which beats
 * a stored created/branch link.
 */

import { prisma } from '../db';
import { prKey, type PrRow, type WorkstreamLink } from './prPipeline';
import { PrInputError } from './prReview';
import { isAmbiguousSession, resolveSessionProject } from './sessionResolver';

export type StoredLinkSource = 'created' | 'branch' | 'manual';
/** How a row got its workstream: `checkout` is the live branch match, the rest are stored. */
export type LinkedBy = 'checkout' | StoredLinkSource;

export interface StoredLink {
  repo: string;
  number: number;
  source: StoredLinkSource;
  workstream: WorkstreamLink;
  /** When the link was first stored (ISO); absent from older test stores. */
  at?: string;
}

/** A PR a workstream worked on earlier that is in no lane any more (merged before the window, or closed). */
export interface EarlierPr {
  repo: string;
  number: number;
  workstream: WorkstreamLink;
  at: string | null;
}

/** How many earlier PRs GET /api/prs sends: the sidebar shows a few per workstream at most. */
export const EARLIER_LIMIT = 200;

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})$/;

/** owner/name and number from a GitHub PR URL; null for anything else. */
export function parsePrUrl(url: string | null | undefined): { repo: string; number: number } | null {
  const m = url ? PR_URL.exec(url) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

const linkKey = (repo: string, number: number) => prKey(repo.toLowerCase(), number);

/** Whether a link from `next` may replace one from `current`. */
export function replaces(current: StoredLinkSource | null, next: StoredLinkSource): boolean {
  if (current === null) return true;
  return next === 'manual';
}

/**
 * The rows with stored links applied. Rows that change are copied: the
 * pipeline's rows are memoized and shared between reads.
 */
export function applyLinks<R extends Pick<PrRow, 'kind' | 'repo' | 'number' | 'lane' | 'workstream' | 'reviewTarget'> & { linkedBy?: LinkedBy | null }>(
  rows: R[], links: StoredLink[],
): R[] {
  const byPr = new Map(links.map(l => [linkKey(l.repo, l.number), l]));
  return rows.map(r => {
    const live: LinkedBy | null = r.workstream ? 'checkout' : null;
    const stored = r.kind === 'pr' && r.repo && r.number != null ? byPr.get(linkKey(r.repo, r.number)) : undefined;
    if (!stored || (live && stored.source !== 'manual')) return live === (r.linkedBy ?? null) ? r : { ...r, linkedBy: live };
    return {
      ...r,
      workstream: stored.workstream,
      linkedBy: stored.source,
      // Review a PR where it was worked on, as for a live link (prPipeline.ts reviewTarget).
      reviewTarget: r.lane === 'needs_my_review' ? stored.workstream : r.reviewTarget,
    };
  });
}

/**
 * The stored links whose PR no lane lists, newest first: what the workstream
 * worked on before. The lanes cover open
 * PRs and 14 days of merges; these are the rest. `listedAt` is when the lanes
 * were read (the memo's fetchedAt): a link stored since then is too new to judge.
 * Ordered by when the link was stored, the only time known for an old PR.
 */
export function earlierLinks(
  rows: Pick<PrRow, 'kind' | 'repo' | 'number'>[], links: StoredLink[], listedAt: string | null, limit = EARLIER_LIMIT,
): EarlierPr[] {
  const listed = new Set(rows.filter(r => r.kind === 'pr' && r.repo && r.number != null).map(r => linkKey(r.repo!, r.number!)));
  return links
    .filter(l => !listed.has(linkKey(l.repo, l.number)))
    // Stored after the lanes were read (a PR the agent just opened): the next read lists it, so it is
    // not "earlier" yet. A hand attach is the user's own, and shows at once.
    .filter(l => l.source === 'manual' || !listedAt || !l.at || l.at < listedAt)
    .slice()
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, limit)
    .map(l => ({ repo: l.repo, number: l.number, workstream: l.workstream, at: l.at ?? null }));
}

export interface AttachInput { repo: string; number: number; projectId: string; workstream: string }

const REPO = /^[\w.-]+\/[\w.-]+$/;

export function parsePrIdent(raw: Record<string, unknown>): { repo: string; number: number } {
  const { repo, number } = raw;
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.length > 200) throw new PrInputError('repo must be owner/name');
  const n = typeof number === 'string' ? Number(number) : number;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999_999_999) throw new PrInputError('number must be a PR number');
  return { repo, number: n };
}

export function parseAttachInput(raw: unknown): AttachInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pr = parsePrIdent(r);
  if (typeof r.projectId !== 'string' || !r.projectId) throw new PrInputError('projectId required');
  if (typeof r.workstream !== 'string' || !r.workstream) throw new PrInputError('workstream required');
  return { ...pr, projectId: r.projectId, workstream: r.workstream };
}

/** The store, injectable so the routes are testable without a database. */
export interface WorkstreamPrStore {
  /** The user's links to live (unarchived) workstreams of their own live projects. */
  list: (userId: string) => Promise<StoredLink[]>;
  /** Records a link unless a stronger one is there (see replaces). False when the workstream is not the user's. */
  record: (userId: string, pr: { repo: string; number: number }, at: { projectId: string; workstream: string }, source: StoredLinkSource) => Promise<boolean>;
  detach: (userId: string, pr: { repo: string; number: number }) => Promise<void>;
}

export const prismaWorkstreamPrs: WorkstreamPrStore = {
  async list(userId) {
    const rows = await prisma.workstreamPr.findMany({
      where: { userId, workstream: { archived: false, project: { userId, archived: false } } },
      select: { repo: true, number: true, source: true, createdAt: true, workstream: { select: { name: true, project: { select: { id: true, name: true } } } } },
    });
    return rows.map(r => ({
      repo: r.repo,
      number: r.number,
      source: r.source as StoredLinkSource,
      at: r.createdAt.toISOString(),
      workstream: { projectId: r.workstream.project.id, projectName: r.workstream.project.name, workstream: r.workstream.name },
    }));
  },
  async record(userId, pr, at, source) {
    const ws = await prisma.workstream.findFirst({
      where: { name: at.workstream, archived: false, project: { id: at.projectId, userId, archived: false } },
      select: { id: true },
    });
    if (!ws) return false;
    const repo = pr.repo.toLowerCase();
    const data = { userId, repo, number: pr.number, workstreamId: ws.id, source };
    if (source === 'manual') {
      // By hand: always the user's choice, whatever was there.
      await prisma.workstreamPr.upsert({
        where: { userId_repo_number: { userId, repo, number: pr.number } },
        create: data,
        update: { workstreamId: ws.id, source },
      });
    } else {
      // First link wins, atomically: INSERT … ON CONFLICT DO NOTHING, so a writer racing this one
      // (the milestone and a pipeline load) can never replace a link that is already there.
      await prisma.workstreamPr.createMany({ data: [data], skipDuplicates: true });
    }
    return true;
  },
  async detach(userId, pr) {
    await prisma.workstreamPr.deleteMany({ where: { userId, repo: pr.repo.toLowerCase(), number: pr.number } });
  },
};

/** Stores the live checkout links the pipeline found, so they outlast the checkout moving on. */
export async function recordCheckoutLinks(userId: string, rows: Pick<PrRow, 'kind' | 'repo' | 'number' | 'workstream'>[], store: WorkstreamPrStore = prismaWorkstreamPrs): Promise<void> {
  for (const r of rows) {
    if (r.kind !== 'pr' || !r.repo || r.number == null || !r.workstream) continue;
    await store.record(userId, { repo: r.repo, number: r.number }, r.workstream, 'branch');
  }
}

/**
 * A PR the session's agent just opened (POST /api/status/milestone,
 * pr_created): stored against the session's workstream. A session that maps
 * to no workstream (a runner session, an unknown pane) records nothing.
 */
export async function recordCreatedLink(
  session: string, instanceId: string | null, url: string | null,
  deps: { resolve?: typeof resolveSessionProject; store?: WorkstreamPrStore } = {},
): Promise<boolean> {
  const pr = parsePrUrl(url);
  if (!pr) return false;
  const resolved = await (deps.resolve ?? resolveSessionProject)(session, instanceId);
  if (!resolved || isAmbiguousSession(resolved) || !resolved.projectId || !resolved.workstream) return false;
  return (deps.store ?? prismaWorkstreamPrs).record(resolved.userId, pr, { projectId: resolved.projectId, workstream: resolved.workstream }, 'created');
}
