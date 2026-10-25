/**
 * Status history for spawned agents: every status transition of a spawned child's agent pane is also a
 * spawn event (`kind = 'status'`, `reason` the new status), so the network
 * view can replay a tree. The live status map holds only the current value.
 *
 * The status write path calls noteStatusTransition for every session; it is
 * one Map lookup unless the session is a spawned child's. A spawn is watched
 * from the moment its row is written (watchSpawnedSession, from the spawn
 * route), so its first turn is logged; the minute spawn sweep rebuilds the set
 * as a backstop (renames, restarts, ends). That sweep can take minutes a pass
 * on a large fleet, so it must not be what starts the history.
 *
 * Best effort, as a replay feed: only the process running the spawn sweep
 * logs, so transitions a draining process handles during an overlapping
 * deploy are not logged, and a takeover's rehydrated statuses add no
 * baseline event. Replay shows a gap there, not a wrong state.
 */
import { prisma } from '../db';
import { recordSpawnEvent } from './spawnEvents';
import { statusKey } from './statusKey';
import * as tmux from './tmux';

interface Watched {
  spawnId: string;
  userId: string;
  rootSpawnId: string | null;
  instanceId: string | null;
  /** Its place in add order, so a refresh that started before it was added keeps it. */
  seq: number;
}

let watched = new Map<string, Watched>();
/** Orders adds and refreshes; a clock can't, two can share a millisecond. */
let seq = 0;

/** Far more than any user's running limit allows; a cap so a bad day cannot balloon the set. */
const MAX_WATCHED = 5000;

export function noteStatusTransition(sessionName: string, instanceId: string | null, from: string | undefined, to: string): void {
  if (from === to) return;
  const w = watched.get(statusKey(instanceId, sessionName));
  if (!w) return;
  void recordSpawnEvent({
    kind: 'status', spawnId: w.spawnId, rootSpawnId: w.rootSpawnId, userId: w.userId, instanceId: w.instanceId,
    reason: to, detail: from ? { from } : undefined,
  });
}

/** Watch a new spawn's agent pane at once, before its agent launches. */
export function watchSpawnedSession(s: { spawnId: string; userId: string; rootSpawnId: string | null; instanceId: string | null; session: string }): void {
  watched.set(statusKey(s.instanceId, s.session), { spawnId: s.spawnId, userId: s.userId, rootSpawnId: s.rootSpawnId, instanceId: s.instanceId, seq: ++seq });
}

/**
 * A launch into a spawned child's pane: its first launch (a project spawn's
 * row is only linked to its project just before that), a resume, a
 * relaunch, or reconnect reconstruction. Watch it again, whatever the last
 * refresh saw. Never throws.
 */
export async function watchLaunchedSpawn(k: { userId: string; projectId: string | null; workstream: string; session: string; instanceId: string | null }): Promise<void> {
  if (!k.projectId) return;
  try {
    const row = await prisma.agentSpawn.findFirst({
      where: { userId: k.userId, childProjectId: k.projectId, childWorkstream: k.workstream, retiredAt: null, state: { not: 'failed' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, rootSpawnId: true },
    });
    if (row) watchSpawnedSession({ spawnId: row.id, userId: k.userId, rootSpawnId: row.rootSpawnId, instanceId: k.instanceId, session: k.session });
  } catch (err) {
    console.warn(`[SPAWN] could not watch ${k.session} at launch:`, (err as Error).message);
  }
}

/** Rebuild the set of spawned children's agent panes: those not ended, retired or failed. */
export async function refreshWatchedSessions(): Promise<number> {
  const started = ++seq;
  const rows = await prisma.agentSpawn.findMany({
    where: { endedAt: null, retiredAt: null, state: { not: 'failed' }, childProjectId: { not: null } },
    select: { id: true, userId: true, rootSpawnId: true, childProjectId: true, childWorkstream: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_WATCHED,
  });
  const ids = [...new Set(rows.map(r => r.childProjectId!))];
  const projects = ids.length
    ? new Map((await prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, instanceId: true, user: { select: { unixUsername: true } } },
    })).map(p => [p.id, p]))
    : new Map();
  const next = new Map<string, Watched>();
  for (const r of rows) {
    const p = projects.get(r.childProjectId!);
    if (!p) continue;
    // Rebuilt from the project, not read back, so a renamed project is still matched.
    const session = tmux.sessionName(p.user.unixUsername, p.name, 'agent', r.childWorkstream);
    const key = statusKey(p.instanceId, session);
    if (!next.has(key)) next.set(key, { spawnId: r.id, userId: r.userId, rootSpawnId: r.rootSpawnId, instanceId: p.instanceId, seq: started });
  }
  // Spawned while this refresh was reading: its query may have missed them.
  for (const [key, w] of watched) if (w.seq > started && !next.has(key)) next.set(key, w);
  watched = next;
  return next.size;
}

/** Tests only. */
export function resetWatchedSessions(): void {
  watched = new Map();
}
