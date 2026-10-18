/**
 * User directory and activity queries for the admin surface.
 */
import { prisma } from '../../db';
import { getConnectedAgents } from '../agentRegistry';
import { isAdminUser } from './adminAccess';
import { cloudSummary, type CloudCounts } from './claudeRunnerQueries';
import { fillDays, dayKey, type Range } from './range';
import { tokenSourceSql } from './tokenSource';

const utcTodayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

export interface AdminUser {
  id: string; email: string; displayName: string; unixUsername: string; defaultAgentProvider: string;
  role: 'admin' | 'member'; adminSource: string | null;
  createdAt: string; lastSeenAt: string | null;
  boxes: { total: number; ready: number; connected: number };
  legacyAgentConnected: boolean;
  projects: { active: number; archived: number; lastActiveAt: string | null };
  shares: { given: number; received: number };
  slack: boolean; discord: boolean;
  /** Claude Code cloud sessions: open now, and runs started in the range. */
  cloud: CloudCounts & { runsInRange: number };
  /** Range rollups. */
  agentMs: number; humanMs: number; tokens: number; cacheRatio: number | null;
}

export async function listUsers(range: Range): Promise<AdminUser[]> {
  const [users, worktime, tokens, cloud, cloudRuns] = await Promise.all([
    prisma.user.findMany({
      include: {
        instances: { where: { status: { not: 'terminated' } }, select: { id: true, status: true } },
        projects: { select: { archived: true, lastActiveAt: true } },
        _count: { select: { sharedWithMe: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.$queryRaw<Array<{ username: string; agentMs: number; humanMs: number }>>`
      SELECT "username",
             SUM(CASE WHEN "provider" <> 'human' THEN "totalMs" ELSE 0 END)::float8 AS "agentMs",
             SUM(CASE WHEN "provider" = 'human' THEN "totalMs" ELSE 0 END)::float8 AS "humanMs"
      FROM work_time_entries WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey}
      GROUP BY "username"`,
    prisma.$queryRaw<Array<{ userId: string; total: number; input: number; cacheRead: number }>>`
      SELECT "userId", SUM("input" + "output" + "cacheRead" + "cacheCreate")::float8 AS total,
             SUM("input")::float8 AS input, SUM("cacheRead")::float8 AS "cacheRead"
      FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t
      GROUP BY "userId"`,
    cloudSummary(),
    prisma.claudeRunnerSession.groupBy({ by: ['userId'], where: { startedAt: { gte: range.sinceTs, lt: range.untilTs } }, _count: true }),
  ]);
  const cloudRunsByUser = new Map(cloudRuns.map(r => [r.userId, r._count]));
  const sharesGiven = await prisma.projectShare.groupBy({ by: ['projectId'], _count: true }).then(async rows => {
    const ids = rows.map(r => r.projectId);
    const owners = ids.length ? await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true } }) : [];
    const ownerOf = new Map(owners.map(p => [p.id, p.userId]));
    const out = new Map<string, number>();
    for (const r of rows) { const o = ownerOf.get(r.projectId); if (o) out.set(o, (out.get(o) ?? 0) + r._count); }
    return out;
  });
  const connected = getConnectedAgents();
  const connectedInstances = new Set(connected.filter(a => a.instanceId).map(a => a.instanceId!));
  const legacyConnected = new Set(connected.filter(a => !a.instanceId).map(a => a.userId));
  const wt = new Map(worktime.map(w => [w.username, w]));
  const tk = new Map(tokens.map(t => [t.userId, t]));
  return users.map(u => {
    const active = u.projects.filter(p => !p.archived);
    const lastActive = active.reduce<Date | null>((m, p) => (!m || p.lastActiveAt > m ? p.lastActiveAt : m), null);
    const t = tk.get(u.id);
    return {
      id: u.id, email: u.googleEmail, displayName: u.displayName, unixUsername: u.unixUsername, defaultAgentProvider: u.defaultAgentProvider,
      role: isAdminUser(u) ? 'admin' : 'member', adminSource: u.role === 'admin' ? u.adminSource : (isAdminUser(u) ? 'env' : null),
      createdAt: u.createdAt.toISOString(), lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      boxes: { total: u.instances.length, ready: u.instances.filter(i => i.status === 'ready').length, connected: u.instances.filter(i => connectedInstances.has(i.id)).length },
      legacyAgentConnected: legacyConnected.has(u.id),
      projects: { active: active.length, archived: u.projects.length - active.length, lastActiveAt: lastActive?.toISOString() ?? null },
      shares: { given: sharesGiven.get(u.id) ?? 0, received: u._count.sharedWithMe },
      slack: !!u.slackUserId, discord: !!u.discordUserId,
      cloud: { ...(cloud.byUser[u.id] ?? { running: 0, starting: 0 }), runsInRange: cloudRunsByUser.get(u.id) ?? 0 },
      agentMs: Number(wt.get(u.unixUsername)?.agentMs ?? 0), humanMs: Number(wt.get(u.unixUsername)?.humanMs ?? 0),
      tokens: Number(t?.total ?? 0),
      cacheRatio: t && Number(t.input) + Number(t.cacheRead) > 0 ? Number(t.cacheRead) / (Number(t.input) + Number(t.cacheRead)) : null,
    };
  });
}

export async function getUser(id: string, range: Range) {
  const [all, user] = await Promise.all([
    listUsers(range),
    prisma.user.findUnique({
      where: { id },
      include: {
        instances: { where: { status: { not: 'terminated' } }, select: { id: true, name: true, kind: true, status: true, createdAt: true, lastConnectedAt: true } },
        projects: { select: { id: true, name: true, archived: true, pinned: true, kind: true, lastActiveAt: true, instanceId: true, createdAt: true }, orderBy: { lastActiveAt: 'desc' } },
        agentTokens: { where: { revokedAt: null }, select: { id: true, name: true, scope: true, tokenPrefix: true, createdAt: true, lastUsedAt: true, expiresAt: true, instanceId: true } },
      },
    }),
  ]);
  const summary = all.find(u => u.id === id);
  if (!summary || !user) return null;
  return {
    ...summary,
    instances: user.instances.map(i => ({ ...i, createdAt: i.createdAt.toISOString(), lastConnectedAt: i.lastConnectedAt?.toISOString() ?? null })),
    projectList: user.projects.map(p => ({ ...p, lastActiveAt: p.lastActiveAt.toISOString(), createdAt: p.createdAt.toISOString() })),
    tokenList: user.agentTokens.map(t => ({ ...t, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, expiresAt: t.expiresAt?.toISOString() ?? null })),
  };
}

export interface ActiveUsersDay { date: string; signedIn: number; agentWorked: number; humanWorked: number; usedTokens: number; switchedProjects: number }

/**
 * Daily active users under several definitions. "signedIn" needs
 * users.lastSeenAt history, which does not exist (only the latest value), so
 * it is reported for today only; the other four come from persisted tables.
 * Worktime days are server-local, the rest UTC — labelled in the response.
 */
export async function activeUsers(range: Range): Promise<{ days: ActiveUsersDay[]; totals: Record<string, number>; registered: number; note: string }> {
  const [wt, tk, vs, seenToday, registered] = await Promise.all([
    prisma.$queryRaw<Array<{ date: string; agent: number; human: number }>>`
      SELECT "date",
             COUNT(DISTINCT CASE WHEN "provider" <> 'human' AND "totalMs" > 0 THEN "username" END)::int AS agent,
             COUNT(DISTINCT CASE WHEN "provider" = 'human' AND "totalMs" > 0 THEN "username" END)::int AS human
      FROM work_time_entries WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey} GROUP BY "date"`,
    prisma.$queryRaw<Array<{ date: string; n: number }>>`
      SELECT "date", COUNT(DISTINCT "userId")::int AS n FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t
      WHERE ("input" + "output" + "cacheRead" + "cacheCreate") > 0 GROUP BY "date"`,
    prisma.$queryRaw<Array<{ date: string; n: number }>>`
      SELECT to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, COUNT(DISTINCT "userId")::int AS n
      FROM project_visits WHERE timestamp >= ${range.sinceTs} AND timestamp < ${range.untilTs} GROUP BY 1`,
    prisma.user.count({ where: { lastSeenAt: { gte: utcTodayStart() } } }),
    prisma.user.count(),
  ]);
  const reachesToday = range.keys[range.keys.length - 1] === dayKey(utcTodayStart());
  const by = new Map<string, Partial<ActiveUsersDay>>();
  const upd = (d: string, patch: Partial<ActiveUsersDay>) => by.set(d, { ...(by.get(d) ?? {}), ...patch });
  for (const r of wt) upd(r.date, { agentWorked: Number(r.agent), humanWorked: Number(r.human) });
  for (const r of tk) upd(r.date, { usedTokens: Number(r.n) });
  for (const r of vs) upd(r.date, { switchedProjects: Number(r.n) });
  // users.lastSeenAt is only the latest value, so "signed in" exists for today alone.
  if (reachesToday) upd(range.keys[range.keys.length - 1], { signedIn: seenToday });
  const days = fillDays(range.worktimeKeys.length > range.keys.length ? [...new Set([...range.keys, ...range.worktimeKeys])].sort() : range.keys, by as Map<string, Omit<ActiveUsersDay, 'date'>>, () => ({ signedIn: 0, agentWorked: 0, humanWorked: 0, usedTokens: 0, switchedProjects: 0 }))
    .map(d => ({ ...d, signedIn: d.signedIn ?? 0, agentWorked: d.agentWorked ?? 0, humanWorked: d.humanWorked ?? 0, usedTokens: d.usedTokens ?? 0, switchedProjects: d.switchedProjects ?? 0 }));
  const distinct = await prisma.$queryRaw<Array<{ k: string; n: number }>>`
    SELECT 'agentWorked' AS k, COUNT(DISTINCT "username")::int AS n FROM work_time_entries WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey} AND "provider" <> 'human' AND "totalMs" > 0
    UNION ALL SELECT 'humanWorked', COUNT(DISTINCT "username")::int FROM work_time_entries WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey} AND "provider" = 'human' AND "totalMs" > 0
    UNION ALL SELECT 'usedTokens', COUNT(DISTINCT "userId")::int FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t
    UNION ALL SELECT 'switchedProjects', COUNT(DISTINCT "userId")::int FROM project_visits WHERE timestamp >= ${range.sinceTs} AND timestamp < ${range.untilTs}
    UNION ALL SELECT 'signedIn', COUNT(*)::int FROM users WHERE "lastSeenAt" >= ${range.sinceTs}`;
  return {
    days,
    totals: Object.fromEntries(distinct.filter(r => r.k !== 'signedIn' || reachesToday).map(r => [r.k, Number(r.n)])),
    registered,
    note: 'agentWorked/humanWorked use server-local dates; usedTokens/switchedProjects use UTC; signedIn comes from users.lastSeenAt (latest value only), so it is reported for today and for ranges that reach today.',
  };
}
