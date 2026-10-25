/**
 * PR analytics reads over github_prs. Shared by
 * REST (routes/admin/prs.ts) and MCP (mcp/adminServer.ts).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { distribution, median, WINDOWS, type Basis, type Distribution, type View } from './stats';
import { ingesterStatus, getSettings, rowToGroup, BACKFILL_DAYS } from './ingester';
import { APPROVAL_AGENT_LOGINS, REVIEW_DAYS, REVIEW_PAGE, reviewTrend, reviewWindow, topReviewers, type RPr, type RReview } from './reviews';

/** Who a row counts for, and which rows a view includes. Fixed SQL, never user input. */
function viewSql(view: View): { person: Prisma.Sql; where: Prisma.Sql } {
  if (view === 'humans') return { person: Prisma.sql`"creditedLogin"`, where: Prisma.sql`"authorClass" = 'human'` };
  if (view === 'all') return { person: Prisma.sql`CASE WHEN "authorLogin" = '' THEN 'ghost' ELSE "authorLogin" END`, where: Prisma.sql`TRUE` };
  return { person: Prisma.sql`"creditedLogin"`, where: Prisma.sql`"creditedLogin" IS NOT NULL AND "authorClass" IN ('human', 'agent')` };
}
const dateCol = (basis: Basis) => (basis === 'merged' ? Prisma.sql`"mergedAt"` : Prisma.sql`"createdAt"`);

/**
 * A group's PRs, as a WHERE clause over github_prs: every PR of the repos it
 * takes whole, and the scored PRs (repo_group_prs) of those it takes by path.
 */
export interface GroupScope { slug: string; repos: string[]; whole: string[]; scoped: string[] }

export async function groupRepos(slug: string): Promise<GroupScope | null> {
  const g = await prisma.repoGroup.findUnique({ where: { slug } });
  if (!g) return null;
  const members = await prisma.repoGroupMember.findMany({ where: { groupSlug: slug }, select: { repo: true, scope: true }, orderBy: { repo: 'asc' } });
  return {
    slug,
    repos: members.map(m => m.repo),
    whole: members.filter(m => m.scope == null).map(m => m.repo),
    scoped: members.filter(m => m.scope != null).map(m => m.repo),
  };
}

const inRepos = (g: GroupScope) => {
  const whole = g.whole.length ? Prisma.sql`"repo" IN (${Prisma.join(g.whole)})` : Prisma.sql`FALSE`;
  if (!g.scoped.length) return whole;
  return Prisma.sql`(${whole} OR "id" IN (SELECT "prId" FROM repo_group_prs WHERE "groupSlug" = ${g.slug}))`;
};

export interface WindowSummary {
  days: number;
  /** PRs on the chosen basis, in this view. */
  prs: number;
  opened: number;
  merged: number;
  /** Every author, on the chosen basis: the "with and without bots" split. */
  byClass: { human: number; agent: number; automation: number };
  agentAssisted: number;
  distribution: Distribution;
}

export async function prSummary(slug: string, view: View, basis: Basis, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const windows: WindowSummary[] = [];
  for (const days of WINDOWS) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const [people, classes, both] = await Promise.all([
      prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM github_prs
        WHERE ${inRepos(repos)} AND ${col} >= ${since} AND ${v.where} GROUP BY ${v.person}`,
      prisma.$queryRaw<Array<{ c: string; n: number; assisted: number }>>`
        SELECT "authorClass" AS c, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "agentAssisted")::int AS assisted FROM github_prs
        WHERE ${inRepos(repos)} AND ${col} >= ${since} GROUP BY 1`,
      prisma.$queryRaw<Array<{ opened: number; merged: number }>>`
        SELECT COUNT(*) FILTER (WHERE "createdAt" >= ${since})::int AS opened,
               COUNT(*) FILTER (WHERE "mergedAt" >= ${since})::int AS merged
        FROM github_prs WHERE ${inRepos(repos)} AND ("createdAt" >= ${since} OR "mergedAt" >= ${since}) AND ${v.where}`,
    ]);
    const byClass = { human: 0, agent: 0, automation: 0 };
    let agentAssisted = 0;
    for (const r of classes) { if (r.c in byClass) byClass[r.c as keyof typeof byClass] = Number(r.n); agentAssisted += Number(r.assisted); }
    const counts = people.map(p => Number(p.n));
    windows.push({ days, prs: counts.reduce((s, n) => s + n, 0), opened: Number(both[0]?.opened ?? 0), merged: Number(both[0]?.merged ?? 0), byClass, agentAssisted, distribution: distribution(counts) });
  }
  return { group: slug, view, basis, repos: repos.repos.length, windows, generatedAt: now.toISOString() };
}

/** GitHub login → termag user, from connected GitHub credentials (label '@login'). */
async function termagByLogin(): Promise<Map<string, { userId: string; unixUsername: string }>> {
  const rows = await prisma.userCredential.findMany({ where: { provider: 'github' }, select: { label: true, user: { select: { id: true, unixUsername: true } } } });
  const m = new Map<string, { userId: string; unixUsername: string }>();
  for (const r of rows) if (r.label?.startsWith('@')) m.set(r.label.slice(1).toLowerCase(), { userId: r.user.id, unixUsername: r.user.unixUsername });
  return m;
}

export async function prContributors(slug: string, view: View, basis: Basis, days: number, limit = 10, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ login: string; n: number; agent: number; assisted: number; sizes: number[] }>>`
    SELECT ${v.person} AS login, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE "authorClass" = 'agent')::int AS agent,
           COUNT(*) FILTER (WHERE "agentAssisted")::int AS assisted,
           array_agg(("additions" + "deletions")) AS sizes
    FROM github_prs WHERE ${inRepos(repos)} AND ${col} >= ${since} AND ${v.where}
    GROUP BY 1 ORDER BY n DESC, login ASC`;
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const users = await termagByLogin();
  return {
    group: slug, view, basis, days, total, contributors: rows.length,
    top: rows.slice(0, Math.max(1, Math.min(100, limit))).map(r => ({
      login: r.login, prs: Number(r.n), share: total ? Number(r.n) / total : 0,
      agentPrs: Number(r.agent), agentAssisted: Number(r.assisted), medianSize: median(r.sizes ?? []),
      termag: users.get(r.login) ?? null,
    })),
  };
}

export async function prTrend(slug: string, view: View, basis: Basis, weeks = 26, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ week: Date; human: number; agent: number; automation: number; contributors: number; inview: number }>>`
    SELECT date_trunc('week', ${col} AT TIME ZONE 'UTC') AS week,
           COUNT(*) FILTER (WHERE "authorClass" = 'human')::int AS human,
           COUNT(*) FILTER (WHERE "authorClass" = 'agent')::int AS agent,
           COUNT(*) FILTER (WHERE "authorClass" = 'automation')::int AS automation,
           COUNT(DISTINCT CASE WHEN ${v.where} THEN ${v.person} END)::int AS contributors,
           COUNT(*) FILTER (WHERE ${v.where})::int AS inview
    FROM github_prs WHERE ${inRepos(repos)} AND ${col} >= ${since}
    GROUP BY 1 ORDER BY 1`;
  return {
    group: slug, view, basis, weeks,
    rows: rows.map(r => ({ week: r.week.toISOString().slice(0, 10), human: Number(r.human), agent: Number(r.agent), automation: Number(r.automation), prs: Number(r.inview), contributors: Number(r.contributors) })),
  };
}

/**
 * A group's PRs merged or reviewed since `since`, with every review of them
 * (a deciding approval or a first review can predate the window), and the
 * group's repos where the approval agent has ever approved.
 */
async function reviewData(repos: GroupScope, since: Date): Promise<{ prs: RPr[]; reviews: RReview[]; agentRepos: Set<string> }> {
  const scope = Prisma.sql`${inRepos(repos)} AND ("mergedAt" >= ${since} OR "id" IN (SELECT "prId" FROM github_pr_reviews WHERE "submittedAt" >= ${since}))`;
  const [prRows, reviewRows, agent] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; repo: string; authorLogin: string; creditedLogin: string | null; readyAt: Date | null; createdAt: Date; mergedAt: Date | null; comments: number; humanComments: number; reviewCount: number; reviewsReadAt: Date | null; reviewRequests: unknown }>>`
      SELECT "id", "repo", "authorLogin", "creditedLogin", "readyAt", "createdAt", "mergedAt", "comments", "humanComments", "reviewCount", "reviewsReadAt", "reviewRequests"
      FROM github_prs WHERE ${scope}`,
    prisma.$queryRaw<Array<{ prId: string; reviewerLogin: string; reviewerClass: string; state: string; submittedAt: Date; comments: number }>>`
      SELECT r."prId", r."reviewerLogin", r."reviewerClass", r."state", r."submittedAt", r."comments"
      FROM github_pr_reviews r WHERE r."prId" IN (SELECT "id" FROM github_prs WHERE ${scope})`,
    repos.repos.length ? prisma.$queryRaw<Array<{ repo: string }>>`
      SELECT DISTINCT p."repo" FROM github_pr_reviews r JOIN github_prs p ON p."id" = r."prId"
      WHERE p."repo" IN (${Prisma.join(repos.repos)}) AND r."state" = 'APPROVED' AND r."reviewerClass" <> 'human'
        AND r."reviewerLogin" IN (${Prisma.join(APPROVAL_AGENT_LOGINS)})` : Promise.resolve([]),
  ]);
  return {
    prs: prRows.map(p => ({
      id: p.id, repo: p.repo, author: p.authorLogin, credited: p.creditedLogin, readyAt: p.readyAt, createdAt: p.createdAt, mergedAt: p.mergedAt,
      comments: Number(p.comments), humanComments: Number(p.humanComments), reviewsRead: p.reviewsReadAt != null && Number(p.reviewCount) <= REVIEW_PAGE,
      requests: (Array.isArray(p.reviewRequests) ? p.reviewRequests as Array<{ who?: unknown; at?: unknown }> : [])
        .filter(q => typeof q.who === 'string' && typeof q.at === 'string').map(q => ({ who: q.who as string, at: new Date(q.at as string) })),
    })),
    reviews: reviewRows.map(r => ({ prId: r.prId, login: r.reviewerLogin, cls: r.reviewerClass, state: r.state, submittedAt: r.submittedAt, comments: Number(r.comments) })),
    agentRepos: new Set(agent.map(a => a.repo)),
  };
}

/** Reviews, comments and the approval agent's share for the last 1, 7 and 30 days. */
export async function prReviews(slug: string, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const d = await reviewData(repos, new Date(now.getTime() - Math.max(...WINDOWS) * 86_400_000));
  return {
    group: slug, repos: repos.repos.length, reviewDays: REVIEW_DAYS, approvalAgentLogins: APPROVAL_AGENT_LOGINS,
    windows: WINDOWS.map(days => reviewWindow(d.prs, d.reviews, new Date(now.getTime() - days * 86_400_000), now, d.agentRepos)),
    generatedAt: now.toISOString(),
  };
}

export async function prReviewers(slug: string, days: number, limit = 10, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const since = new Date(now.getTime() - days * 86_400_000);
  const d = await reviewData(repos, since);
  const all = topReviewers(d.prs, d.reviews, since, now);
  const users = await termagByLogin();
  return {
    group: slug, days, reviewers: all.length, reviews: all.reduce((s, r) => s + r.reviews, 0),
    top: all.slice(0, Math.max(1, Math.min(100, limit))).map(r => ({ ...r, termag: users.get(r.login) ?? null })),
  };
}

/** Monday-UTC weeks, the current one partial. */
export async function prReviewTrend(slug: string, weeks: number, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86_400_000;
  const start = new Date(monday - (weeks - 1) * 7 * 86_400_000);
  const d = await reviewData(repos, start);
  return { group: slug, weeks, rows: reviewTrend(d.prs, d.reviews, start, now, d.agentRepos) };
}

export async function prGroups() {
  const [groups, members, prCounts, scopedCounts] = await Promise.all([
    prisma.repoGroup.findMany({ orderBy: [{ sort: 'asc' }, { slug: 'asc' }] }),
    prisma.repoGroupMember.findMany(),
    prisma.$queryRaw<Array<{ repo: string; n: number }>>`SELECT "repo", COUNT(*)::int AS n FROM github_prs GROUP BY 1`,
    prisma.$queryRaw<Array<{ slug: string; repo: string; n: number }>>`
      SELECT g."groupSlug" AS slug, p."repo", COUNT(*)::int AS n FROM repo_group_prs g JOIN github_prs p ON p."id" = g."prId" GROUP BY 1, 2`,
  ]);
  const prs = new Map(prCounts.map(r => [r.repo, Number(r.n)]));
  const scoped = new Map(scopedCounts.map(r => [`${r.slug} ${r.repo}`, Number(r.n)]));
  return groups.map(g => {
    const repos = members.filter(m => m.groupSlug === g.slug);
    return {
      ...rowToGroup(g),
      // A path-scoped repo counts only the PRs scored into the group.
      repos: repos.map(r => ({ repo: r.repo, visibility: r.visibility, scoped: r.scope != null, prs: r.scope != null ? scoped.get(`${g.slug} ${r.repo}`) ?? 0 : prs.get(r.repo) ?? 0 })),
    };
  });
}

export async function prIngestStatus() {
  const settings = await getSettings();
  const owner = settings.tokenUserId ? await prisma.user.findUnique({ where: { id: settings.tokenUserId }, select: { id: true, unixUsername: true } }) : null;
  const repos = [...new Set((await prisma.repoGroupMember.findMany({ select: { repo: true } })).map(r => r.repo))];
  const syncs = await prisma.githubRepoSync.findMany({ where: { repo: { in: repos } } });
  const prs = await prisma.githubPr.count({ where: { repo: { in: repos } } });
  return {
    ingester: ingesterStatus(),
    tokenOwner: owner,
    backfillDays: BACKFILL_DAYS,
    repos: repos.length,
    backfilled: syncs.filter(s => s.backfillDone).length,
    reviewDays: REVIEW_DAYS,
    /** Repos whose stored PRs all carry reviews back to reviewDays (new repos read them with their PRs). */
    reviewsBackfilled: syncs.filter(s => s.backfillDone && s.reviewsDone).length,
    neverRun: repos.length - syncs.length,
    prs,
    lastRunAt: syncs.reduce<Date | null>((m, s) => (s.lastRunAt && (!m || s.lastRunAt > m) ? s.lastRunAt : m), null),
    errors: syncs.filter(s => s.lastError).slice(0, 20).map(s => ({ repo: s.repo, error: s.lastError, at: s.lastRunAt })),
  };
}
