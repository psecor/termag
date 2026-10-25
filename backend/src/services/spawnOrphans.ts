/**
 * Orphaned spawns: when a child's parent
 * session goes away while the child still matters, someone else takes its
 * reports. Pure: the orphan sweep reads the rows and liveness, and acts.
 *
 *   effective parent  the foster if one adopted it, else the original parent
 *   adoption          the nearest living ancestor, else the user's orphan
 *                     home, else nobody (it gathers on the dashboard and in
 *                     the briefing until someone adopts it)
 */

export interface ParentRef {
  projectId: string;
  workstream: string;
  role: string;
}

export interface OrphanRow {
  state: string;
  retiredAt: Date | null;
  endedAt: Date | null;
  reportedAt: Date | null;
  nudgedAt: Date | null;
  parentProjectId: string | null;
  parentWorkstream: string | null;
  parentRole: string | null;
  fosterProjectId: string | null;
  fosterWorkstream: string | null;
  fosterRole: string | null;
}

/** Who gets this child's reports now: the foster, else the original parent, else nobody (spawned from the browser). */
export function effectiveParent(r: OrphanRow): ParentRef | null {
  if (r.fosterProjectId) return { projectId: r.fosterProjectId, workstream: r.fosterWorkstream ?? 'main', role: r.fosterRole ?? 'agent' };
  if (r.parentProjectId) return { projectId: r.parentProjectId, workstream: r.parentWorkstream ?? 'main', role: r.parentRole ?? 'agent' };
  return null;
}

const STILL_WORKING = new Set(['starting', 'running', 'blocked', 'needs_input']);

/**
 * Does it still need a parent? It is working or waiting on someone, or has a
 * report nobody was told about. An ended one (its pane or workstream gone)
 * works no more, whatever its last state says: only an unread report counts.
 */
export function needsParent(r: OrphanRow): boolean {
  if (r.retiredAt) return false;
  if (!r.endedAt && STILL_WORKING.has(r.state)) return true;
  return !!r.reportedAt && (!r.nudgedAt || r.nudgedAt < r.reportedAt);
}

export interface ParentState {
  /** The parent's project exists and is not archived. */
  projectLive: boolean;
  /** Its workstream exists and is not archived ('main' always does with its project). */
  workstreamLive: boolean;
  /** The parent is itself a spawned agent: that spawn has ended or been retired. */
  spawnGone: boolean;
  /** Its agent session is in its box's tmux-list; null when the box could not be asked. */
  sessionLive: boolean | null;
  /** Consecutive sweeps its session has been missing so far. */
  misses: number;
}

/** Minute sweeps a root's parent pane must be missing before it counts as gone (a person's agent restarts). */
export const PARENT_GONE_MISSES = 10;

/** Is the parent gone? `misses` is the count to carry to the next sweep. */
export function parentGone(p: ParentState): { gone: true } | { gone: false; misses: number } {
  if (!p.projectLive || !p.workstreamLive || p.spawnGone) return { gone: true };
  if (p.sessionLive === null) return { gone: false, misses: p.misses };
  if (p.sessionLive) return { gone: false, misses: 0 };
  return p.misses + 1 >= PARENT_GONE_MISSES ? { gone: true } : { gone: false, misses: p.misses + 1 };
}

export interface Candidate extends ParentRef {
  /** Alive right now: its project and workstream exist and its agent pane is in tmux. */
  alive: boolean;
}

export type Adoption =
  | ({ by: 'ancestor' } & ParentRef)
  | ({ by: 'home' } & ParentRef)
  | { by: 'none' };

/**
 * Who adopts an orphan: the nearest living ancestor (grandparent first, then
 * up), else the orphan home, else nobody. Never the child itself, nor the
 * parent that just went away.
 */
export function chooseAdopter(ancestors: Candidate[], home: Candidate | null, self: ParentRef | null): Adoption {
  const same = (a: ParentRef, b: ParentRef | null) => !!b && a.projectId === b.projectId && a.workstream === b.workstream;
  for (const a of ancestors) {
    if (a.alive && !same(a, self)) return { by: 'ancestor', projectId: a.projectId, workstream: a.workstream, role: a.role };
  }
  if (home && home.alive && !same(home, self)) return { by: 'home', projectId: home.projectId, workstream: home.workstream, role: 'agent' };
  return { by: 'none' };
}

/** The orphan-home setting as stored; null when unset or not the shape. */
export function parseOrphanHome(v: unknown): { projectId: string; workstream: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.projectId !== 'string' || !o.projectId) return null;
  const ws = typeof o.workstream === 'string' && o.workstream ? o.workstream : 'main';
  return { projectId: o.projectId, workstream: ws };
}
