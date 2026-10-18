/**
 * The PR ingester. Leader-only: started from
 * startLeaderWork() beside the other samplers.
 *
 * Every minute, with the nominated admin's stored gh token:
 *   1. checks the nominee still has a GitHub token and is still an admin;
 *   2. every 6 h, or right after a group edit, resolves the repo groups to
 *      repos (repo_group_members);
 *   3. spends a page budget on the grouped repos: due incremental passes
 *      (15 min apart) first, then the first pass of repos still backfilling.
 * Stops for the hour when the token's rate limit falls under the reserve kept
 * for the owner's own use.
 */
import { prisma } from '../../db';
import { readGithubAccess } from '../credentialStore';
import { isAdminUser } from '../admin/adminAccess';
import { classifyPr, bodyWindow, DEFAULT_AGENT_LOGINS, DEFAULT_BOT_LOGINS, type ClassifyLists } from './classify';
import { SEED_GROUPS, resolveGroup, orgsToList, type GroupDef, type GroupMember, type RepoInfo } from './groups';
import { syncRepo, pauseBelow, type PrNode, type RateLimit, type SyncState } from './sync';
import { fetchPrPage, listOrgRepos, listTopicRepos } from './github';

const TICK_MS = 60_000;
const DISCOVERY_MS = 6 * 3600_000;
const INCREMENTAL_MS = 15 * 60_000;
const RESERVE = Number(process.env.PR_ANALYTICS_RATE_RESERVE ?? 0.4);
const PAGES_PER_TICK = Number(process.env.PR_ANALYTICS_PAGES_PER_MINUTE ?? 10);
export const BACKFILL_DAYS = Number(process.env.PR_ANALYTICS_BACKFILL_DAYS ?? 548);
const SETTINGS_ID = 'settings';

export type IngestState = 'idle' | 'no-token-owner' | 'owner-not-admin' | 'owner-has-no-github' | 'rate-limited' | 'running' | 'error';

const status = {
  state: 'idle' as IngestState,
  lastTickAt: null as string | null,
  lastDiscoveryAt: null as string | null,
  lastError: null as string | null,
  pausedUntil: null as string | null,
  rate: null as RateLimit | null,
};
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let discoveryDue = true;

export function ingesterStatus() { return { ...status, rate: status.rate ? { ...status.rate } : null }; }
/** A group changed: resolve groups on the next tick. */
export function markGroupsChanged(): void { discoveryDue = true; }

export async function getSettings() {
  return prisma.prAnalyticsSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
}

export async function classifyLists(): Promise<ClassifyLists> {
  const s = await getSettings();
  const extra = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { agentLogins: [...DEFAULT_AGENT_LOGINS, ...extra(s.agentLogins)], botLogins: [...DEFAULT_BOT_LOGINS, ...extra(s.botLogins)] };
}

export function rowToGroup(r: { slug: string; name: string; members: unknown; excluded: unknown; sort: number }): GroupDef {
  return {
    slug: r.slug, name: r.name, sort: r.sort,
    members: Array.isArray(r.members) ? r.members as GroupMember[] : [],
    excluded: Array.isArray(r.excluded) ? (r.excluded as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

async function ensureSeeded(): Promise<void> {
  const s = await getSettings();
  if (s.groupsSeeded) return;
  for (const g of SEED_GROUPS) {
    await prisma.repoGroup.upsert({ where: { slug: g.slug }, create: { slug: g.slug, name: g.name, members: g.members as object[], excluded: g.excluded, sort: g.sort }, update: {} });
  }
  await prisma.prAnalyticsSettings.update({ where: { id: SETTINGS_ID }, data: { groupsSeeded: true } });
}

async function discover(token: string): Promise<void> {
  const groups = (await prisma.repoGroup.findMany()).map(rowToGroup);
  const known: RepoInfo[] = [];
  for (const org of orgsToList(groups.filter(g => g.members.some(m => m.kind === 'pattern')))) {
    const r = await listOrgRepos(token, org); known.push(...r.repos); if (r.rateLimit) status.rate = r.rateLimit;
  }
  const topics = new Map<string, string[]>();
  for (const g of groups) for (const m of g.members) {
    if (m.kind !== 'topic') continue;
    const key = `${m.org ?? 'example-org'}:${m.value}`;
    if (topics.has(key)) continue;
    const r = await listTopicRepos(token, m.org ?? 'example-org', m.value);
    topics.set(key, r.repos.map(x => x.repo));
    for (const x of r.repos) if (!known.some(k => k.repo === x.repo)) known.push(x);
    if (r.rateLimit) status.rate = r.rateLimit;
  }
  const syncVis = new Map((await prisma.githubRepoSync.findMany({ select: { repo: true, visibility: true } })).map(r => [r.repo, r.visibility]));
  for (const g of groups) {
    const resolved = resolveGroup(g, known, topics).map(r => ({ ...r, visibility: r.visibility || syncVis.get(r.repo) || '' }));
    await prisma.$transaction([
      prisma.repoGroupMember.deleteMany({ where: { groupSlug: g.slug } }),
      prisma.repoGroupMember.createMany({ data: resolved.map(r => ({ groupSlug: g.slug, repo: r.repo, visibility: r.visibility })) }),
    ]);
  }
  await prisma.repoGroupMember.deleteMany({ where: { groupSlug: { notIn: groups.map(g => g.slug) } } });
  status.lastDiscoveryAt = new Date().toISOString();
}

function toRow(n: PrNode, repo: string, visibility: string, lists: ClassifyLists) {
  const authorLogin = (n.author?.login ?? '').toLowerCase();
  const c = classifyPr({
    authorLogin, authorType: n.author?.__typename ?? '', body: bodyWindow(n.body),
    commits: n.commits.nodes.map(x => ({ messageBody: x.commit.messageBody ?? '', authorLogins: x.commit.authors.nodes.map(a => a.user?.login ?? '').filter(Boolean) })),
  }, lists);
  return {
    repo, repoVisibility: visibility, number: n.number, authorLogin, authorType: n.author?.__typename ?? '',
    authorClass: c.authorClass, creditedLogin: c.creditedLogin, creditSource: c.creditSource, agentAssisted: c.agentAssisted,
    state: n.state, isDraft: n.isDraft, baseRef: n.baseRefName ?? '',
    additions: n.additions ?? 0, deletions: n.deletions ?? 0, changedFiles: n.changedFiles ?? 0,
    createdAt: new Date(n.createdAt), mergedAt: n.mergedAt ? new Date(n.mergedAt) : null, closedAt: n.closedAt ? new Date(n.closedAt) : null,
    prUpdatedAt: new Date(n.updatedAt),
  };
}

async function syncOne(token: string, repo: string, maxPages: number, lists: ClassifyLists): Promise<{ pages: number; paused: boolean }> {
  const row = await prisma.githubRepoSync.upsert({ where: { repo }, create: { repo }, update: {} });
  const state: SyncState = { backfillCursor: row.backfillCursor, backfillTop: row.backfillTop, backfillDone: row.backfillDone, highWater: row.highWater };
  const horizon = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  try {
    const r = await syncRepo(state, horizon, maxPages, {
      fetchPage: async after => { const p = await fetchPrPage(token, repo, after); status.rate = p.rateLimit; return p; },
      write: async (nodes, visibility) => {
        await prisma.$transaction(nodes.map(n => {
          const data = toRow(n, repo, visibility, lists);
          return prisma.githubPr.upsert({ where: { id: n.id }, create: { id: n.id, ...data }, update: data });
        }));
      },
      shouldPause: pauseBelow(RESERVE),
    });
    await prisma.githubRepoSync.update({ where: { repo }, data: { ...r.state, visibility: r.visibility ?? row.visibility, lastRunAt: new Date(), lastError: null } });
    return { pages: r.pages, paused: r.paused };
  } catch (err) {
    await prisma.githubRepoSync.update({ where: { repo }, data: { lastRunAt: new Date(), lastError: (err as Error).message.slice(0, 300) } });
    return { pages: 1, paused: false };
  }
}

export async function tick(now = Date.now()): Promise<void> {
  status.lastTickAt = new Date(now).toISOString();
  if (status.pausedUntil && Date.parse(status.pausedUntil) > now) { status.state = 'rate-limited'; return; }
  status.pausedUntil = null;
  const settings = await getSettings();
  if (!settings.tokenUserId) { status.state = 'no-token-owner'; return; }
  const owner = await prisma.user.findUnique({ where: { id: settings.tokenUserId } });
  if (!owner || !isAdminUser(owner)) { status.state = 'owner-not-admin'; return; }
  const access = await readGithubAccess(owner.id);
  if (!access) { status.state = 'owner-has-no-github'; return; }
  status.state = 'running';
  await ensureSeeded();
  if (discoveryDue || !status.lastDiscoveryAt || now - Date.parse(status.lastDiscoveryAt) > DISCOVERY_MS) {
    discoveryDue = false;
    await discover(access.token);
  }
  const lists = await classifyLists();
  const repos = [...new Set((await prisma.repoGroupMember.findMany({ select: { repo: true } })).map(r => r.repo))];
  const syncs = new Map((await prisma.githubRepoSync.findMany({ where: { repo: { in: repos } } })).map(s => [s.repo, s]));
  const due = repos.filter(r => { const s = syncs.get(r); return s?.backfillDone && (!s.lastRunAt || now - s.lastRunAt.getTime() > INCREMENTAL_MS); });
  const backfilling = repos.filter(r => !syncs.get(r)?.backfillDone)
    .sort((a, b) => (syncs.get(a)?.lastRunAt?.getTime() ?? 0) - (syncs.get(b)?.lastRunAt?.getTime() ?? 0));
  let budget = PAGES_PER_TICK;
  for (const repo of [...due, ...backfilling]) {
    if (budget <= 0) break;
    const r = await syncOne(access.token, repo, Math.min(budget, due.includes(repo) ? 20 : 5), lists);
    budget -= r.pages;
    if (r.paused) { status.state = 'rate-limited'; status.pausedUntil = status.rate?.resetAt ?? new Date(now + 3600_000).toISOString(); break; }
  }
}

function runTick(): void {
  if (running) return;
  running = tick().then(() => { status.lastError = null; }).catch(err => {
    status.state = 'error'; status.lastError = (err as Error).message.slice(0, 300);
    console.error('[PR-INGEST] tick failed:', status.lastError);
  }).finally(() => { running = null; });
}

/** Run a tick now (after nominating a token or editing a group). */
export function kickIngester(): void { discoveryDue = true; runTick(); }

export function startPrIngester(): void {
  if (timer) return;
  timer = setInterval(runTick, TICK_MS);
  timer.unref();
  setTimeout(runTick, 5_000).unref();
}

export async function stopPrIngester(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  if (running) await running;
}
