import type { SpawnNode, SpawnTreeView } from '../services/api';
import { nodeTokenTotal } from './spawnUsage';
import { ORIGIN_ID } from './spawnNetwork';

/**
 * The radial layout: the root at
 * the center, each level on a ring, each subtree in a wedge sized by its leaf
 * count. Node area follows tokens; edge width follows how long the child ran.
 * Computed from the whole tree, so a replay never moves a node.
 */

export const RING = 140;
export const MIN_R = 10;
export const MAX_R = 28;
/** Room for the labels beside the outer ring. */
const MARGIN = 160;

/** `node` is null for the origin, which takes the center in a session's view. */
export interface RadialNode { id: string; x: number; y: number; r: number; angle: number; node: SpawnNode | null }
export interface RadialEdge { from: string; to: string; kind: 'spawn' | 'adopted'; width: number }
export interface RadialLayout {
  nodes: RadialNode[];
  edges: RadialEdge[];
  size: number;
  center: number;
  /** Fostered nodes whose foster is not drawn (the origin, or outside the tree): named on the node. */
  fosteredOutside: Set<string>;
}

const sessionOf = (projectId: string | null | undefined, workstream: string | null | undefined) => `${projectId ?? ''}\u0000${workstream ?? 'main'}`;

type TreeEvent = SpawnTreeView['events'][number];
const STARTS = new Set(['launched', 'resumed']);
const STOPS = new Set(['parked', 'ended', 'retired', 'failed']);

/**
 * Seconds its pane actually ran, up to `now`: from each launch or resume to
 * the next park, end, retire or fail. A resume clears the row's stamps, so
 * the events are the record; without them (older trees) the stamps are used.
 * A failed spawn has no stamp but stops all the same.
 */
export function runSeconds(n: Pick<SpawnNode, 'launchedAt' | 'endedAt' | 'parkedAt' | 'retiredAt' | 'state'>, now: number, events: TreeEvent[] = []): number {
  const mine = events.filter(e => STARTS.has(e.kind) || STOPS.has(e.kind)).map(e => ({ kind: e.kind, at: Date.parse(e.at) })).filter(e => e.at <= now).sort((a, b) => a.at - b.at);
  if (mine.some(e => STARTS.has(e.kind))) {
    let total = 0, from: number | null = null;
    for (const e of mine) {
      if (STARTS.has(e.kind)) { if (from === null) from = e.at; }
      else if (from !== null) { total += e.at - from; from = null; }
    }
    if (from !== null) total += now - from;
    return Math.max(0, total / 1000);
  }
  if (!n.launchedAt || n.state === 'failed') return 0;
  const stops = [n.endedAt, n.parkedAt, n.retiredAt].filter((d): d is string => !!d).map(Date.parse);
  return Math.max(0, ((stops.length ? Math.min(...stops) : now) - Date.parse(n.launchedAt)) / 1000);
}

/**
 * `scale` is the tree that sizes are normalized over: the whole tree during a
 * replay, so a node appearing later grows the drawing without rescaling the
 * nodes and branches already there.
 */
export function radialLayout(
  view: Pick<SpawnTreeView, 'rootId' | 'nodes' | 'at'> & Partial<Pick<SpawnTreeView, 'events' | 'scope' | 'origin'>>,
  scale: Pick<SpawnTreeView, 'nodes' | 'at'> & Partial<Pick<SpawnTreeView, 'events'>> = view,
): RadialLayout {
  const now = Date.parse(view.at);
  const ids = new Set(view.nodes.map(n => n.id));
  // A session's view puts the session itself at the center, its trees' roots on the first ring.
  const session = view.scope === 'session';
  const centerId = session ? ORIGIN_ID : view.rootId;
  // A top other than the root (its parent missing from the tree) hangs off the center, without an edge.
  const parentOf = (n: SpawnNode) => (n.parentId && ids.has(n.parentId) ? n.parentId : n.id === centerId ? null : centerId);
  const kids = new Map<string, SpawnNode[]>();
  for (const n of view.nodes) {
    const p = parentOf(n);
    if (!p) continue;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const leaves = new Map<string, number>();
  const count = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const c = (kids.get(id) ?? []).reduce((s, k) => s + count(k.id, seen), 0);
    const v = Math.max(1, c);
    leaves.set(id, v);
    return v;
  };
  const root = session ? null : view.nodes.find(n => n.id === view.rootId) ?? view.nodes[0];
  if (!session && !root) return { nodes: [], edges: [], size: 0, center: 0, fosteredOutside: new Set() };
  if (session && !view.nodes.length) return { nodes: [], edges: [], size: 0, center: 0, fosteredOutside: new Set() };
  const rootId = root ? root.id : ORIGIN_ID;
  count(rootId, new Set());

  const maxTokens = Math.max(1, ...scale.nodes.map(n => nodeTokenTotal(n) ?? 0));
  const radius = (n: SpawnNode) => MIN_R + (MAX_R - MIN_R) * Math.sqrt((nodeTokenTotal(n) ?? 0) / maxTokens);
  const depth = new Map<string, number>();
  const placed: Array<Omit<RadialNode, 'x' | 'y'> & { level: number }> = [];
  const place = (id: string, n: SpawnNode | null, level: number, a0: number, a1: number) => {
    if (depth.has(id)) return;
    depth.set(id, level);
    placed.push({ id, r: n ? radius(n) : MAX_R, angle: (a0 + a1) / 2, node: n, level });
    let a = a0;
    for (const k of kids.get(id) ?? []) {
      const span = ((a1 - a0) * (leaves.get(k.id) ?? 1)) / (leaves.get(id) ?? 1);
      place(k.id, k, level + 1, a, a + span);
      a += span;
    }
  };
  place(rootId, root, 0, 0, Math.PI * 2);
  const levels = Math.max(0, ...placed.map(p => p.level));
  const center = levels * RING + MARGIN;
  const nodes: RadialNode[] = placed.map(p => ({
    id: p.id, r: p.r, angle: p.angle, node: p.node,
    x: center + Math.cos(p.angle) * p.level * RING,
    y: center + Math.sin(p.angle) * p.level * RING,
  }));

  const scaleNow = Date.parse(scale.at);
  const eventsOf = (v: Partial<Pick<SpawnTreeView, 'events'>>) => {
    const m = new Map<string, TreeEvent[]>();
    for (const e of v.events ?? []) if (e.spawnId) m.set(e.spawnId, [...(m.get(e.spawnId) ?? []), e]);
    return m;
  };
  const scaleEvents = eventsOf(scale), viewEvents = scale === view ? scaleEvents : eventsOf(view);
  const maxRun = Math.max(1, ...scale.nodes.map(n => runSeconds(n, scaleNow, scaleEvents.get(n.id))));
  const width = (n: SpawnNode) => 1.5 + 4.5 * (runSeconds(n, now, viewEvents.get(n.id)) / maxRun);
  const bySession = new Map(view.nodes.filter(n => n.child.projectId).map(n => [sessionOf(n.child.projectId, n.child.workstream), n.id]));
  // At the center, the origin can be drawn as a foster too.
  if (session && view.origin) bySession.set(sessionOf(view.origin.projectId, view.origin.workstream), ORIGIN_ID);
  const edges: RadialEdge[] = [];
  const fosteredOutside = new Set<string>();
  for (const n of view.nodes) {
    if (n.parentId && ids.has(n.parentId)) edges.push({ from: n.parentId, to: n.id, kind: 'spawn', width: width(n) });
    // A tree's root, from the session at the center.
    else if (session && !n.parentId) edges.push({ from: ORIGIN_ID, to: n.id, kind: 'spawn', width: width(n) });
    if (n.foster && !n.orphanedAt) {
      const f = bySession.get(sessionOf(n.foster.projectId, n.foster.workstream));
      if (f && f !== n.id) edges.push({ from: f, to: n.id, kind: 'adopted', width: 1.5 });
      else fosteredOutside.add(n.id);
    }
  }
  return { nodes, edges, size: center * 2, center, fosteredOutside };
}

/** A root-like curve from the parent's ring out to the child's. */
export function radialPath(a: RadialNode, b: RadialNode, center: number, kind: 'spawn' | 'adopted'): string {
  if (kind === 'adopted') {
    // Bowed toward the center, so it reads apart from the spawn branches.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `M${a.x},${a.y} Q${(mx + center) / 2},${(my + center) / 2} ${b.x},${b.y}`;
  }
  const ra = Math.hypot(a.x - center, a.y - center);
  const rb = Math.hypot(b.x - center, b.y - center);
  const mid = (ra + rb) / 2;
  const c1 = { x: center + Math.cos(b.angle) * mid, y: center + Math.sin(b.angle) * mid };
  const c0 = ra === 0 ? { x: a.x, y: a.y } : { x: center + Math.cos(a.angle) * mid, y: center + Math.sin(a.angle) * mid };
  return `M${a.x},${a.y} C${c0.x},${c0.y} ${c1.x},${c1.y} ${b.x},${b.y}`;
}
