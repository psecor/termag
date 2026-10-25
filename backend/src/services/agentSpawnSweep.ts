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
import { NUDGE_GIVE_UP_MS, nudgeDecision, nudgeLines, type NudgeItem } from './agentSpawn';
import { recordSpawnEvent, sweepSpawnEvents } from './spawnEvents';
import { endDecision } from './spawnLimits';
import { buildGaugeSnapshot } from './spawnGaugeSnapshot';
import { runLifecycleTick } from './spawnLifecycleSweep';
import { runOrphanTick } from './spawnOrphanSweep';
import { noteStatusTransition, refreshWatchedSessions } from './spawnStatusLog';
import { effectiveParent } from './spawnOrphans';
import { setGaugeSnapshot, timedSweep } from './spawnMetrics';
import { isProjectAgentConnected, sendForProject, sendToInstanceAgent } from './agentRegistry';
import { lastHumanHeartbeat } from './humanActivity';
import { getStatus, setStatusTransitionCallback } from './status';
import * as tmux from './tmux';

const SWEEP_INTERVAL_MS = 10_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runSpawnNudgeTick(now: number = Date.now()): Promise<number> {
  const rows = await prisma.agentSpawn.findMany({
    where: {
      relationship: 'delegate',
      // Its own parent's pane, or the foster's that adopted it (a
      // browser-spawned root has only a foster); an orphan nobody adopted is
      // never nudged (its report waits on the dashboard).
      OR: [{ parentSession: { not: null } }, { fosterProjectId: { not: null } }],
      orphanedAt: null,
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
  // Keyed by box and session: a session name carries no box, and the same
  // project name may live on two boxes.
  const batches = new Map<string, { session: string; host: { userId: string; instanceId: string | null }; items: { row: typeof rows[number]; item: NudgeItem }[] }>();
  for (const row of rows) {
    // The foster when one adopted it.
    const to = effectiveParent(row);
    if (!to) continue;
    const parent = await prisma.project.findFirst({
      where: { id: to.projectId, userId: row.userId, archived: false },
      select: { name: true, instanceId: true, user: { select: { unixUsername: true } } },
    });
    // Rebuilt rather than read back, so a renamed parent project is still found.
    const session = parent
      ? tmux.sessionName(parent.user.unixUsername, parent.name, to.role as Parameters<typeof tmux.sessionName>[2], to.workstream)
      : null;
    const host = { userId: row.userId, instanceId: parent?.instanceId ?? null };
    const decision = parent && session
      ? nudgeDecision({
        relationship: row.relationship,
        parentRole: to.role,
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
    // A parent project that is gone leaves the report for the orphan sweep to
    // give a foster (or mark orphaned, which takes it off this list): stamping
    // it now would mean the foster is never told. Waiting rows age out as usual.
    if (!parent && row.reportedAt && now - row.reportedAt.getTime() <= NUDGE_GIVE_UP_MS) continue;
    // Claim first, so an overlapping process (or a slow tick) never types the line twice.
    const claimed = await prisma.agentSpawn.updateMany({
      where: { id: row.id, nudgedAt: row.nudgedAt },
      data: { nudgedAt: new Date(now) },
    });
    if (claimed.count !== 1 || decision === 'skip' || !session) continue;
    const child = row.childWorkstream === 'main' ? row.childProjectName : `${row.childProjectName}/${row.childWorkstream}`;
    // Typed after the loop, one line per pane (see nudgeLines).
    const key = `${host.instanceId ?? ''}\u0000${session}`;
    const batch = batches.get(key) ?? { session, host, items: [] };
    batch.items.push({ row, item: { child, status: row.state, adopted: !!row.fosterProjectId } });
    batches.set(key, batch);
  }
  for (const { session, host, items } of batches.values()) {
    // Earlier sends in this tick took time: a pane that has left idle since its
    // decision gets its claims back, for a later tick to type.
    if (getStatus(session, host.instanceId).status !== 'idle') {
      await prisma.agentSpawn.updateMany({
        where: { id: { in: items.map(i => i.row.id) }, nudgedAt: new Date(now) },
        data: { nudgedAt: null },
      });
      continue;
    }
    try {
      await sendForProject(host, 'tmux-send-keys', { sessionName: session, keys: nudgeLines(items.map(i => i.item)), withEnter: true, literal: true }, 5000);
    } catch (err) {
      console.warn(`[SPAWN] nudge of ${session} failed (${items.map(i => i.row.id).join(', ')}):`, (err as Error).message);
      continue;
    }
    for (const { row, item } of items) {
      nudged++;
      console.log(`[SPAWN] nudged ${session}: ${item.child} reported ${item.status} (${row.id})`);
      await recordSpawnEvent({
        kind: 'nudged', spawnId: row.id, userId: row.userId, instanceId: host.instanceId,
        detail: { secondsAfterReport: row.reportedAt ? Math.round((now - row.reportedAt.getTime()) / 1000) : null, batched: items.length },
      }).catch(err => console.warn(`[SPAWN] nudged event for ${row.id} not recorded:`, (err as Error).message));
    }
  }
  return nudged;
}

const END_PAGE = 500;

function endPage(cursor: string | undefined) {
  return prisma.agentSpawn.findMany({
    where: { endedAt: null, state: { not: 'failed' }, childProjectId: { not: null } },
    select: { id: true, userId: true, rootSpawnId: true, childProjectId: true, childProjectName: true, childWorkstream: true, childInstanceId: true, launchedAt: true, createdAt: true, parkedAt: true },
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
      parked: !!row.parkedAt,
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

/** A step slower than this is logged; one still running past STUCK_MS is warned about while it runs (#452). */
const SLOW_STEP_MS = 5_000;
const STUCK_MS = 60_000;
/** The step running now, so a tick that finds the sweep still busy can say where it is. */
let current: { step: string; since: number; warned: boolean } | null = null;

function step<T>(name: Parameters<typeof timedSweep>[0] | 'watched' | 'retention', fn: () => Promise<T>): Promise<T> {
  const since = Date.now();
  current = { step: name, since, warned: false };
  const run = name === 'watched' || name === 'retention' ? fn() : timedSweep(name, fn);
  return run.finally(() => {
    const ms = Date.now() - since;
    if (ms >= SLOW_STEP_MS) console.warn(`[SPAWN] sweep step ${name} took ${(ms / 1000).toFixed(1)} s`);
    current = null;
  });
}

/** Tests only: what the sweep is doing now. */
export function sweepStepNow(): { step: string; since: number } | null {
  return current ? { step: current.step, since: current.since } : null;
}

export function startSpawnNudgeSweep(): void {
  if (timer) return;
  // Status history for the network view's replay: leader work, like the rest of this sweep.
  setStatusTransitionCallback(noteStatusTransition);
  timer = setInterval(() => {
    if (running) {
      // Every later step, the nudge included, waits on this one: say so once, while it is happening.
      if (current && !current.warned && Date.now() - current.since >= STUCK_MS) {
        current.warned = true;
        console.warn(`[SPAWN] sweep step ${current.step} still running after ${Math.round((Date.now() - current.since) / 1000)} s; the rest of the sweep waits on it`);
      }
      return;
    }
    running = true;
    const tick = ticks++;
    const gen = generation;
    step('nudge', () => runSpawnNudgeTick())
      .catch(err => console.error('[SPAWN] nudge sweep failed:', (err as Error).message))
      .then(() => (tick % END_EVERY_TICKS === 0 ? step('end', () => runSpawnEndTick()) : 0))
      .catch(err => console.error('[SPAWN] end sweep failed:', (err as Error).message))
      // Park and retire, behind spawn-lifecycle-enabled.
      .then(() => (tick % END_EVERY_TICKS === 0 && gen === generation ? step('lifecycle', () => runLifecycleTick()) : undefined))
      .catch(err => console.error('[SPAWN] lifecycle sweep failed:', (err as Error).message))
      // Foster parents and the orphan home, behind the same flag.
      .then(() => (tick % END_EVERY_TICKS === 0 && gen === generation ? step('orphans', () => runOrphanTick()) : undefined))
      .catch(err => console.error('[SPAWN] orphan sweep failed:', (err as Error).message))
      // The gauges' snapshot: leader work like this sweep, so a draining process reports none.
      .then(() => (tick % END_EVERY_TICKS === 0 ? step('gauges', () => refreshGaugeSnapshot(gen)) : undefined))
      .catch(err => console.error('[SPAWN] gauge snapshot failed:', (err as Error).message))
      .then(() => (tick % END_EVERY_TICKS === 0 && gen === generation ? step('watched', () => refreshWatchedSessions()) : 0))
      .catch(err => console.error('[SPAWN] status-history refresh failed:', (err as Error).message))
      .then(() => (tick % RETENTION_EVERY_TICKS === 0 ? step('retention', () => sweepSpawnEvents()) : 0))
      .catch(err => console.error('[SPAWN] event retention failed:', (err as Error).message))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopSpawnNudgeSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
  setStatusTransitionCallback(null);
  generation++;
  setGaugeSnapshot(null);
}
