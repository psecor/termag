/**
 * The spawn sweeps, leader work every 10 s:
 *  - the nudge: when a delegate has reported and its
 *    parent's pane is idle, type one fixed line into the parent telling it to
 *    read the report;
 *  - every minute, the end: mark a spawn ended when
 *    its child's pane, workstream, project or box is gone, so "running" counts
 *    agents that exist; and every hour, the spawn_events retention.
 * The rules are nudgeDecision (services/agentSpawn.ts) and endDecision
 * (services/spawnLimits.ts); this file only gathers their inputs and acts.
 */
import { prisma } from '../db';
import { nudgeDecision, nudgeLine } from './agentSpawn';
import { recordSpawnEvent, sweepSpawnEvents } from './spawnEvents';
import { endDecision } from './spawnLimits';
import { buildGaugeSnapshot } from './spawnGaugeSnapshot';
import { setGaugeSnapshot, timedSweep } from './spawnMetrics';
import { isProjectAgentConnected, sendForProject, sendToInstanceAgent } from './agentRegistry';
import { lastHumanHeartbeat } from './humanActivity';
import { getStatus } from './status';
import * as tmux from './tmux';

const SWEEP_INTERVAL_MS = 10_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runSpawnNudgeTick(now: number = Date.now()): Promise<number> {
  const rows = await prisma.agentSpawn.findMany({
    where: {
      relationship: 'delegate',
      parentProjectId: { not: null },
      parentSession: { not: null },
      // Not yet nudged for its latest report (a report clears nudgedAt), so
      // delivered notices never crowd out new ones. Waiting rows age out: a
      // day after the report the decision is skip, which stamps them.
      nudgedAt: null,
      reportedAt: { not: null },
    },
    orderBy: { reportedAt: 'asc' },
    take: 500,
  });
  let nudged = 0;
  for (const row of rows) {
    const parent = await prisma.project.findFirst({
      where: { id: row.parentProjectId!, userId: row.userId, archived: false },
      select: { name: true, instanceId: true, user: { select: { unixUsername: true } } },
    });
    // Rebuilt rather than read back, so a renamed parent project is still found.
    const session = parent
      ? tmux.sessionName(parent.user.unixUsername, parent.name, (row.parentRole ?? 'agent') as Parameters<typeof tmux.sessionName>[2], row.parentWorkstream ?? 'main')
      : null;
    const host = { userId: row.userId, instanceId: parent?.instanceId ?? null };
    const decision = parent && session
      ? nudgeDecision({
        relationship: row.relationship,
        parentRole: row.parentRole,
        reportedAt: row.reportedAt,
        nudgedAt: row.nudgedAt,
        parentSession: session,
        parentStatus: getStatus(session, parent.instanceId).status,
        parentConnected: isProjectAgentConnected(host),
        humanLastTyped: lastHumanHeartbeat(parent.user.unixUsername, parent.name, parent.instanceId),
        now,
      })
      : 'skip';
    if (decision === 'wait') continue;
    // Claim first, so an overlapping process (or a slow tick) never types the line twice.
    const claimed = await prisma.agentSpawn.updateMany({
      where: { id: row.id, nudgedAt: row.nudgedAt },
      data: { nudgedAt: new Date(now) },
    });
    if (claimed.count !== 1 || decision === 'skip' || !session) continue;
    const child = row.childWorkstream === 'main' ? row.childProjectName : `${row.childProjectName}/${row.childWorkstream}`;
    try {
      await sendForProject(host, 'tmux-send-keys', { sessionName: session, keys: nudgeLine(child, row.state), withEnter: true, literal: true }, 5000);
      nudged++;
      console.log(`[SPAWN] nudged ${session}: ${child} reported ${row.state} (${row.id})`);
      await recordSpawnEvent({
        kind: 'nudged', spawnId: row.id, userId: row.userId, instanceId: parent?.instanceId ?? null,
        detail: { secondsAfterReport: row.reportedAt ? Math.round((now - row.reportedAt.getTime()) / 1000) : null },
      });
    } catch (err) {
      console.warn(`[SPAWN] nudge of ${session} failed (${row.id}):`, (err as Error).message);
    }
  }
  return nudged;
}

const END_PAGE = 500;

function endPage(cursor: string | undefined) {
  return prisma.agentSpawn.findMany({
    where: { endedAt: null, state: { not: 'failed' }, childProjectId: { not: null } },
    select: { id: true, userId: true, rootSpawnId: true, childProjectId: true, childProjectName: true, childWorkstream: true, childInstanceId: true, launchedAt: true, createdAt: true },
    orderBy: { id: 'asc' },
    take: END_PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Consecutive misses per spawn, in memory: a restart starts the count again, which only delays an end. */
const misses = new Map<string, number>();

export async function runSpawnEndTick(now: number = Date.now()): Promise<number> {
  // Every unended spawn, however old, in pages: one that ages out of a window
  // would count as running for good.
  const rows: Awaited<ReturnType<typeof endPage>> = [];
  for (let cursor: string | undefined; ;) {
    const page = await endPage(cursor);
    rows.push(...page);
    if (page.length < END_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  if (!rows.length) { misses.clear(); return 0; }
  const projects = new Map((await prisma.project.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.childProjectId!))] } },
    select: {
      id: true, name: true, archived: true, instanceId: true, userId: true,
      user: { select: { unixUsername: true } },
      instance: { select: { status: true } },
      workstreams: { where: { archived: false }, select: { name: true } },
    },
  })).map(p => [p.id, p]));
  // One tmux-list per connected box, shared by every spawn on it.
  const live = new Map<string, Promise<Set<string> | null>>();
  const sessionsOn = (userId: string, instanceId: string) => {
    if (!live.has(instanceId)) {
      live.set(instanceId, isProjectAgentConnected({ userId, instanceId })
        ? sendToInstanceAgent(instanceId, 'tmux-list', {}, 5000)
          .then(r => new Set(((r as { sessions?: unknown })?.sessions as string[] | undefined) ?? []))
          .catch(() => null)
        : Promise.resolve(null));
    }
    return live.get(instanceId)!;
  };
  let ended = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.id);
    const p = projects.get(row.childProjectId!) ?? null;
    const instanceId = p?.instanceId ?? row.childInstanceId;
    const set = p && instanceId ? await sessionsOn(row.userId, instanceId) : null;
    const session = p ? tmux.sessionName(p.user.unixUsername, p.name, 'agent', row.childWorkstream) : null;
    const decision = endDecision({
      project: p ? { archived: p.archived } : null,
      workstreamLive: row.childWorkstream === 'main' || !!p?.workstreams.some(w => w.name === row.childWorkstream),
      boxStatus: p?.instance?.status ?? null,
      boxConnected: set !== null,
      sessionLive: set && session ? set.has(session) : null,
      misses: misses.get(row.id) ?? 0,
      launched: !!row.launchedAt,
      ageMs: now - row.createdAt.getTime(),
    });
    if ('misses' in decision) {
      if (decision.misses) misses.set(row.id, decision.misses); else misses.delete(row.id);
      continue;
    }
    misses.delete(row.id);
    const done = await prisma.agentSpawn.updateMany({ where: { id: row.id, endedAt: null }, data: { endedAt: new Date(now) } });
    if (done.count !== 1) continue;
    ended++;
    console.log(`[SPAWN] ${row.childProjectName}/${row.childWorkstream} ended (${decision.end}, ${row.id})`);
    await recordSpawnEvent({
      kind: 'ended', spawnId: row.id, rootSpawnId: row.rootSpawnId, userId: row.userId, reason: decision.end, instanceId: instanceId ?? null,
      detail: { lifetimeSeconds: Math.round((now - row.createdAt.getTime()) / 1000) },
    });
  }
  for (const id of misses.keys()) if (!seen.has(id)) misses.delete(id);
  return ended;
}

/** Bumped by every stop: a snapshot built across a stop (a drain) is thrown away. */
let generation = 0;

/** The generation now: a tick takes it when it starts and hands it to refreshGaugeSnapshot. */
export function sweepGeneration(): number {
  return generation;
}

/**
 * Rebuild the gauges' snapshot for a tick that started in generation
 * `started`, unless the sweep was stopped since: a tick in flight when the
 * process starts draining (in its nudge or end work, or while this builds)
 * must not put back the snapshot the stop cleared, or both processes of an
 * overlapping deploy would report the gauges.
 */
export async function refreshGaugeSnapshot(started: number = generation): Promise<void> {
  if (started !== generation) return;
  const snapshot = await buildGaugeSnapshot();
  if (started === generation) setGaugeSnapshot(snapshot);
}

const END_EVERY_TICKS = 6;
const RETENTION_EVERY_TICKS = 360;
let ticks = 0;

export function startSpawnNudgeSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    const tick = ticks++;
    const gen = generation;
    timedSweep('nudge', () => runSpawnNudgeTick())
      .catch(err => console.error('[SPAWN] nudge sweep failed:', (err as Error).message))
      .then(() => (tick % END_EVERY_TICKS === 0 ? timedSweep('end', () => runSpawnEndTick()) : 0))
      .catch(err => console.error('[SPAWN] end sweep failed:', (err as Error).message))
      // The gauges' snapshot: leader work like this sweep, so a draining process reports none.
      .then(() => (tick % END_EVERY_TICKS === 0 ? timedSweep('gauges', () => refreshGaugeSnapshot(gen)) : undefined))
      .catch(err => console.error('[SPAWN] gauge snapshot failed:', (err as Error).message))
      .then(() => (tick % RETENTION_EVERY_TICKS === 0 ? sweepSpawnEvents() : 0))
      .catch(err => console.error('[SPAWN] event retention failed:', (err as Error).message))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopSpawnNudgeSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
  generation++;
  setGaugeSnapshot(null);
}
