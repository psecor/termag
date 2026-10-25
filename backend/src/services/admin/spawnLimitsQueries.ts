/**
 * The spawn limits in effect, per user, for the admin System tab.
 * Read-only on purpose: the
 * agent-spawn-limits flag (TERMAG_FLAGS) is where they are changed, and this
 * shows what it serves against the code defaults and how close each user is.
 *
 * Evaluated for the user alone (no box): a variation targeted on a box
 * context applies only to spawns onto that box, so the tab says so.
 */
import { prisma } from '../../db';
import { RUNNING_SPAWN_WHERE, spawnLimitsFor } from '../spawnBudget';
import { DEFAULT_SPAWN_LIMITS, SPAWN_LIMITS_FLAG, type SpawnLimits } from '../spawnLimits';

const HOUR_MS = 60 * 60 * 1000;
const ACTIVE_DAYS = 30;

export interface SpawnLimitsUserRow {
  user: { id: string; unixUsername: string; displayName: string };
  limits: SpawnLimits;
  /** Dotted keys whose value is not the code default, e.g. "perHour", "hot.memPct". */
  overrides: string[];
  usage: { lastHour: number; running: number; last30d: number };
}

export interface SpawnLimitsReport {
  flag: { key: string; url: string | null };
  defaults: SpawnLimits;
  /** Users who spawned in the last 30 days, have a spawn still running, or are served anything but the defaults. */
  users: SpawnLimitsUserRow[];
  generatedAt: string;
}

/** The keys of `limits` that differ from `defaults`, the hot thresholds as "hot.<key>". */
export function limitOverrides(limits: SpawnLimits, defaults: SpawnLimits = DEFAULT_SPAWN_LIMITS): string[] {
  const out: string[] = [];
  for (const k of Object.keys(defaults) as (keyof SpawnLimits)[]) {
    if (k === 'hot') continue;
    if (limits[k] !== defaults[k]) out.push(k);
  }
  for (const k of Object.keys(defaults.hot) as (keyof SpawnLimits['hot'])[]) {
    if (limits.hot[k] !== defaults.hot[k]) out.push(`hot.${k}`);
  }
  return out;
}

export async function spawnLimitsReport(now: number = Date.now()): Promise<SpawnLimitsReport> {
  const users = await prisma.user.findMany({
    select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
  });
  const since30d = new Date(now - ACTIVE_DAYS * 24 * HOUR_MS);
  const [last30d, lastHour, running] = await Promise.all([
    prisma.agentSpawn.groupBy({ by: ['userId'], where: { createdAt: { gte: since30d } }, _count: { _all: true } }),
    prisma.agentSpawn.groupBy({ by: ['userId'], where: { createdAt: { gte: new Date(now - HOUR_MS) } }, _count: { _all: true } }),
    // The predicate maxConcurrentPerUser is enforced with, so the column cannot drift from it.
    prisma.agentSpawn.groupBy({ by: ['userId'], where: RUNNING_SPAWN_WHERE, _count: { _all: true } }),
  ]);
  const count = (rows: { userId: string; _count: { _all: number } }[]) => new Map(rows.map(r => [r.userId, r._count._all]));
  const c30 = count(last30d), c1h = count(lastHour), cRun = count(running);

  // The SDK evaluates locally from its cached rules, so one call per user is cheap.
  const rows = await Promise.all(users.map(async (u): Promise<SpawnLimitsUserRow> => {
    const limits = await spawnLimitsFor(u, null);
    return {
      user: { id: u.id, unixUsername: u.unixUsername, displayName: u.displayName },
      limits,
      overrides: limitOverrides(limits),
      usage: { lastHour: c1h.get(u.id) ?? 0, running: cRun.get(u.id) ?? 0, last30d: c30.get(u.id) ?? 0 },
    };
  }));
  return {
    flag: { key: SPAWN_LIMITS_FLAG, url: null },
    defaults: DEFAULT_SPAWN_LIMITS,
    users: rows
      // Running too: a spawn older than 30 days still counts against maxConcurrentPerUser.
      .filter(r => r.usage.last30d > 0 || r.usage.running > 0 || r.overrides.length > 0)
      .sort((a, b) => b.overrides.length - a.overrides.length || b.usage.last30d - a.usage.last30d || a.user.unixUsername.localeCompare(b.user.unixUsername)),
    generatedAt: new Date(now).toISOString(),
  };
}
