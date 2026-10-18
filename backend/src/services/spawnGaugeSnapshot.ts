/**
 * The leader's minute snapshot behind the spawn and box gauges
 * (services/spawnMetrics.ts): spawned agents
 * running per user and box, finished ones still running, per-user limit use,
 * and each ready box's load against the limits the flag serves it.
 */
import { prisma } from '../db';
import { BOX_SELECT, readings, spawnLimitsFor } from './spawnBudget';
import { FINISHED_IDLE_MS, boxRefusal } from './spawnLimits';
import type { GaugeSnapshot } from './spawnMetrics';

const HOUR_MS = 60 * 60 * 1000;
const BOX_FRESH_MS = 30 * 60 * 1000;

const USER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

export async function buildGaugeSnapshot(now: number = Date.now()): Promise<GaugeSnapshot> {
  const [live, lastHour, boxRows] = await Promise.all([
    prisma.agentSpawn.findMany({
      where: { endedAt: null, state: { not: 'failed' } },
      select: { userId: true, childInstanceId: true, state: true, reportedAt: true },
      take: 10_000,
    }),
    prisma.agentSpawn.groupBy({ by: ['userId'], where: { createdAt: { gte: new Date(now - HOUR_MS) } }, _count: { _all: true } }),
    prisma.instance.findMany({ where: { status: 'ready', hostSampledAt: { gte: new Date(now - BOX_FRESH_MS) } }, select: BOX_SELECT }),
  ]);

  const running = new Map<string, { userId: string; instanceId: string | null; value: number }>();
  const finished = new Map<string, number>();
  const runningByUser = new Map<string, number>();
  for (const s of live) {
    const key = `${s.userId}|${s.childInstanceId ?? ''}`;
    const r = running.get(key) ?? { userId: s.userId, instanceId: s.childInstanceId, value: 0 };
    r.value++;
    running.set(key, r);
    runningByUser.set(s.userId, (runningByUser.get(s.userId) ?? 0) + 1);
    if (s.state === 'done' && s.reportedAt && now - s.reportedAt.getTime() > FINISHED_IDLE_MS) {
      finished.set(s.userId, (finished.get(s.userId) ?? 0) + 1);
    }
  }
  const hourByUser = new Map(lastHour.map(g => [g.userId, g._count._all]));

  // Users with anything to show, plus every box owner (for the box limits).
  const userIds = new Set<string>([...runningByUser.keys(), ...hourByUser.keys()]);
  for (const b of boxRows) if (b.userId) userIds.add(b.userId);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: USER_SELECT })).map(u => [u.id, u]));

  const limits: GaugeSnapshot['limits'] = [];
  for (const id of new Set([...runningByUser.keys(), ...hourByUser.keys()])) {
    const u = users.get(id);
    if (!u) continue;
    const l = await spawnLimitsFor(u, null);
    limits.push({ userId: id, limit: 'hour', used: hourByUser.get(id) ?? 0, value: l.perHour });
    limits.push({ userId: id, limit: 'running', used: runningByUser.get(id) ?? 0, value: l.maxConcurrentPerUser });
  }

  const boxes: GaugeSnapshot['boxes'] = [];
  for (const b of await readings(boxRows)) {
    const row = boxRows.find(r => r.id === b.id)!;
    const owner = row.userId ? users.get(row.userId) : undefined;
    // An unclaimed warm-pool box runs no one's agents: nothing to show.
    if (!owner) continue;
    const l = await spawnLimitsFor(owner, { id: row.id, name: row.name, kind: row.kind });
    boxes.push({
      instanceId: b.id,
      ownerId: row.userId,
      memoryUtilization: b.memUsedPct === null ? null : b.memUsedPct / 100,
      diskUtilization: b.diskUsedPct === null ? null : b.diskUsedPct / 100,
      loadPerCore: b.load1 !== null && b.cores ? Math.round((b.load1 / b.cores) * 100) / 100 : null,
      liveAgents: b.liveAgents,
      capacity: l.boxCapacity,
      hot: boxRefusal(b, l, now)?.reason === 'box_busy',
    });
  }

  return {
    running: [...running.values()],
    finishedRunning: [...finished].map(([userId, value]) => ({ userId, value })),
    limits,
    boxes,
  };
}
