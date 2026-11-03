/**
 * PR analytics reads over github_prs. Shared by
 * REST (routes/admin/prs.ts) and MCP (mcp/adminServer.ts).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { distribution, median, WINDOWS, type Basis, type Distribution, type View } from './stats';
import { ingesterStatus, getSettings, rowToGroup, BACKFILL_DAYS } from './ingester';
import { ALL_REVIEWER_CLASSES, APPROVAL_AGENT_LOGINS, REVIEW_DAYS, REVIEW_PAGE, reviewTrend, reviewWindow, teamReviewTrend, topReviewers, type Reviewer, type RPr, type RReview } from './reviews';
import { descendantKeys, teamLogins, type StoredMembership, type TeamScope } from './teams';

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

/** The pseudo-group for every ingested repo: a team view that spans them all. */
export const ALL_REPOS = '*';
const ALL_SCOPE: GroupScope = { slug: ALL_REPOS, repos: [], whole: [], scoped: [] };

export async function groupRepos(slug: string): Promise<GroupScope | null> {
  if (slug === ALL_REPOS) return ALL_SCOPE;
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
  if (g.slug === ALL_REPOS) return Prisma.sql`TRUE`;
  const whole = g.whole.length ? Prisma.sql`"repo" IN (${Prisma.join(g.whole)})` : Prisma.sql`FALSE`;
  if (!g.scoped.length) return whole;
  return Prisma.sql`(${whole} OR "id" IN (SELECT "prId" FROM repo_group_prs WHERE "groupSlug" = ${g.slug}))`;
};

/**
 * A team's whole membership history, so a query can resolve the roster for each
 * window (and each week of a trend) rather than one flat roster
 * (Attribution). `loadTeamRoster` reads it once.
 */
export interface TeamRoster {
  key: string;
  teams: Array<{ key: string; parent: string | null }>;
  intervals: StoredMembership[];
}

/** The logins on a roster's team (and its descendants) during [since, until). */
export function rosterIn(roster: TeamRoster, since: Date, until: Date): string[] {
  return teamLogins(roster.teams, roster.intervals, roster.key, since, until);
}

/** Load a team and its memberships once; null when there is no such team. */
export async function loadTeamRoster(key: string): Promise<TeamRoster | null> {
  const teams = await prisma.team.findMany({ select: { key: true, parent: true } });
  if (!teams.some(t => t.key === key)) return null;
  const keys = descendantKeys(teams, key);
  const rows = await prisma.teamMembership.findMany({
    where: { teamKey: { in: keys } },
    select: { teamKey: true, login: true, name: true, email: true, start: true, end: true, openStart: true, source: true },
  });
  const intervals: StoredMembership[] = rows.map(r => ({ ...r, source: r.source === 'manual' ? 'manual' : 'synced' }));
  return { key, teams, intervals };
}

/**
 * A team predicate over the view's person column, for one window's logins. An
 * empty roster matches nothing, not everything, so a team with no one on it in
 * the window reads as zero.
 */
const inTeam = (v: ReturnType<typeof viewSql>, logins?: readonly string[]) => {
  if (!logins) return Prisma.empty;
  if (!logins.length) return Prisma.sql` AND FALSE`;
  return Prisma.sql` AND ${v.person} IN (${Prisma.join(logins)})`;
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

/** The repo count a view reports: a group's repos, or the distinct repos a team touched in a window. */
async function scopedRepoCount(scope: GroupScope, since: Date, col: Prisma.Sql, v: ReturnType<typeof viewSql>, logins?: readonly string[]): Promise<number> {
  if (scope.slug !== ALL_REPOS) return scope.repos.length;
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(DISTINCT "repo")::int AS n FROM github_prs
    WHERE ${inRepos(scope)} AND ${col} >= ${since} AND ${v.where}${inTeam(v, logins)}`;
  return Number(rows[0]?.n ?? 0);
}

export async function prSummary(slug: string, view: View, basis: Basis, now = new Date(), team?: TeamRoster) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const windows: WindowSummary[] = [];
  for (const days of WINDOWS) {
    const since = new Date(now.getTime() - days * 86_400_000);
    // The roster as of this window, not one flat roster for all three.
    const logins = team ? rosterIn(team, since, now) : undefined;
    const [people, classes, both] = await Promise.all([
      prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM github_prs
        WHERE ${inRepos(repos)} AND ${col} >= ${since} AND ${v.where}${inTeam(v, logins)} GROUP BY ${v.person}`,
      prisma.$queryRaw<Array<{ c: string; n: number; assisted: number }>>`
        SELECT "authorClass" AS c, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "agentAssisted")::int AS assisted FROM github_prs
        WHERE ${inRepos(repos)} AND ${col} >= ${since}${inTeam(v, logins)} GROUP BY 1`,
      prisma.$queryRaw<Array<{ opened: number; merged: number }>>`
        SELECT COUNT(*) FILTER (WHERE "createdAt" >= ${since})::int AS opened,
               COUNT(*) FILTER (WHERE "mergedAt" >= ${since})::int AS merged
        FROM github_prs WHERE ${inRepos(repos)} AND ("createdAt" >= ${since} OR "mergedAt" >= ${since}) AND ${v.where}${inTeam(v, logins)}`,
    ]);
    const byClass = { human: 0, agent: 0, automation: 0 };
    let agentAssisted = 0;
    for (const r of classes) { if (r.c in byClass) byClass[r.c as keyof typeof byClass] = Number(r.n); agentAssisted += Number(r.assisted); }
    const counts = people.map(p => Number(p.n));
    windows.push({ days, prs: counts.reduce((s, n) => s + n, 0), opened: Number(both[0]?.opened ?? 0), merged: Number(both[0]?.merged ?? 0), byClass, agentAssisted, distribution: distribution(counts) });
  }
  const since = new Date(now.getTime() - Math.max(...WINDOWS) * 86_400_000);
  return {
    group: slug, view, basis,
    repos: await scopedRepoCount(repos, since, col, v, team ? rosterIn(team, since, now) : undefined),
    windows, generatedAt: now.toISOString(),
  };
}

/** GitHub login → termag user, from connected GitHub credentials (label '@login'). */
async function termagByLogin(): Promise<Map<string, { userId: string; unixUsername: string }>> {
  const rows = await prisma.userCredential.findMany({ where: { provider: 'github' }, select: { label: true, user: { select: { id: true, unixUsername: true } } } });
  const m = new Map<string, { userId: string; unixUsername: string }>();
  for (const r of rows) if (r.label?.startsWith('@')) m.set(r.label.slice(1).toLowerCase(), { userId: r.user.id, unixUsername: r.user.unixUsername });
  return m;
}

export async function prContributors(slug: string, view: View, basis: Basis, days: number, limit = 10, now = new Date(), team?: TeamRoster) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const since = new Date(now.getTime() - days * 86_400_000);
  const logins = team ? rosterIn(team, since, now) : undefined;
  const rows = await prisma.$queryRaw<Array<{ login: string; n: number; agent: number; assisted: number; sizes: number[] }>>`
    SELECT ${v.person} AS login, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE "authorClass" = 'agent')::int AS agent,
           COUNT(*) FILTER (WHERE "agentAssisted")::int AS assisted,
           array_agg(("additions" + "deletions")) AS sizes
    FROM github_prs WHERE ${inRepos(repos)} AND ${col} >= ${since} AND ${v.where}${inTeam(v, logins)}
    GROUP BY 1 ORDER BY n DESC, login ASC`;
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const users = await termagByLogin();
  // A team view is a roster, not a leaderboard: every login on it appears, zeros included.
  const byLogin = new Map(rows.map(r => [r.login, r]));
  const all = logins ? logins.map(login => byLogin.get(login) ?? { login, n: 0, agent: 0, assisted: 0, sizes: [] as number[] }) : rows;
  const top = all.map(r => ({
    login: r.login, prs: Number(r.n), share: total ? Number(r.n) / total : 0,
    agentPrs: Number(r.agent), agentAssisted: Number(r.assisted), medianSize: median(r.sizes ?? []),
    termag: users.get(r.login) ?? null,
  }));
  return {
    group: slug, view, basis, days, total,
    contributors: logins ? logins.length : rows.length,
    top: logins ? top : top.slice(0, Math.max(1, Math.min(100, limit))),
  };
}

/** Monday 00:00 UTC on or before `d`. */
const mondayOf = (d: Date): Date => {
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000);
};

export async function prTrend(slug: string, view: View, basis: Basis, weeks = 26, now = new Date(), team?: TeamRoster) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000);
  if (!team) {
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
  // A team: each week uses the roster at that week's dates, not one flat roster.
  const rows: Array<{ week: string; human: number; agent: number; automation: number; prs: number; contributors: number }> = [];
  for (let w = mondayOf(since); w.getTime() <= now.getTime(); w = new Date(w.getTime() + 7 * 86_400_000)) {
    const until = new Date(Math.min(w.getTime() + 7 * 86_400_000, now.getTime() + 1));
    // The first Monday can predate `since`; clamp it so the first bucket is the requested window.
    const from = w.getTime() < since.getTime() ? since : w;
    const logins = rosterIn(team, from, until);
    const [r] = await prisma.$queryRaw<Array<{ human: number; agent: number; automation: number; contributors: number; inview: number }>>`
      SELECT COUNT(*) FILTER (WHERE "authorClass" = 'human')::int AS human,
             COUNT(*) FILTER (WHERE "authorClass" = 'agent')::int AS agent,
             COUNT(*) FILTER (WHERE "authorClass" = 'automation')::int AS automation,
             COUNT(DISTINCT CASE WHEN ${v.where} THEN ${v.person} END)::int AS contributors,
             COUNT(*) FILTER (WHERE ${v.where})::int AS inview
      FROM github_prs WHERE ${inRepos(repos)} AND ${col} >= ${from} AND ${col} < ${until}${inTeam(v, logins)}`;
    rows.push({ week: w.toISOString().slice(0, 10), human: Number(r?.human ?? 0), agent: Number(r?.agent ?? 0), automation: Number(r?.automation ?? 0), prs: Number(r?.inview ?? 0), contributors: Number(r?.contributors ?? 0) });
  }
  return { group: slug, view, basis, weeks, rows };
}

/**
 * A group's PRs merged or reviewed since `since`, with every review of them
 * (a deciding approval or a first review can predate the window), and the
 * group's repos where the approval agent has ever approved.
 */
async function reviewData(repos: GroupScope, since: Date, creditedIn?: readonly string[]): Promise<{ prs: RPr[]; reviews: RReview[]; agentRepos: Set<string> }> {
  const base = Prisma.sql`${inRepos(repos)} AND ("mergedAt" >= ${since} OR "id" IN (SELECT "prId" FROM github_pr_reviews WHERE "submittedAt" >= ${since}))`;
  // A team's received reviews: only PRs credited to its people. An empty roster matches nothing.
  const scope = creditedIn === undefined ? base
    : creditedIn.length ? Prisma.sql`${base} AND "creditedLogin" IN (${Prisma.join(creditedIn)})`
      : Prisma.sql`${base} AND FALSE`;
  const [prRows, reviewRows, agent] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; repo: string; authorLogin: string; creditedLogin: string | null; readyAt: Date | null; createdAt: Date; mergedAt: Date | null; comments: number; humanComments: number; reviewCount: number; reviewsReadAt: Date | null; reviewRequests: unknown }>>`
      SELECT "id", "repo", "authorLogin", "creditedLogin", "readyAt", "createdAt", "mergedAt", "comments", "humanComments", "reviewCount", "reviewsReadAt", "reviewRequests"
      FROM github_prs WHERE ${scope}`,
    prisma.$queryRaw<Array<{ prId: string; reviewerLogin: string; reviewerClass: string; state: string; submittedAt: Date; comments: number }>>`
      SELECT r."prId", r."reviewerLogin", r."reviewerClass", r."state", r."submittedAt", r."comments"
      FROM github_pr_reviews r WHERE r."prId" IN (SELECT "id" FROM github_prs WHERE ${scope})`,
    repos.slug === ALL_REPOS || repos.repos.length ? prisma.$queryRaw<Array<{ repo: string }>>`
      SELECT DISTINCT p."repo" FROM github_pr_reviews r JOIN github_prs p ON p."id" = r."prId"
      WHERE ${repos.slug === ALL_REPOS ? Prisma.sql`TRUE` : Prisma.sql`p."repo" IN (${Prisma.join(repos.repos)})`} AND r."state" = 'APPROVED' AND r."reviewerClass" <> 'human'
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

/** PRs credited to any of `logins` (for a window's received reviews). */
const creditedPrIds = (prs: RPr[], logins: ReadonlySet<string>): Set<string> =>
  new Set(prs.filter(p => p.credited && logins.has(p.credited)).map(p => p.id));

/** Reviews a team gave (its members) or received (on its PRs), for the last 1, 7 and 30 days. */
export async function prTeamReviews(slug: string, side: 'given' | 'received', team: TeamRoster, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const since = new Date(now.getTime() - Math.max(...WINDOWS) * 86_400_000);
  // The SQL prefilter takes the whole window's roster (a superset); each window is then counted
  // with the roster at that window's dates, not one flat roster.
  const union = rosterIn(team, since, now);
  const d = await reviewData(repos, since, side === 'received' ? union : undefined);
  // Received: every reviewer class, tagged, so bots (Bugbot, Cursor, Devin) can be seen and filtered.
  const classes = side === 'received' ? ALL_REVIEWER_CLASSES : undefined;
  const windows = WINDOWS.map(days => {
    const wSince = new Date(now.getTime() - days * 86_400_000);
    const teamSet = new Set(rosterIn(team, wSince, now));
    if (side === 'given') return reviewWindow(d.prs, d.reviews.filter(r => teamSet.has(r.login)), wSince, now, d.agentRepos, classes);
    // Received: only this window's team PRs, so comments-per-PR and the approval split don't
    // include people who were on the team only in the longer window.
    const prs = d.prs.filter(p => p.credited && teamSet.has(p.credited));
    const ids = new Set(prs.map(p => p.id));
    return reviewWindow(prs, d.reviews.filter(r => ids.has(r.prId)), wSince, now, d.agentRepos, classes);
  });
  return {
    group: slug, team: team.key, side, repos: repos.slug === ALL_REPOS ? new Set(d.prs.map(p => p.repo)).size : repos.repos.length,
    reviewDays: REVIEW_DAYS, approvalAgentLogins: APPROVAL_AGENT_LOGINS, windows, generatedAt: now.toISOString(),
  };
}

/** A member with no reviews, for a team roster's zeros. */
function emptyReviewer(login: string): Reviewer {
  return { login, cls: 'human', reviews: 0, approved: 0, changesRequested: 0, commentOnly: 0, inlineComments: 0, decidingApprovals: 0, medianHoursToFirstReview: null, askedReviews: 0, stalePickups: 0, authorsHelped: 0 };
}

/** Reviewers of a team's PRs (received), or the team's own reviewers (given), over 1/7/30 days. */
export async function prTeamReviewers(slug: string, side: 'given' | 'received', team: TeamRoster, days: number, limit = 10, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const since = new Date(now.getTime() - days * 86_400_000);
  const logins = rosterIn(team, since, now);
  const teamSet = new Set(logins);
  const d = await reviewData(repos, since, side === 'received' ? logins : undefined);
  const reviews = side === 'given'
    ? d.reviews.filter(r => teamSet.has(r.login))
    : d.reviews.filter(r => creditedPrIds(d.prs, teamSet).has(r.prId));
  const all = topReviewers(d.prs, reviews, since, now, side === 'received' ? ALL_REVIEWER_CLASSES : undefined);
  const users = await termagByLogin();
  const byLogin = new Map(all.map(r => [r.login, r]));
  // Given: the roster, zeros included. Received: the reviewers of the team's PRs.
  const rows = side === 'given' ? logins.map(login => byLogin.get(login) ?? emptyReviewer(login)) : all;
  const shown = side === 'given' ? rows : rows.slice(0, Math.max(1, Math.min(100, limit)));
  return {
    group: slug, team: team.key, side, days, reviewers: rows.length, reviews: all.reduce((s, r) => s + r.reviews, 0),
    top: shown.map(r => ({ ...r, termag: users.get(r.login) ?? null })),
  };
}

/** Weekly reviews given and received by a team, the roster resolved per week. */
export async function prTeamReviewTrend(slug: string, team: TeamRoster, weeks: number, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const start = new Date(mondayOf(now).getTime() - (weeks - 1) * 7 * 86_400_000);
  const d = await reviewData(repos, start);
  return { group: slug, team: team.key, weeks, rows: teamReviewTrend(d.prs, d.reviews, (since, until) => rosterIn(team, since, until), start, now) };
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

/** Where a team ships: its PRs by repo, for one window (Metrics). */
export async function prTeamRepos(slug: string, view: View, basis: Basis, days: number, team: TeamRoster, now = new Date()) {
  const repos = await groupRepos(slug);
  if (!repos) return null;
  const v = viewSql(view); const col = dateCol(basis);
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ repo: string; n: number; contributors: number }>>`
    SELECT "repo", COUNT(*)::int AS n, COUNT(DISTINCT ${v.person})::int AS contributors
    FROM github_prs WHERE ${inRepos(repos)} AND ${col} >= ${since} AND ${v.where}${inTeam(v, rosterIn(team, since, now))}
    GROUP BY 1 ORDER BY n DESC, "repo" ASC`;
  return {
    group: slug, team: team.key, view, basis, days,
    repos: rows.map(r => ({ repo: r.repo, prs: Number(r.n), contributors: Number(r.contributors) })),
  };
}

/** The teams and their rosters, for the picker. */
export async function prTeams(now = new Date()) {
  const [teams, memberships] = await Promise.all([
    prisma.team.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] }),
    prisma.teamMembership.findMany({ select: { teamKey: true, login: true, end: true, source: true } }),
  ]);
  return teams.map(t => {
    const mine = memberships.filter(m => m.teamKey === t.key);
    const current = new Set(mine.filter(m => !m.end || m.end > now).map(m => m.login));
    const former = new Set(mine.filter(m => m.end && m.end <= now).map(m => m.login));
    for (const l of current) former.delete(l);
    // `manual` is what the editor edits: the admin's overrides, not the synced roster.
    const manual = new Set(mine.filter(m => m.source === 'manual' && (!m.end || m.end > now)).map(m => m.login));
    return { key: t.key, name: t.name, parent: t.parent, hidden: t.hidden, sort: t.sort, members: [...current].sort(), manual: [...manual].sort(), former: former.size };
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
