import type { SpawnNode, SpawnTreeView } from '../services/api';

/**
 * Replay and the timeline: each node's state at a moment, rebuilt from the tree's events.
 * Pure, so the page only moves a playhead.
 */

/** A pane's status over time; unknown before its first status event, never guessed. */
export type PaneTone = 'working' | 'waiting' | 'idle' | 'off' | 'unknown' | 'parked' | 'ended';

export interface Segment { from: number; to: number; tone: PaneTone }
export interface Mark { at: number; kind: 'reported' | 'adopted' | 'orphaned'; reason: string | null }
export interface Lane { id: string; created: number; segments: Segment[]; marks: Mark[] }

type Event = SpawnTreeView['events'][number];

const STATUS_TONE: Record<string, PaneTone> = { working: 'working', waiting: 'waiting', idle: 'idle', not_running: 'off' };

function eventsBySpawn(view: Pick<SpawnTreeView, 'events'>): Map<string, Event[]> {
  const out = new Map<string, Event[]>();
  for (const e of view.events) {
    if (!e.spawnId) continue;
    const list = out.get(e.spawnId) ?? [];
    list.push(e);
    out.set(e.spawnId, list);
  }
  for (const list of out.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/** The replay's span: the first spawn to the last event, or to now while anything is still open. */
export function replaySpan(view: Pick<SpawnTreeView, 'createdAt' | 'events' | 'at' | 'nodes'>): { start: number; end: number } {
  const start = Date.parse(view.createdAt);
  // A failed spawn never ends (no endedAt), but nothing more happens to it.
  const open = view.nodes.some(n => !n.endedAt && !n.retiredAt && n.state !== 'failed');
  const last = view.events.reduce((m, e) => Math.max(m, Date.parse(e.at)), start);
  return { start, end: open ? Math.max(last, Date.parse(view.at)) : last };
}

/** One lane per node, in the tree's order: pane status segments and marks, up to `end`. */
export function buildLanes(view: Pick<SpawnTreeView, 'nodes' | 'events'>, end: number): Lane[] {
  const by = eventsBySpawn(view);
  return view.nodes.map(n => {
    const created = Date.parse(n.createdAt);
    const segments: Segment[] = [];
    const marks: Mark[] = [];
    let tone = 'unknown' as PaneTone;
    let since = created;
    // Retired and failed are final. Ended is not: a resume relaunches an ended spawn's pane.
    let closed = false;
    const to = (next: PaneTone, at: number) => {
      if (next === tone) return;
      // An ended stretch is a gap in the lane, not a segment.
      if (at > since && tone !== 'ended') segments.push({ from: since, to: at, tone });
      tone = next;
      since = Math.max(since, at);
    };
    for (const e of by.get(n.id) ?? []) {
      const at = Date.parse(e.at);
      if (at > end || closed) break;
      switch (e.kind) {
        case 'status': if (tone !== 'parked' && tone !== 'ended') to(STATUS_TONE[e.reason ?? ''] ?? 'unknown', at); break;
        case 'parked': to('parked', at); break;
        case 'resumed': to('unknown', at); break;
        case 'ended': to('ended', at); break;
        case 'retired': case 'failed': to('ended', at); closed = true; break;
        case 'reported': case 'adopted': case 'orphaned': marks.push({ at, kind: e.kind, reason: e.reason }); break;
        default: break;
      }
    }
    if (tone !== 'ended' && end > since) segments.push({ from: since, to: end, tone });
    return { id: n.id, created, segments, marks };
  });
}

const STATUS_OF: Record<PaneTone, string> = {
  working: 'working', waiting: 'waiting', idle: 'idle', off: 'not_running', unknown: 'unknown', parked: 'not_running', ended: 'not_running',
};

/**
 * The tree as it stood at `t`: nodes created by then, each with the pane
 * status, state, lifecycle, foster and orphaning its events give at `t`.
 * Positions are not here: the page lays out the whole tree once.
 */
export function snapshotAt(view: SpawnTreeView, t: number): SpawnTreeView {
  const by = eventsBySpawn(view);
  const iso = (ms: number) => new Date(ms).toISOString();
  const nodes: SpawnNode[] = [];
  for (const n of view.nodes) {
    if (Date.parse(n.createdAt) > t) continue;
    let pane: PaneTone = 'unknown';
    let state = 'running';
    let reportedAt: number | null = null;
    let parkedAt: number | null = null, endedAt: number | null = null, retiredAt: number | null = null;
    let foster: SpawnNode['foster'] = null;
    let orphanedAt: number | null = null;
    for (const e of by.get(n.id) ?? []) {
      const at = Date.parse(e.at);
      if (at > t) break;
      switch (e.kind) {
        // As in buildLanes: a parked or ended pane is stopped, whatever a late status says.
        case 'status': if (pane !== 'parked' && pane !== 'ended') pane = STATUS_TONE[e.reason ?? ''] ?? 'unknown'; break;
        case 'reported': state = e.reason ?? state; reportedAt = at; break;
        // Park stops the pane (parkSpawn sets not_running); a resume clears the end too, as resumeSpawn does.
        case 'parked': parkedAt = at; pane = 'parked'; break;
        case 'resumed': parkedAt = null; endedAt = null; pane = 'unknown'; break;
        case 'ended': endedAt = at; pane = 'ended'; break;
        case 'retired': retiredAt = at; pane = 'ended'; break;
        case 'failed': state = 'failed'; pane = 'ended'; break;
        case 'adopted':
          foster = e.parentProjectId ? { projectId: e.parentProjectId, workstream: e.parentWorkstream ?? 'main', by: e.reason, at: e.at } : foster;
          orphanedAt = null;
          break;
        // Its foster went away too: spawnView shows an orphan with no foster.
        case 'orphaned': orphanedAt = at; foster = null; break;
        default: break;
      }
    }
    nodes.push({
      ...n,
      state,
      child: { ...n.child, status: STATUS_OF[pane] },
      reportedAt: reportedAt === null ? null : iso(reportedAt),
      // Its words as of then: the report it holds now if that one was in by t, else none.
      report: n.report && reportedAt !== null && n.reportedAt && Date.parse(n.reportedAt) <= t ? n.report : null,
      parkedAt: parkedAt === null ? null : iso(parkedAt),
      endedAt: endedAt === null ? null : iso(endedAt),
      retiredAt: retiredAt === null ? null : iso(retiredAt),
      foster,
      orphanedAt: orphanedAt === null ? null : iso(orphanedAt),
    });
  }
  return { ...view, nodes, at: iso(t) };
}

/** Times real time. 1000× plays a day-long tree in about a minute and a half; 10000× a week's session in about a minute. */
export const REPLAY_SPEEDS = [1, 10, 60, 100, 1000, 10000] as const;

/** Longest stretch of wall time one step counts, so a tab back from the background doesn't leap. */
export const MAX_STEP_MS = 1000;

/**
 * The playhead after one step: advanced by the wall time that really passed
 * since the last step (not the timer's nominal interval, which a busy page
 * overruns), times the speed, and stopped at the end.
 */
export function advancePlayhead(t: number, elapsedMs: number, speed: number, end: number): { t: number; done: boolean } {
  const next = t + Math.min(Math.max(0, elapsedMs), MAX_STEP_MS) * speed;
  return next >= end ? { t: end, done: true } : { t: next, done: false };
}

/** "+1h 05m" from the start, for the scrubber. */
export function offsetLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `+${h}h ${String(m).padStart(2, '0')}m` : `+${m}m ${String(sec).padStart(2, '0')}s`;
}
