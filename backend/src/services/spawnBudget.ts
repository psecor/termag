/**
 * The database half of spawn limits: the limits the
 * agent-spawn-limits flag serves this user on this box, the counts they are
 * checked against, box readings, and the budget every spawn response,
 * list_spawns and spawn_budget show. The rules live in services/spawnLimits.ts.
 */
import { prisma } from '../db';
import { isProjectAgentConnected } from './agentRegistry';
import { OPEN_STATES } from './agentSpawn';
import { jsonVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import {
  FINISHED_IDLE_MS,
  SPAWN_LIMITS_FLAG,
  parseSpawnLimits,
  spawnHints,
  type BoxReading,
  type Budget,
  type SpawnLimits,
  type UsageCounts,
} from './spawnLimits';
import { getStatus } from './status';
import * as tmux from './tmux';

const HOUR_MS = 60 * 60 * 1000;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** What the flag serves for this user on this box, over the defaults. */
export async function spawnLimitsFor(user: FlagUser, box: { id: string; name: string; kind: string } | null): Promise<SpawnLimits> {
  return parseSpawnLimits(await jsonVariation(SPAWN_LIMITS_FLAG, user, null, box));
}

export const BOX_SELECT = { id: true, name: true, kind: true, userId: true, status: true, memUsedPct: true, diskUsedPct: true, load1: true, hostSampledAt: true } as const;
export type BoxRow = { id: string; name: string; memUsedPct: number | null; diskUsedPct: number | null; load1: number | null; hostSampledAt: Date | null };

/** Box rows plus their latest history sample (cores and live agents live only there). */
export async function readings(rows: BoxRow[]): Promise<BoxReading[]> {
  if (!rows.length) return [];
  const latest = await prisma.hostSample.findMany({
    where: { instanceId: { in: rows.map(r => r.id) }, at: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { at: 'desc' },
    select: { instanceId: true, cores: true, liveAgents: true },
  });
  const byBox = new Map<string, { cores: number | null; liveAgents: number | null }>();
  for (const s of latest) if (!byBox.has(s.instanceId)) byBox.set(s.instanceId, s);
  return rows.map(r => ({
    id: r.id, name: r.name, memUsedPct: r.memUsedPct, diskUsedPct: r.diskUsedPct, load1: r.load1,
    sampledAt: r.hostSampledAt, cores: byBox.get(r.id)?.cores ?? null, liveAgents: byBox.get(r.id)?.liveAgents ?? null,
  }));
}

export async function boxReading(instanceId: string): Promise<(BoxReading & { kind: string }) | null> {
  const row = await prisma.instance.findUnique({ where: { id: instanceId }, select: BOX_SELECT });
  if (!row) return null;
  const [r] = await readings([row]);
  return { ...r, kind: row.kind };
}

/** The user's ready boxes with a connected agent: where a spawn could go instead. */
export async function userBoxReadings(userId: string): Promise<BoxReading[]> {
  const rows = await prisma.instance.findMany({ where: { userId, status: 'ready' }, select: BOX_SELECT });
  return readings(rows.filter(r => isProjectAgentConnected({ userId, instanceId: r.id })));
}

/** Spawned agents of the user that have not ended (a failed spawn never ran). */
/** A parked spawn's CLI is stopped: it holds no memory and no running slot. */
// Also what the admin spawn-limits card counts (services/admin/spawnLimitsQueries.ts).
export const RUNNING_SPAWN_WHERE = { endedAt: null, parkedAt: null, state: { not: 'failed' } };
const runningWhere = (userId: string) => ({ userId, ...RUNNING_SPAWN_WHERE });

export async function usageCounts(
  userId: string,
  parent: { projectId: string; workstream: string } | null,
  parentDepth: number,
): Promise<UsageCounts & { openHere: number | null }> {
  const now = Date.now();
  const [openHere, spawnsLastHour, running] = await Promise.all([
    parent
      // Within a day as well: a child that never reports must not hold its parent's slot for good.
      ? prisma.agentSpawn.count({ where: {
        userId, parentProjectId: parent.projectId, parentWorkstream: parent.workstream,
        state: { in: OPEN_STATES }, endedAt: null, createdAt: { gte: new Date(now - 24 * HOUR_MS) },
      } })
      : Promise.resolve(null),
    prisma.agentSpawn.count({ where: { userId, createdAt: { gte: new Date(now - HOUR_MS) } } }),
    prisma.agentSpawn.count({ where: runningWhere(userId) }),
  ]);
  return { parentDepth, openChildren: openHere ?? 0, openHere, spawnsLastHour, running };
}

/**
 * The budget: limits, usage, the target box, and the hints those imply.
 * `box` is the box the caller is on (list_spawns, spawn_budget) or the one
 * a spawn targets.
 */
export async function buildBudget(
  user: FlagUser & { id: string; unixUsername: string },
  parent: { projectId: string; workstream: string } | null,
  parentDepth: number,
  boxId: string | null,
  now: number = Date.now(),
): Promise<Budget> {
  const box = boxId ? await boxReading(boxId) : null;
  const limits = await spawnLimitsFor(user, box ? { id: box.id, name: box.name, kind: box.kind } : null);
  const counts = await usageCounts(user.id, parent, parentDepth);
  const live = await prisma.agentSpawn.findMany({
    where: runningWhere(user.id),
    select: { childProjectName: true, childWorkstream: true, childInstanceId: true, provider: true, state: true, reportedAt: true },
    take: 200,
  });
  const finishedRunning = live.filter(s => s.state === 'done' && s.reportedAt && now - s.reportedAt.getTime() > FINISHED_IDLE_MS).length;
  const throttled = new Set<string>();
  for (const s of live) {
    const st = getStatus(tmux.sessionName(user.unixUsername, s.childProjectName, 'agent', s.childWorkstream), s.childInstanceId);
    if (st.rateLimited && now - st.updatedAt.getTime() < THROTTLE_WINDOW_MS) throttled.add(s.provider);
  }
  const used = { depth: parentDepth, openHere: counts.openHere, lastHour: counts.spawnsLastHour, running: counts.running };
  return {
    limits,
    used,
    box: box ? {
      id: box.id, name: box.name, memUsedPct: box.memUsedPct, diskUsedPct: box.diskUsedPct, load1: box.load1,
      cores: box.cores, liveAgents: box.liveAgents, sampledAt: box.sampledAt, capacity: limits.boxCapacity,
    } : null,
    finishedRunning,
    hints: spawnHints({ limits, used, box, throttledProviders: [...throttled].sort(), finishedRunning, now }),
  };
}
