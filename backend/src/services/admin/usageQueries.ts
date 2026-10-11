/**
 * Token and working-time rollups across every user (admin surface).
 * The per-user routes' SQL with the userId filter dropped and a GROUP BY
 * dimension added. Dimensions are whitelisted identifiers, never caller text.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import type { Range } from './range';
import { tokenSourceSql } from './tokenSource';

export const TOKEN_GROUPS = ['day', 'user', 'provider', 'host', 'project'] as const;
export type TokenGroup = typeof TOKEN_GROUPS[number];
const TOKEN_COL: Record<TokenGroup, string> = {
  day: '"date"', user: '"userId"', provider: '"provider"', host: '"hostKey"', project: '"projectId"',
};

export interface TokenRow {
  key: string;           // the group value (date, userId, provider, hostKey, projectId or 'unattributed')
  label: string;         // display name resolved for user/host/project
  input: number; output: number; cacheRead: number; cacheCreate: number; calls: number;
  total: number;         // input + output + cacheRead + cacheCreate
  cacheRatio: number | null; // cacheRead / (input + cacheRead)
  estimated: number;     // tokens from estimated rows (poller)
}

export interface TokenReport {
  range: { since: string; until: string; days: number; dayKeys: 'utc' };
  groupBy: TokenGroup[];
  rows: Array<Omit<TokenRow, 'key' | 'label'> & { keys: string[]; labels: string[] }>;
  totals: Omit<TokenRow, 'key' | 'label'>;
  prior: Pick<TokenRow, 'total'>;
  users: number;
}

function parseGroups(raw: string | string[] | undefined, allowed: readonly string[], fallback: string): string[] {
  const list = (Array.isArray(raw) ? raw : (raw ?? fallback).split(',')).map(s => s.trim()).filter(Boolean);
  const out = [...new Set(list)].filter(g => allowed.includes(g));
  return out.length ? out : [fallback];
}

export function parseTokenGroups(raw: string | string[] | undefined): TokenGroup[] {
  return parseGroups(raw, TOKEN_GROUPS, 'day') as TokenGroup[];
}

export async function tokenReport(range: Range, groupBy: TokenGroup[]): Promise<TokenReport> {
  const cols = groupBy.map(g => TOKEN_COL[g]);
  const sel = Prisma.raw(cols.map((c, i) => `${c} AS g${i}`).join(', '));
  const grp = Prisma.raw(cols.join(', '));
  type Raw = Record<string, unknown> & { input: number; output: number; cacheRead: number; cacheCreate: number; calls: number; estTokens: number };
  const [raw, totals, prior, users] = await Promise.all([
    prisma.$queryRaw<Raw[]>`
      SELECT ${sel},
             SUM("input")::float8 AS "input", SUM("output")::float8 AS "output",
             SUM("cacheRead")::float8 AS "cacheRead", SUM("cacheCreate")::float8 AS "cacheCreate",
             SUM("calls")::int AS "calls",
             SUM(CASE WHEN "estimated" THEN "input" + "output" + "cacheRead" + "cacheCreate" ELSE 0 END)::float8 AS "estTokens"
      FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t
      GROUP BY ${grp}`,
    prisma.$queryRaw<Raw[]>`
      SELECT SUM("input")::float8 AS "input", SUM("output")::float8 AS "output",
             SUM("cacheRead")::float8 AS "cacheRead", SUM("cacheCreate")::float8 AS "cacheCreate",
             SUM("calls")::int AS "calls",
             SUM(CASE WHEN "estimated" THEN "input" + "output" + "cacheRead" + "cacheCreate" ELSE 0 END)::float8 AS "estTokens"
      FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t`,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COALESCE(SUM("input" + "output" + "cacheRead" + "cacheCreate"), 0)::float8 AS total
      FROM ${tokenSourceSql(range.priorKeys[0], range.priorKeys[range.priorKeys.length - 1])} t`,
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT "userId")::int AS n FROM ${tokenSourceSql(range.sinceKey, range.untilKey)} t`,
  ]);
  const labels = await resolveLabels(groupBy, raw.map(r => groupBy.map((_, i) => r[`g${i}`] as string | null)));
  const shape = (r: Raw) => {
    const input = Number(r.input ?? 0), output = Number(r.output ?? 0), cacheRead = Number(r.cacheRead ?? 0), cacheCreate = Number(r.cacheCreate ?? 0);
    return {
      input, output, cacheRead, cacheCreate, calls: Number(r.calls ?? 0),
      total: input + output + cacheRead + cacheCreate,
      cacheRatio: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
      estimated: Number(r.estTokens ?? 0),
    };
  };
  return {
    range: { since: range.sinceKey, until: range.untilKey, days: range.days, dayKeys: 'utc' },
    groupBy,
    rows: raw.map(r => {
      const keys = groupBy.map((_, i) => (r[`g${i}`] as string | null) ?? 'unattributed');
      return { keys, labels: keys.map((k, i) => labels[i].get(k) ?? k), ...shape(r) };
    }).sort((a, b) => b.total - a.total),
    totals: shape(totals[0] ?? {} as Raw),
    prior: { total: Number(prior[0]?.total ?? 0) },
    users: Number(users[0]?.n ?? 0),
  };
}

/** userId / hostKey / projectId → display label. Small sets, resolved in JS. */
async function resolveLabels(groups: readonly string[], rows: Array<Array<string | null>>): Promise<Array<Map<string, string>>> {
  return Promise.all(groups.map(async (g, i) => {
    const ids = [...new Set(rows.map(r => r[i]).filter((x): x is string => !!x))];
    const m = new Map<string, string>();
    if (g === 'user' && ids.length) {
      for (const u of await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, unixUsername: true } })) m.set(u.id, u.unixUsername);
    } else if (g === 'host' && ids.length) {
      m.set('legacy', 'orchestrator'); m.set('poller', 'poller');
      for (const b of await prisma.instance.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, user: { select: { unixUsername: true } } } })) m.set(b.id, `${b.user?.unixUsername ?? 'pool'}/${b.name}`);
    } else if (g === 'project' && ids.length) {
      for (const p of await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, user: { select: { unixUsername: true } } } })) m.set(p.id, `${p.user.unixUsername}/${p.name}`);
    }
    return m;
  }));
}

export const WORKTIME_GROUPS = ['day', 'user', 'provider', 'project'] as const;
export type WorktimeGroup = typeof WORKTIME_GROUPS[number];
const WT_COL: Record<WorktimeGroup, string> = { day: '"date"', user: '"username"', provider: '"provider"', project: '"project"' };

export function parseWorktimeGroups(raw: string | string[] | undefined): WorktimeGroup[] {
  return parseGroups(raw, WORKTIME_GROUPS, 'day') as WorktimeGroup[];
}

export interface WorktimeReport {
  range: { since: string; until: string; days: number; dayKeys: 'server-local' };
  groupBy: WorktimeGroup[];
  rows: Array<{ keys: string[]; agentMs: number; humanMs: number; sessions: number }>;
  totals: { agentMs: number; humanMs: number; sessions: number };
  prior: { agentMs: number; humanMs: number };
  /** usernames in work_time_entries that match no users.unixUsername (data-quality signal). */
  unknownUsernames: string[];
}

export async function worktimeReport(range: Range, groupBy: WorktimeGroup[]): Promise<WorktimeReport> {
  const cols = groupBy.map(g => WT_COL[g]);
  const sel = Prisma.raw(cols.map((c, i) => `${c} AS g${i}`).join(', '));
  const grp = Prisma.raw(cols.join(', '));
  type Raw = Record<string, unknown> & { agentMs: number; humanMs: number; sessions: number };
  const sumExpr = Prisma.raw(`
    SUM(CASE WHEN "provider" <> 'human' THEN "totalMs" ELSE 0 END)::float8 AS "agentMs",
    SUM(CASE WHEN "provider" = 'human' THEN "totalMs" ELSE 0 END)::float8 AS "humanMs",
    SUM(CASE WHEN "provider" <> 'human' THEN "sessions" ELSE 0 END)::int AS "sessions"`);
  const [raw, totals, prior, unknown] = await Promise.all([
    prisma.$queryRaw<Raw[]>`SELECT ${sel}, ${sumExpr} FROM work_time_entries
      WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey} GROUP BY ${grp}`,
    prisma.$queryRaw<Raw[]>`SELECT ${sumExpr} FROM work_time_entries
      WHERE "date" >= ${range.worktimeSinceKey} AND "date" <= ${range.worktimeUntilKey}`,
    prisma.$queryRaw<Raw[]>`SELECT ${sumExpr} FROM work_time_entries
      WHERE "date" >= ${range.priorKeys[0]} AND "date" <= ${range.priorKeys[range.priorKeys.length - 1]}`,
    prisma.$queryRaw<Array<{ username: string }>>`
      SELECT DISTINCT w."username" FROM work_time_entries w
      LEFT JOIN users u ON u."unixUsername" = w."username"
      WHERE u.id IS NULL AND w."date" >= ${range.worktimeSinceKey}`,
  ]);
  const n = (x: unknown) => Number(x ?? 0);
  return {
    range: { since: range.worktimeSinceKey, until: range.worktimeUntilKey, days: range.days, dayKeys: 'server-local' },
    groupBy,
    rows: raw.map(r => ({
      keys: groupBy.map((_, i) => String(r[`g${i}`] ?? '')),
      agentMs: n(r.agentMs), humanMs: n(r.humanMs), sessions: n(r.sessions),
    })).sort((a, b) => (b.agentMs + b.humanMs) - (a.agentMs + a.humanMs)),
    totals: { agentMs: n(totals[0]?.agentMs), humanMs: n(totals[0]?.humanMs), sessions: n(totals[0]?.sessions) },
    prior: { agentMs: n(prior[0]?.agentMs), humanMs: n(prior[0]?.humanMs) },
    unknownUsernames: unknown.map(u => u.username).sort(),
  };
}

/** Per user, per UTC day, trailing (baseline + today): tokens and cache inputs, for signals. */
export async function userTokenDays(keys: string[]) {
  const rows = await prisma.$queryRaw<Array<{ userId: string; unixUsername: string; date: string; input: number; output: number; cacheRead: number; cacheCreate: number }>>`
    SELECT t."userId", u."unixUsername", t."date",
           SUM(t."input")::float8 AS "input", SUM(t."output")::float8 AS "output",
           SUM(t."cacheRead")::float8 AS "cacheRead", SUM(t."cacheCreate")::float8 AS "cacheCreate"
    FROM ${tokenSourceSql(keys[0], keys[keys.length - 1])} t JOIN users u ON u.id = t."userId"
    WHERE NOT t."estimated"
    GROUP BY t."userId", u."unixUsername", t."date"`;
  const byUser = new Map<string, { userId: string; unixUsername: string; days: Record<string, { tokens: number; input: number; cacheRead: number }> }>();
  for (const r of rows) {
    const u = byUser.get(r.userId) ?? { userId: r.userId, unixUsername: r.unixUsername, days: {} };
    u.days[r.date] = { tokens: Number(r.input) + Number(r.output) + Number(r.cacheRead) + Number(r.cacheCreate), input: Number(r.input), cacheRead: Number(r.cacheRead) };
    byUser.set(r.userId, u);
  }
  return [...byUser.values()];
}
