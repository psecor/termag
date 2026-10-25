/**
 * The PR ingester. Leader-only: started from
 * startLeaderWork() beside the other samplers.
 *
 * Every minute, with the nominated admin's stored gh token:
 *   1. checks the nominee still has a GitHub token and is still an admin;
 *   2. every 6 h, or right after a group edit, resolves the repo groups to
 *      repos (repo_group_members);
 *   3. spends a page budget on the grouped repos: due incremental passes
 *      (15 min apart, one search per owner, per-repo head passes only when
 *      the search has more hits than it returns) first, then the first pass
 *      of repos still backfilling, then the review pass of repos whose PRs
 *      were stored before reviews were read (REVIEW_DAYS of them).
 * Stops until the reset when the token's rate limit falls under the reserve
 * kept for the owner's own use, or GitHub refuses for the rate limit. The
 * owner's PR pipeline, agents and gh calls share that one hourly budget.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { readGithubAccess } from '../credentialStore';
import { isAdminUser } from '../admin/adminAccess';
import { classifyPr, bodyWindow, DEFAULT_AGENT_LOGINS, DEFAULT_BOT_LOGINS, type ClassifyLists } from './classify';
import { SEED_GROUPS, resolveGroup, orgsToList, scopeKey, scorePr, type GroupDef, type GroupMember, type PathScope, type RepoInfo } from './groups';
import { syncRepo, searchSync, pauseBelow, type PrNode, type RateLimit, type SyncState } from './sync';
import { fetchPrPage, isRateLimited, listOrgRepos, listTopicRepos, searchPrPage } from './github';
import { REVIEW_DAYS, reviewFields, reviewRows } from './reviews';

const TICK_MS = 60_000;
const DISCOVERY_MS = 6 * 3600_000;
const INCREMENTAL_MS = 15 * 60_000;
const RESERVE = Number(process.env.PR_ANALYTICS_RATE_RESERVE ?? 0.6);
// Each search re-reads this much before the last one, for search's index lag.
const SEARCH_OVERLAP_MS = 10 * 60_000;
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

// Seeded before seededGroups existed: groupsSeeded alone recorded these.
const FIRST_SEEDS = ['termag'];
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Create each seed group once, by slug: a new one appears, a deleted one stays deleted. */
async function ensureSeeded(): Promise<void> {
  const s = await getSettings();
  const seeded = new Set(strings(s.seededGroups));
  if (s.groupsSeeded && seeded.size === 0) FIRST_SEEDS.forEach(x => seeded.add(x));
  const missing = SEED_GROUPS.filter(g => !seeded.has(g.slug));
  if (!missing.length && s.groupsSeeded && strings(s.seededGroups).length === seeded.size) return;
  for (const g of missing) {
    await prisma.repoGroup.upsert({ where: { slug: g.slug }, create: { slug: g.slug, name: g.name, members: g.members as object[], excluded: g.excluded, sort: g.sort }, update: {} });
    seeded.add(g.slug);
  }
  await prisma.prAnalyticsSettings.update({ where: { id: SETTINGS_ID }, data: { groupsSeeded: true, seededGroups: [...seeded] } });
  if (missing.length) discoveryDue = true;
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
  const rescore = new Set<string>();
  for (const g of groups) {
    const resolved = resolveGroup(g, known, topics).map(r => ({ ...r, visibility: r.visibility || syncVis.get(r.repo) || '' }));
    const before = new Map((await prisma.repoGroupMember.findMany({ where: { groupSlug: g.slug } })).map(m => [m.repo, scopeKey(m.scope)]));
    const after = new Map(resolved.map(r => [r.repo, scopeKey(r.scope)]));
    // A repo whose scope in this group changed (or that stopped being scoped):
    // its scored rows go, and a scoped one is read again from the start, since
    // stored PRs keep no file lists to score anew.
    for (const repo of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(repo) ?? null; const now = after.get(repo) ?? null;
      if (was === now) continue;
      if (was) await prisma.$executeRaw`DELETE FROM repo_group_prs WHERE "groupSlug" = ${g.slug} AND "prId" IN (SELECT "id" FROM github_prs WHERE "repo" = ${repo})`;
      if (now) rescore.add(repo);
    }
    await prisma.$transaction([
      prisma.repoGroupMember.deleteMany({ where: { groupSlug: g.slug } }),
      prisma.repoGroupMember.createMany({ data: resolved.map(r => ({ groupSlug: g.slug, repo: r.repo, visibility: r.visibility, scope: r.scope ? (r.scope as unknown as Prisma.InputJsonValue) : Prisma.DbNull })) }),
    ]);
  }
  if (rescore.size) {
    // The re-read stores reviews too, so no review pass follows it.
    await prisma.githubRepoSync.updateMany({ where: { repo: { in: [...rescore] } }, data: { backfillDone: false, backfillCursor: null, backfillTop: null, reviewsDone: true, reviewsCursor: null, reviewsTop: null } });
    console.log(`[PR-INGEST] re-reading ${[...rescore].join(', ')} to score PRs for path-scoped groups`);
  }
  const slugs = groups.map(g => g.slug);
  await prisma.repoGroupMember.deleteMany({ where: { groupSlug: { notIn: slugs } } });
  await prisma.repoGroupPr.deleteMany({ where: { groupSlug: { notIn: slugs } } });
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
    ...(reviewFields(n, lists) ?? {}),
  };
}

async function syncOne(token: string, repo: string, maxPages: number, lists: ClassifyLists): Promise<{ pages: number; paused: boolean }> {
  // A repo first read now gets its reviews with its PRs, so it needs no review pass.
  const row = await prisma.githubRepoSync.upsert({ where: { repo }, create: { repo, reviewsDone: true }, update: {} });
  const state: SyncState = { backfillCursor: row.backfillCursor, backfillTop: row.backfillTop, backfillDone: row.backfillDone, highWater: row.highWater };
  const horizon = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  try {
    const r = await syncRepo(state, horizon, maxPages, {
      fetchPage: async after => { const p = await fetchPrPage(token, repo, after); status.rate = p.rateLimit; return p; },
      write: (nodes, visibility) => writeNodes(repo, nodes, visibility, lists),
      shouldPause: pauseBelow(RESERVE),
    });
    await prisma.githubRepoSync.update({ where: { repo }, data: { ...r.state, visibility: r.visibility ?? row.visibility, lastRunAt: new Date(), lastError: null } });
    return { pages: r.pages, paused: r.paused };
  } catch (err) {
    await prisma.githubRepoSync.update({ where: { repo }, data: { lastRunAt: new Date(), lastError: (err as Error).message.slice(0, 300) } });
    return { pages: 1, paused: isRateLimited(err) };
  }
}

/**
 * The review pass: syncRepo's first pass again, with its own cursor, down to
 * PRs updated in the last REVIEW_DAYS, so rows stored before reviews were read
 * get them. lastRunAt is left to the PR passes, whose due times it sets.
 */
async function syncReviews(token: string, repo: string, maxPages: number, lists: ClassifyLists): Promise<{ pages: number; paused: boolean }> {
  const row = await prisma.githubRepoSync.findUnique({ where: { repo } });
  if (!row) return { pages: 0, paused: false };
  const state: SyncState = { backfillCursor: row.reviewsCursor, backfillTop: row.reviewsTop, backfillDone: false, highWater: null };
  try {
    const r = await syncRepo(state, new Date(Date.now() - REVIEW_DAYS * 86_400_000), maxPages, {
      fetchPage: async after => { const p = await fetchPrPage(token, repo, after); status.rate = p.rateLimit; return p; },
      write: (nodes, visibility) => writeNodes(repo, nodes, visibility, lists),
      shouldPause: pauseBelow(RESERVE),
    });
    await prisma.githubRepoSync.update({ where: { repo }, data: { reviewsCursor: r.state.backfillCursor, reviewsTop: r.state.backfillTop, reviewsDone: r.state.backfillDone, lastError: null } });
    return { pages: r.pages, paused: r.paused };
  } catch (err) {
    await prisma.githubRepoSync.update({ where: { repo }, data: { lastError: `reviews: ${(err as Error).message}`.slice(0, 300) } });
    return { pages: 1, paused: isRateLimited(err) };
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
  const pause = () => {
    status.state = 'rate-limited';
    const reset = status.rate?.resetAt ? Date.parse(status.rate.resetAt) : NaN;
    status.pausedUntil = new Date(reset > now ? reset : now + 15 * 60_000).toISOString();
  };
  // Incremental: one search per owner whose repos are due. An owner whose
  // search has more hits than search returns (a long outage), or whose search
  // fails for another reason (an owner that is a user, not an org), gets the
  // per-repo head passes instead, which catch up and move its marks.
  const perRepo: string[] = [];
  for (const [owner, names] of byOwner(due)) {
    if (budget <= 0) break;
    const done = repos.filter(r => r.startsWith(`${owner}/`) && syncs.get(r)?.backfillDone);
    const r = await searchOne(access.token, owner, done, syncs, Math.min(budget, 20), lists, now);
    budget -= r.pages;
    if (r.paused) { pause(); return; }
    if (r.fallback) perRepo.push(...names);
  }
  for (const repo of [...perRepo, ...backfilling]) {
    if (budget <= 0) break;
    const r = await syncOne(access.token, repo, Math.min(budget, perRepo.includes(repo) ? 20 : 5), lists);
    budget -= r.pages;
    if (r.paused) { pause(); return; }
  }
  for (const repo of repos.filter(r => syncs.get(r)?.backfillDone && !syncs.get(r)?.reviewsDone)) {
    if (budget <= 0) break;
    const r = await syncReviews(access.token, repo, Math.min(budget, 5), lists);
    budget -= r.pages;
    if (r.paused) { pause(); return; }
  }
}

function byOwner(repos: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of repos) { const o = r.split('/')[0]; m.set(o, [...(m.get(o) ?? []), r]); }
  return m;
}

type SyncRow = { highWater: Date | null; backfillDone: boolean };

/**
 * An owner's search cut short by the page budget or the rate limit: the next
 * tick continues it from the cursor, with the same query, instead of starting
 * over (a quarter-hour of 501 to 1,000 hits would otherwise never finish).
 * In memory: a restart starts the search again, which only re-reads.
 */
const searches = new Map<string, { since: Date; startedAt: number; after: string }>();

/**
 * One owner's incremental pass by search (sync.ts searchSync), from the
 * oldest mark among its caught-up repos less the overlap. A complete search
 * moves every one of them to the time it started; a cut-short one moves
 * nothing and is repeated next tick.
 */
async function searchOne(token: string, owner: string, done: string[], syncs: Map<string, SyncRow>, maxPages: number, lists: ClassifyLists, now: number): Promise<{ pages: number; paused: boolean; fallback: boolean }> {
  const resume = searches.get(owner);
  const marks = done.map(r => syncs.get(r)?.highWater?.getTime() ?? now - BACKFILL_DAYS * 86_400_000);
  const since = resume?.since ?? new Date(Math.min(...marks) - SEARCH_OVERLAP_MS);
  const startedAt = resume?.startedAt ?? now;
  const covered = new Set(done);
  searches.delete(owner);
  try {
    const r = await searchSync(maxPages, {
      fetchPage: async after => { const p = await searchPrPage(token, owner, since, after); status.rate = p.rateLimit; return p; },
      include: repo => covered.has(repo),
      write: (repo, nodes, visibility) => writeNodes(repo, nodes, visibility, lists),
      shouldPause: pauseBelow(RESERVE),
    }, resume?.after ?? null);
    if (r.complete) {
      // Everything updated before the search began is in; it re-reads the overlap next time.
      await prisma.githubRepoSync.updateMany({ where: { repo: { in: done } }, data: { highWater: new Date(startedAt), lastRunAt: new Date(), lastError: null } });
    } else if (r.cursor) {
      // Cut short: the repos stay due, and the next tick continues from here.
      searches.set(owner, { since, startedAt, after: r.cursor });
    }
    return { pages: r.pages, paused: r.paused, fallback: r.overCap };
  } catch (err) {
    // lastRunAt is left alone: the per-repo fallback stamps each repo it
    // reaches, and those it does not reach this tick stay due for the next.
    await prisma.githubRepoSync.updateMany({ where: { repo: { in: done } }, data: { lastError: `search: ${(err as Error).message}`.slice(0, 300) } });
    const paused = isRateLimited(err);
    return { pages: 1, paused, fallback: !paused };
  }
}

/** Upsert a page of one repo's PRs with their reviews, and score them for the groups that take the repo by path. */
async function writeNodes(repo: string, nodes: PrNode[], visibility: string, lists: ClassifyLists): Promise<void> {
  const scoped = await prisma.repoGroupMember.findMany({ where: { repo, scope: { not: Prisma.DbNull } }, select: { groupSlug: true, scope: true } });
  await prisma.$transaction(nodes.flatMap(n => {
    const data = toRow(n, repo, visibility, lists);
    const files = (n.files?.nodes ?? []).map(f => f.path);
    const reviews = n.reviews ? reviewRows(n, lists) : null;
    return [
      prisma.githubPr.upsert({ where: { id: n.id }, create: { id: n.id, ...data }, update: data }),
      // A PR's reviews are replaced whole: GitHub's list is the truth, dismissals and deletions included.
      ...(reviews ? [
        prisma.githubPrReview.deleteMany({ where: { prId: n.id } }),
        prisma.githubPrReview.createMany({ data: reviews.map(r => ({ ...r, prId: n.id })), skipDuplicates: true }),
      ] : []),
      ...scoped.map(m => {
        const { matched, inGroup } = scorePr(m.scope as unknown as PathScope, files, n.title ?? '');
        const key = { groupSlug_prId: { groupSlug: m.groupSlug, prId: n.id } };
        return inGroup
          ? prisma.repoGroupPr.upsert({ where: key, create: { groupSlug: m.groupSlug, prId: n.id, matchedFiles: matched }, update: { matchedFiles: matched, scoredAt: new Date() } })
          : prisma.repoGroupPr.deleteMany({ where: { groupSlug: m.groupSlug, prId: n.id } });
      }),
    ];
  }));
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
