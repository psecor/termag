/**
 * Review groups of the PR overlay: a
 * user's own named, ordered lists of pull requests reviewed together, any PR
 * they add, whatever its author or repository. Shown as one card at the top
 * of Needs you and Needs my review; served alongside GET /api/prs, outside
 * its memo, so an edit shows on the next read.
 *
 * Members are read from GitHub by number (prPipelineGithub fetchPrsByNumber),
 * not found in the lane searches: a member that does not ask for the viewer's
 * review is in no lane. A member is checked off once the viewer has submitted
 * a review and no pending request names them, or once it is merged or closed.
 * A finished member stays in the card until the whole group is done; a group
 * whose members are all merged or closed closes itself. Closed groups are
 * kept CLOSED_KEEP_DAYS, then deleted.
 */

import { prisma } from '../db';
import { PrInputError } from './prReview';
import { authoredLane, mergedRow, openRow, prKey, type PrRow, type WorkstreamLink } from './prPipeline';
import type { NumberedPr } from './prPipelineGithub';

export const MAX_MEMBERS = 20;
export const MAX_OPEN_GROUPS = 10;
export const MAX_NAME = 80;
export const MAX_NOTE = 200;
export const CLOSED_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

const REPO = /^[\w.-]+\/[\w.-]+$/;

export interface MemberInput { repo: string; number: number; note: string | null }

/** A group as stored, members in review order. */
export interface StoredGroup {
  id: string;
  name: string;
  closedAt: string | null;
  createdAt: string;
  members: { repo: string; number: number; position: number; note: string | null; title: string }[];
}

export type MemberState = 'open' | 'merged' | 'closed' | 'missing' | 'unknown';

/** A member as GET /api/prs serves it. */
export interface GroupMember {
  repo: string;
  number: number;
  note: string | null;
  title: string;
  url: string;
  author: string | null;
  /** unknown: GitHub could not be read; missing: no such PR the token can see. */
  state: MemberState;
  /** The viewer's latest submitted review (APPROVED, CHANGES_REQUESTED, COMMENTED), or null. */
  yourReview: string | null;
  /** A pending request names the viewer. */
  askedYou: boolean;
  checked: boolean;
  /** Its lane row when a lane lists it, else one built for the card (`inLane` false); null when unread. */
  row: PrRow | null;
  inLane: boolean;
  /**
   * Where a review of it could run, whatever its lane (routes/prs.ts): its
   * workstream, else `main` of a project on its repository. Review all with
   * Devin's pane can come from any member, merged or yours included, which
   * `row.reviewTarget` (review lanes only) never covers.
   */
  pane?: WorkstreamLink | null;
}

export interface ReviewGroup {
  id: string;
  name: string;
  closedAt: string | null;
  createdAt: string;
  members: GroupMember[];
  /** Every member checked off. */
  done: boolean;
}

// ── Input ────────────────────────────────────────────────────────────────────

export function parseGroupName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new PrInputError('name required');
  if (name.length > MAX_NAME) throw new PrInputError(`name is at most ${MAX_NAME} characters`);
  return name;
}

export function parseMembers(raw: unknown): MemberInput[] {
  if (!Array.isArray(raw)) throw new PrInputError('members must be a list');
  if (raw.length > MAX_MEMBERS) throw new PrInputError(`A group holds at most ${MAX_MEMBERS} pull requests`);
  const seen = new Set<string>();
  return raw.map((m: unknown) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.repo !== 'string' || !REPO.test(r.repo) || r.repo.length > 200) throw new PrInputError('repo must be owner/name');
    const n = r.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999_999_999) throw new PrInputError('number must be a PR number');
    const repo = r.repo.toLowerCase();
    const key = prKey(repo, n);
    if (seen.has(key)) throw new PrInputError(`${key} is in the list twice`);
    seen.add(key);
    let note: string | null = null;
    if (r.note != null) {
      if (typeof r.note !== 'string') throw new PrInputError('note must be text');
      note = r.note.trim().replace(/\s+/g, ' ') || null;
      if (note && note.length > MAX_NOTE) throw new PrInputError(`a note is at most ${MAX_NOTE} characters`);
    }
    return { repo, number: n, note };
  });
}

export function parseCreateInput(raw: unknown): { name: string; members: MemberInput[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { name: parseGroupName(r.name), members: r.members === undefined ? [] : parseMembers(r.members) };
}

export function parsePatchInput(raw: unknown): { name?: string; closed?: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: { name?: string; closed?: boolean } = {};
  if (r.name !== undefined) out.name = parseGroupName(r.name);
  if (r.closed !== undefined) {
    if (typeof r.closed !== 'boolean') throw new PrInputError('closed must be true or false');
    out.closed = r.closed;
  }
  if (out.name === undefined && out.closed === undefined) throw new PrInputError('nothing to change');
  return out;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const memberKey = (repo: string, number: number) => prKey(repo.toLowerCase(), number);
const MERGED_LANES = new Set<string>(['merged_not_deployed', 'deployed', 'merged']);

function rowFor(pr: NumberedPr, viewer: string): PrRow | null {
  if (pr.open) {
    const mine = !!pr.author && pr.author.toLowerCase() === viewer.toLowerCase();
    // Not asked of you, not yours: a team review's row keeps Review with Devin, and the card says why it is there.
    const lane = mine ? authoredLane(pr.open) : pr.open.requestedYou ? 'needs_my_review' : 'team_review';
    const row = openRow(pr.open, lane);
    return mine || pr.open.requestedYou ? row : { ...row, askedYou: false };
  }
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
    return mergedRow({
      repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author,
      headRefName: pr.headRefName, baseRefName: pr.baseRefName, mergedAt: pr.mergedAt ?? pr.closedAt ?? '',
      mergedBy: null, mergeCommit: null, files: [], filesTruncated: true,
    }, null);
  }
  return null;
}

/**
 * The groups as served: each member with its state from GitHub (`fetched`,
 * null when the read failed), its lane row when a lane lists it, and whether
 * it is checked off.
 */
export function assembleGroups(
  groups: StoredGroup[], fetched: Map<string, NumberedPr> | null, laneRows: PrRow[], viewer: string,
): ReviewGroup[] {
  const inLanes = new Map<string, PrRow>();
  for (const r of laneRows) if (r.kind === 'pr' && r.repo && r.number != null) inLanes.set(memberKey(r.repo, r.number), r);
  return groups.map(g => {
    const members = g.members.map((m): GroupMember => {
      const key = memberKey(m.repo, m.number);
      const pr = fetched?.get(key) ?? null;
      const lane = inLanes.get(key) ?? null;
      // GitHub unread: a lane's row still says whether it is open or merged and asks for you (Devin, #667).
      const state: MemberState = !fetched ? (lane ? (MERGED_LANES.has(lane.lane) ? 'merged' : 'open') : 'unknown')
        : !pr || !pr.found ? 'missing'
        : pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
      const askedYou = fetched ? pr?.open?.requestedYou === true : lane?.lane === 'needs_my_review' && lane.askedYou !== false;
      const yourReview = pr?.yourReview?.state ?? null;
      const author = pr?.found ? pr.author : (lane?.author ?? null);
      const yours = !!author && author.toLowerCase() === viewer.toLowerCase();
      // A review the viewer submitted, not re-requested since; or nothing left to review. Your own
      // PR waits on others, so only a merge or close checks it off: a comment you leave on it is not a review of it.
      const checked = state === 'merged' || state === 'closed' || (state === 'open' && !yours && yourReview !== null && !askedYou);
      const row = lane ?? (pr && pr.found ? rowFor(pr, viewer) : null);
      return {
        repo: pr?.found ? pr.repo : m.repo,
        number: m.number,
        note: m.note,
        title: pr?.found ? pr.title : (lane?.title ?? m.title),
        url: pr?.found ? pr.url : (lane?.url ?? `https://github.com/${m.repo}/pull/${m.number}`),
        author,
        state,
        yourReview,
        askedYou,
        checked,
        row,
        inLane: lane !== null,
      };
    });
    return { id: g.id, name: g.name, closedAt: g.closedAt, createdAt: g.createdAt, members, done: members.length > 0 && members.every(m => m.checked) };
  });
}

/** Open groups whose members are all merged or closed: they close themselves. */
export function finishedGroups(groups: ReviewGroup[]): string[] {
  return groups.filter(g => !g.closedAt && g.members.length > 0 && g.members.every(m => m.state === 'merged' || m.state === 'closed')).map(g => g.id);
}

// ── Store ────────────────────────────────────────────────────────────────────

/** The store, injectable so the routes are testable without a database. */
export interface ReviewGroupStore {
  /** Open groups, then closed ones newest first; closed past CLOSED_KEEP_DAYS are deleted on the way. */
  list: (userId: string, now: Date) => Promise<StoredGroup[]>;
  create: (userId: string, name: string, members: (MemberInput & { title: string })[]) => Promise<StoredGroup>;
  /** False when the group is not the user's. */
  update: (userId: string, id: string, patch: { name?: string; closed?: boolean }, now: Date) => Promise<boolean>;
  setMembers: (userId: string, id: string, members: (MemberInput & { title: string })[]) => Promise<boolean>;
  remove: (userId: string, id: string) => Promise<void>;
}

type GroupRow = {
  id: string; name: string; closedAt: Date | null; createdAt: Date;
  members: { repo: string; number: number; position: number; note: string | null; title: string }[];
};

function toStored(g: GroupRow): StoredGroup {
  return {
    id: g.id,
    name: g.name,
    closedAt: g.closedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    members: [...g.members].sort((a, b) => a.position - b.position)
      .map(m => ({ repo: m.repo, number: m.number, position: m.position, note: m.note, title: m.title })),
  };
}

const MEMBER_SELECT = { repo: true, number: true, position: true, note: true, title: true } as const;

/**
 * A PR is in at most one of the user's open groups: writing it into one takes
 * it out of the others (open ones only; a closed group keeps its record).
 */
async function claim(tx: Pick<typeof prisma, 'prReviewGroupMember'>, userId: string, groupId: string, members: MemberInput[]): Promise<void> {
  if (members.length === 0) return;
  await tx.prReviewGroupMember.deleteMany({
    where: {
      group: { userId, closedAt: null, id: { not: groupId } },
      OR: members.map(m => ({ repo: m.repo, number: m.number })),
    },
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * One user's group writes, one at a time (Devin, #667): the open-group cap
 * and the one-open-group-per-PR claim are read-then-write, which READ
 * COMMITTED alone lets two concurrent writes both pass. A transaction-scoped
 * advisory lock on the user serializes them; other users never wait.
 */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pr_review_groups:${userId}`}))`;
}

async function refuseOverCap(tx: Tx, userId: string): Promise<void> {
  const open = await tx.prReviewGroup.count({ where: { userId, closedAt: null } });
  if (open >= MAX_OPEN_GROUPS) throw new PrInputError(`You can have at most ${MAX_OPEN_GROUPS} open groups: close one first`);
}

const memberRows = (groupId: string, members: (MemberInput & { title: string })[]) =>
  members.map((m, i) => ({ groupId, repo: m.repo, number: m.number, position: i, note: m.note, title: m.title }));

export const prismaReviewGroups: ReviewGroupStore = {
  async list(userId, now) {
    const cutoff = new Date(now.getTime() - CLOSED_KEEP_DAYS * DAY_MS);
    await prisma.prReviewGroup.deleteMany({ where: { userId, closedAt: { lt: cutoff } } }).catch(() => undefined);
    const rows = await prisma.prReviewGroup.findMany({
      where: { userId },
      include: { members: { select: MEMBER_SELECT } },
      orderBy: { createdAt: 'asc' },
    });
    const open = rows.filter(g => !g.closedAt);
    const closed = rows.filter(g => g.closedAt).sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime());
    return [...open, ...closed].map(toStored);
  },
  async create(userId, name, members) {
    return prisma.$transaction(async tx => {
      await lockUser(tx, userId);
      await refuseOverCap(tx, userId);
      const g = await tx.prReviewGroup.create({ data: { userId, name } });
      await claim(tx, userId, g.id, members);
      if (members.length) await tx.prReviewGroupMember.createMany({ data: memberRows(g.id, members) });
      const full = await tx.prReviewGroup.findUniqueOrThrow({ where: { id: g.id }, include: { members: { select: MEMBER_SELECT } } });
      return toStored(full);
    });
  },
  async update(userId, id, patch, now) {
    return prisma.$transaction(async tx => {
      await lockUser(tx, userId);
      // Read under the lock: an auto-close between a read and the write would otherwise reopen it without its claim.
      const g = await tx.prReviewGroup.findFirst({ where: { id, userId } });
      if (!g) return false;
      const reopening = patch.closed === false && !!g.closedAt;
      if (reopening) {
        await refuseOverCap(tx, userId);
        // Reopened: its members leave any open group that took them meanwhile.
        const members = await tx.prReviewGroupMember.findMany({ where: { groupId: id }, select: { repo: true, number: true } });
        await claim(tx, userId, id, members.map(m => ({ ...m, note: null })));
      }
      await tx.prReviewGroup.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.closed === undefined ? {} : { closedAt: patch.closed ? (g.closedAt ?? now) : null }),
        },
      });
      return true;
    });
  },
  async setMembers(userId, id, members) {
    return prisma.$transaction(async tx => {
      await lockUser(tx, userId);
      const g = await tx.prReviewGroup.findFirst({ where: { id, userId } });
      if (!g) return false;
      if (!g.closedAt) await claim(tx, userId, id, members);
      await tx.prReviewGroupMember.deleteMany({ where: { groupId: id } });
      if (members.length) await tx.prReviewGroupMember.createMany({ data: memberRows(id, members) });
      return true;
    });
  },
  async remove(userId, id) {
    await prisma.prReviewGroup.deleteMany({ where: { id, userId } });
  },
};
