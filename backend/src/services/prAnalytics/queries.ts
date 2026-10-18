/**
 * PR analytics reads over github_prs. Shared by
 * REST (routes/admin/prs.ts) and MCP (mcp/adminServer.ts).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { distribution, median, WINDOWS, type Basis, type Distribution, type View } from './stats';
import { ingesterStatus, getSettings, rowToGroup, BACKFILL_DAYS } from './ingester';

/** Who a row counts for, and which rows a view includes. Fixed SQL, never user input. */
function viewSql(view: View): { person: Prisma.Sql; where: Prisma.Sql } {
  if (view === 'humans') return { person: Prisma.sql`"creditedLogin"`, where: Prisma.sql`"authorClass" = 'human'` };
  if (view === 'all') return { person: Prisma.sql`CASE WHEN "authorLogin" = '' THEN 'ghost' ELSE "authorLogin" END`, where: Prisma.sql`TRUE` };
  return { person: Prisma.sql`"creditedLogin"`, where: Prisma.sql`"creditedLogin" IS NOT NULL AND "authorClass" IN ('human', 'agent')` };
}
const dateCol = (basis: Basis) => (basis === 'merged' ? Prisma.sql`"mergedAt"` : Prisma.sql`"createdAt"`);

export async function groupRepos(slug: string): Promise<string[] | null> {
  const g = await prisma.repoGroup.findUnique({ where: { slug } });
  if (!g) return null;
  return (await prisma.repoGroupMember.findMany({ where: { groupSlug: slug }, select: { repo: true }, orderBy: { repo: 'asc' } })).map(r => r.repo);
}

const inRepos = (repos: string[]) => (repos.length ? Prisma.sql`"repo" IN (${Prisma.join(repos)})` : Prisma.sql`FALSE`);

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
  return { group: slug, view, basis, repos: repos.length, windows, generatedAt: now.toISOString() };
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

export async function prGroups() {
  const [groups, members, prCounts] = await Promise.all([
    prisma.repoGroup.findMany({ orderBy: [{ sort: 'asc' }, { slug: 'asc' }] }),
    prisma.repoGroupMember.findMany(),
    prisma.$queryRaw<Array<{ repo: string; n: number }>>`SELECT "repo", COUNT(*)::int AS n FROM github_prs GROUP BY 1`,
  ]);
  const prs = new Map(prCounts.map(r => [r.repo, Number(r.n)]));
  return groups.map(g => {
    const repos = members.filter(m => m.groupSlug === g.slug);
    return { ...rowToGroup(g), repos: repos.map(r => ({ repo: r.repo, visibility: r.visibility, prs: prs.get(r.repo) ?? 0 })) };
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
    neverRun: repos.length - syncs.length,
    prs,
    lastRunAt: syncs.reduce<Date | null>((m, s) => (s.lastRunAt && (!m || s.lastRunAt > m) ? s.lastRunAt : m), null),
    errors: syncs.filter(s => s.lastError).slice(0, 20).map(s => ({ repo: s.repo, error: s.lastError, at: s.lastRunAt })),
  };
}
