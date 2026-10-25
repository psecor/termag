import type { SpawnNode, SpawnTreeView } from '../services/api';

/**
 * The network view's tidy layout: x is the depth, y the depth-first order the server already gives,
 * so the same tree is laid out the same way on every poll. The origin (the
 * session that started the root) is the first column when there is one.
 */

export const COL_W = 250;
export const ROW_H = 64;
export const NODE_W = 210;
export const NODE_H = 48;
export const PAD = 16;

/** How a node is drawn; the state is also in its label, so it never rests on color alone. */
export type NetworkTone = 'working' | 'waiting' | 'idle' | 'done' | 'failed' | 'parked' | 'ended';

export function networkTone(n: Pick<SpawnNode, 'state' | 'endedAt' | 'parkedAt' | 'retiredAt'> & { child: { status: string } }): NetworkTone {
  if (n.retiredAt || n.endedAt) return 'ended';
  if (n.parkedAt) return 'parked';
  if (n.state === 'failed') return 'failed';
  if (n.state === 'blocked' || n.state === 'needs_input') return 'waiting';
  if (n.child.status === 'working') return 'working';
  if (n.child.status === 'waiting') return 'waiting';
  if (n.state === 'done') return 'done';
  return 'idle';
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  /** null for the origin. */
  node: SpawnNode | null;
}

export interface NetworkEdge {
  from: string;
  to: string;
  /** spawn: parent to child; adopted: foster to the child it took (dashed). */
  kind: 'spawn' | 'adopted';
}

export interface NetworkLayout {
  nodes: PlacedNode[];
  edges: NetworkEdge[];
  width: number;
  height: number;
  /** Fostered nodes whose foster is not in this tree: named on the node instead. */
  fosteredOutside: Set<string>;
}

export const ORIGIN_ID = 'origin';
const sessionOf = (projectId: string | null | undefined, workstream: string | null | undefined) => `${projectId ?? ''}\u0000${workstream ?? 'main'}`;

export function tidyLayout(view: Pick<SpawnTreeView, 'rootId' | 'origin' | 'nodes'> & Partial<Pick<SpawnTreeView, 'rootIds'>>): NetworkLayout {
  const shift = view.origin ? 1 : 0;
  const placed: PlacedNode[] = [];
  if (view.origin) placed.push({ id: ORIGIN_ID, x: PAD, y: PAD, node: null });
  view.nodes.forEach((n, i) => placed.push({ id: n.id, x: PAD + (n.level + shift) * COL_W, y: PAD + i * ROW_H, node: n }));

  // Which node is which session, so a foster can be found in the tree.
  const bySession = new Map<string, string>();
  if (view.origin) bySession.set(sessionOf(view.origin.projectId, view.origin.workstream), ORIGIN_ID);
  for (const n of view.nodes) if (n.child.projectId) bySession.set(sessionOf(n.child.projectId, n.child.workstream), n.id);

  const edges: NetworkEdge[] = [];
  const fosteredOutside = new Set<string>();
  for (const n of view.nodes) {
    // Only a root came from the origin (each tree's, in a session's view): another top, its
    // parent missing from the tree, gets no edge.
    const isRoot = n.id === view.rootId || !!view.rootIds?.includes(n.id);
    const from = n.parentId ?? (view.origin && isRoot ? ORIGIN_ID : null);
    if (from) edges.push({ from, to: n.id, kind: 'spawn' });
    // A foster is drawn only while it holds the child: an orphan's foster went away.
    if (n.foster && !n.orphanedAt) {
      const f = bySession.get(sessionOf(n.foster.projectId, n.foster.workstream));
      if (f && f !== n.id) edges.push({ from: f, to: n.id, kind: 'adopted' });
      else fosteredOutside.add(n.id);
    }
  }
  const cols = Math.max(0, ...view.nodes.map(n => n.level)) + shift + 1;
  const rows = Math.max(view.nodes.length, view.origin ? 1 : 0);
  return {
    nodes: placed,
    edges,
    width: PAD * 2 + (cols - 1) * COL_W + NODE_W,
    height: PAD * 2 + Math.max(0, rows - 1) * ROW_H + NODE_H,
    fosteredOutside,
  };
}

/**
 * A curved link. A spawn edge runs from the parent's right edge to the
 * child's left. An adoption edge leaves the foster's bottom and comes in from
 * the left: a foster is an ancestor (above and to the left in a tidy tree), so
 * the drop clears the nodes in between instead of crossing them.
 */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, kind: 'spawn' | 'adopted' = 'spawn'): string {
  if (kind === 'adopted') {
    const x1 = a.x + 24, y1 = a.y + NODE_H, x2 = b.x, y2 = b.y + NODE_H / 2;
    return `M${x1},${y1} C${x1},${y2} ${Math.max(x1, x2 - 60)},${y2} ${x2},${y2}`;
  }
  const forward = b.x > a.x;
  const x1 = forward ? a.x + NODE_W : a.x + NODE_W / 2;
  const y1 = forward ? a.y + NODE_H / 2 : a.y + NODE_H;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return forward
    ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
    // A foster to the left of, or above, its adoptee: drop down, then curve in from the left.
    : `M${x1},${y1} C${x1},${y2} ${x2 - 40},${y2} ${x2},${y2}`;
}

/** "proj/ws" or "proj" for main. */
export function nodeLabel(n: Pick<SpawnNode, 'child'>): string {
  return n.child.workstream === 'main' ? n.child.projectName : `${n.child.projectName}/${n.child.workstream}`;
}

/** The task's first line. */
export function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim())?.trim() ?? '';
}

/** "12m", "1h 05m", "2d 3h". */
export function fmtDuration(seconds: number): string {
  if (seconds < 60) return '<1m';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The tree's sessions (its origin and every node), so a foster in the tree is named. */
export function treeSessions(view: Pick<SpawnTreeView, 'origin' | 'nodes' | 'fosters'>): Array<{ projectId: string; workstream: string; label: string }> {
  return [
    ...(view.fosters ?? []),
    ...(view.origin?.projectId ? [{ projectId: view.origin.projectId, workstream: view.origin.workstream, label: view.origin.label }] : []),
    ...view.nodes.filter(n => n.child.projectId).map(n => ({ projectId: n.child.projectId!, workstream: n.child.workstream, label: nodeLabel(n) })),
  ];
}

/** The dashboard's and list_spawns' link to a tree's network view. */
export function networkLink(rootId: string): string {
  return `/spawns/${encodeURIComponent(rootId)}`;
}

/** Every tree one session started, as one network. */
export function sessionNetworkLink(projectId: string, workstream: string): string {
  return `/spawns/session/${encodeURIComponent(projectId)}/${encodeURIComponent(workstream)}`;
}

/**
 * Only the newest request may land: `start()` returns a check that is true
 * while no later request has started (and nothing cancelled them all).
 */
export function latestOnly(): { start: () => () => boolean; cancel: () => void } {
  let n = 0;
  return {
    start: () => { const mine = ++n; return () => mine === n; },
    cancel: () => { n++; },
  };
}
