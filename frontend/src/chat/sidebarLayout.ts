// Where each session sits in the redesigned sidebar,
// before the groups (chat/sidebarGroups.ts projectGroups) take the rest:
// Pinned above everything, and Older, one shared bucket for what you haven't
// touched in a while, instead of a fold at the end of each project (#1733's).
// Older is decided by when you last touched a session, not by whether its box
// is up: a parked box doesn't mean you're done. Needs you, Working and Pinned
// never age out, nor does the session on screen. Shared sessions and an
// automation's runs aren't aged: they have sections of their own. A session
// moves with the asks and spawns under it, so a working ask keeps its parent
// where it is; a pinned ask goes to Pinned on its own, with what it started.
// Pure, so it's tested on its own.
import type { RowStateKind } from './rowState';
import type { SpawnLink } from './explorerAgents';

/** After how many days untouched a session moves to Older; 0 is never. A View option, 3 by default. */
export const OLDER_DAYS = [1, 3, 7, 0] as const;
export type OlderDays = typeof OLDER_DAYS[number];
export const DEFAULT_OLDER_DAYS: OlderDays = 3;

const DAY_MS = 86_400_000;

export interface LayoutRow {
  key: string;
  projectId: string;
  workstream: string;
  shared?: boolean;
  kind?: string;
}

export interface SidebarSplit<R> {
  /** Pinned sessions (and what they started), in pin order. */
  pinned: R[];
  /** Sessions untouched past the threshold, most recently touched first. */
  older: R[];
  /** Everything else, in the order given, for the groups. */
  rest: R[];
}

export interface SplitInput<R> {
  links: readonly SpawnLink[];
  stateOf: (row: R) => RowStateKind;
  /**
   * How recently it was active, in ms (chat/sidebarSort.ts activityOf: its start, its last turn, its status, never a
   * box parking); null when unknown. Not its Workstream.lastActiveAt alone, which is set when it's made and never moves.
   */
  touchedAt: (row: R) => number | null;
  now: number;
  olderDays: OlderDays;
  /** Its pin's place (oldest pin first), or null when it isn't pinned. */
  pinOrder: (row: R) => number | null;
  /** The session on screen: it never moves to Older. */
  openKey?: string | null;
}

const busy = (k: RowStateKind) => k === 'working' || k === 'approval' || k === 'unread' || k === 'error';
const key = (projectId: string, workstream: string) => `${projectId}|${workstream}`;

export function splitSidebar<R extends LayoutRow>(rows: readonly R[], input: SplitInput<R>): SidebarSplit<R> {
  const { links, stateOf, touchedAt, now, olderDays, pinOrder, openKey = null } = input;
  const byKey = new Map(rows.map(r => [r.key, r]));
  const order = new Map(rows.map((r, i) => [r.key, i]));
  const parentOf = new Map<string, string>();
  for (const l of links) {
    const child = key(l.projectId, l.workstream);
    const parent = key(l.parentProjectId, l.parentWorkstream);
    if (child !== parent && byKey.has(child) && byKey.has(parent) && !parentOf.has(child)) parentOf.set(child, parent);
  }
  // The sessions above a row, nearest first, through those listed; a loop ends the walk.
  const ancestors = (k: string): string[] => {
    const out: string[] = [];
    const seen = new Set([k]);
    for (let p = parentOf.get(k); p && !seen.has(p); p = parentOf.get(p)) { seen.add(p); out.push(p); }
    return out;
  };
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  // A session and what it started, in the order given; `skip` are already placed.
  const subtree = (top: string, skip: ReadonlySet<string>): R[] => {
    const out: R[] = [];
    const walk = (k: string, seen: Set<string>) => {
      if (seen.has(k) || skip.has(k)) return;
      seen.add(k);
      out.push(byKey.get(k)!);
      for (const c of [...(childrenOf.get(k) ?? [])].sort((x, y) => order.get(x)! - order.get(y)!)) walk(c, seen);
    };
    walk(top, new Set());
    return out;
  };

  // Pinned: each pinned session with what it started, a pinned ask too (it leaves its parent), in pin order.
  const pinned: R[] = [];
  const moved = new Set<string>();
  const pinTops = rows.filter(r => pinOrder(r) !== null && !ancestors(r.key).some(a => pinOrder(byKey.get(a)!) !== null))
    .sort((x, y) => pinOrder(x)! - pinOrder(y)!);
  for (const top of pinTops) for (const r of subtree(top.key, moved)) { pinned.push(r); moved.add(r.key); }

  // Older: the rest, a session with what it started, when none of them is busy, open or touched lately.
  const cutoff = olderDays > 0 ? now - olderDays * DAY_MS : -Infinity;
  const tops = rows.filter(r => !moved.has(r.key) && !ancestors(r.key).some(a => !moved.has(a)));
  const olderTrees: Array<{ at: number; rows: R[] }> = [];
  for (const top of tops) {
    if (olderDays === 0 || top.shared || top.kind === 'automation') continue;
    const members = subtree(top.key, moved);
    if (members.some(m => busy(stateOf(m)) || m.key === openKey)) continue;
    const touched = Math.max(...members.map(m => touchedAt(m) ?? -Infinity));
    if (touched < cutoff) olderTrees.push({ at: touched, rows: members });
  }
  const older = olderTrees.sort((x, y) => y.at - x.at).flatMap(t => t.rows);
  for (const r of older) moved.add(r.key);
  return { pinned, older, rest: rows.filter(r => !moved.has(r.key)) };
}

/**
 * The bottom row's sections, in its order; each opens at the end of the list (README §3), all folded to start.
 * Not running is one only under Group by Status, where it's a section (the others are always there when they have any).
 */
export const DOCK_SECTIONS = ['shared', 'automations', 'not-running', 'older', 'archived'] as const;
export type DockSection = typeof DOCK_SECTIONS[number];

/** Which bottom-row sections are open, kept per browser. */
export const SIDEBAR_DOCK_KEY = 'termag.chat.sidebarDock';

/** The kept open sections; anything else, or garbage, is none. */
export function parseDock(raw: string | null): ReadonlySet<DockSection> {
  let list: unknown = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { /* garbage: none open */ }
  return new Set(Array.isArray(list) ? DOCK_SECTIONS.filter(d => list.includes(d)) : []);
}

export function readDock(storage: Pick<Storage, 'getItem'> | null): ReadonlySet<DockSection> {
  try { return parseDock(storage?.getItem(SIDEBAR_DOCK_KEY) ?? null); } catch { return new Set(); }
}

/** Opens a closed section or closes an open one, and keeps the answer. */
export function toggleDock(open: ReadonlySet<DockSection>, d: DockSection, storage: Pick<Storage, 'setItem'> | null): ReadonlySet<DockSection> {
  const next = new Set(open);
  if (next.has(d)) next.delete(d); else next.add(d);
  try { storage?.setItem(SIDEBAR_DOCK_KEY, JSON.stringify(DOCK_SECTIONS.filter(x => next.has(x)))); } catch { /* private mode: this page only */ }
  return next;
}

/** Group by Status's Not running section (sectionsByStatus's key for it), which the bottom row holds while it's folded. */
export const NOT_RUNNING_SECTION = 'status:off';

/** A Status grouping's section (Group by Status in the one list); Needs you is its own, above. */
export interface StatusSection<R> { key: string; name: string; tone: 'working' | 'idle' | 'off'; rows: R[] }

const STATUS_SECTIONS: ReadonlyArray<{ key: string; name: string; tone: StatusSection<unknown>['tone']; kinds: readonly RowStateKind[] }> = [
  // Named as chat/sidebarGroups.ts STATUS_GROUPS; their folds are the Projects view's own (a Tabs view fold isn't carried over).
  { key: 'working', name: 'Working', tone: 'working', kinds: ['working'] },
  { key: 'recent', name: 'Idle', tone: 'idle', kinds: ['done'] },
  { key: 'off', name: 'Not running', tone: 'off', kinds: ['off'] },
];

/**
 * Working, Idle and Not running, in that order, each most recently touched
 * first, leaving out what's empty. Rows that need you are left to Needs you.
 */
export function sectionsByStatus<R>(rows: readonly R[], stateOf: (row: R) => RowStateKind, touchedAt: (row: R) => number | null): Array<StatusSection<R>> {
  const at = (r: R) => touchedAt(r) ?? -Infinity;
  return STATUS_SECTIONS.flatMap(s => {
    const list = rows.filter(r => s.kinds.includes(stateOf(r))).sort((a, b) => at(b) - at(a));
    return list.length ? [{ key: `status:${s.key}`, name: s.name, tone: s.tone, rows: list }] : [];
  });
}
