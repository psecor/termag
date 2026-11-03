// Agent sessions as a tree in the simple UI's lists (the sidebar, the tabs):
// an ask thread's chat under the session that sent it, a spawned agent under
// the one that started it, the way a file sits in its
// folder. A parent can be folded; the fold is kept per browser. The space's
// explorer builds its own, sorted, tree from the same links (explorerAgents).
import type { SpawnLink } from './explorerAgents';

/** The one row of a session the links name: `${projectId}|${workstream}` (mobile/inbox.ts rowKey). */
const linkKey = (projectId: string, workstream: string) => `${projectId}|${workstream}`;

/** What an ask thread's chat row knows about the session that sent it (AgentThread.parentProjectId/parentWorkstream). */
export interface AskParented { projectId: string; workstream: string; askParent?: { projectId: string; workstream: string } | null }

/** A link per ask chat whose thread recorded who sent it. Older threads have none and stay at the top. */
export function askLinks(rows: readonly AskParented[]): SpawnLink[] {
  return rows.flatMap(r => (r.askParent
    ? [{ projectId: r.projectId, workstream: r.workstream, parentProjectId: r.askParent.projectId, parentWorkstream: r.askParent.workstream }]
    : []));
}

export interface TreeRow<T> {
  item: T;
  key: string | null;
  /** 0 at the top. */
  depth: number;
  /** The rows directly under this one, folded or not. */
  childCount: number;
  /** Folded with rows under it: those rows are not in the list; here instead, for counts. */
  hidden: T[];
}

/**
 * `items` with every child right under its parent. A subtree takes the place
 * of its first member in `items`, so the list's own order (the sidebar's
 * attention order, the person's tab order) still decides where it goes: an
 * ask that needs you lifts its parent with it. Siblings keep that order too.
 * A child is nested only when its parent is in `items` as well; a link loop
 * leaves its members at the top. `keyOf` is null for what is not a session
 * (a file tab). A folded row's descendants are left out, except on the way to
 * `reveal` (the open session), which is never hidden.
 */
export function nestInOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
  links: readonly SpawnLink[],
  folded: ReadonlySet<string> = new Set(),
  reveal: string | null = null,
): Array<TreeRow<T>> {
  const keys = items.map(keyOf);
  const present = new Set(keys.filter((k): k is string => k !== null));
  const parentOf = new Map<string, string>();
  for (const l of links) {
    const child = linkKey(l.projectId, l.workstream);
    const parent = linkKey(l.parentProjectId, l.parentWorkstream);
    if (child !== parent && present.has(child) && present.has(parent) && !parentOf.has(child)) parentOf.set(child, parent);
  }
  for (const k of [...parentOf.keys()]) {
    const seen = new Set([k]);
    for (let p = parentOf.get(k); p; p = parentOf.get(p)) {
      if (seen.has(p)) { parentOf.delete(k); break; }
      seen.add(p);
    }
  }
  const rootOf = (k: string): string => { let r = k; for (let p = parentOf.get(r); p; p = parentOf.get(r)) r = p; return r; };
  const children = new Map<string, number[]>();
  keys.forEach((k, i) => {
    const p = k ? parentOf.get(k) : undefined;
    if (p) children.set(p, [...(children.get(p) ?? []), i]);
  });
  const indexOf = new Map<string, number>();
  keys.forEach((k, i) => { if (k && !indexOf.has(k)) indexOf.set(k, i); });
  const onPath = new Set<string>();
  for (let p = reveal ? parentOf.get(reveal) : undefined; p; p = parentOf.get(p)) onPath.add(p);

  const out: Array<TreeRow<T>> = [];
  const emitted = new Set<number>();
  const below = (k: string): T[] => (children.get(k) ?? []).flatMap(i => [items[i], ...(keys[i] ? below(keys[i]!) : [])]);
  const emit = (i: number, depth: number) => {
    if (emitted.has(i)) return;
    emitted.add(i);
    const k = keys[i];
    const kids = k ? children.get(k) ?? [] : [];
    const shut = k !== null && kids.length > 0 && folded.has(k) && !onPath.has(k);
    out.push({ item: items[i], key: k, depth, childCount: kids.length, hidden: shut ? below(k) : [] });
    if (!shut) for (const c of kids) emit(c, depth + 1);
  };
  items.forEach((_, i) => {
    const k = keys[i];
    if (!k || !parentOf.has(k)) { emit(i, 0); return; }
    emit(indexOf.get(rootOf(k))!, 0);
  });
  return out;
}

/**
 * The tab ids past `max` in each space's group, with the tree counted the
 * way the list shows it (nestInOrder): a top-level tab and every tab nested
 * under it are one place toward `max`, and close together, so a child never
 * closes on its own. Places past `max` close from the bottom; the place
 * holding `keep` (the open tab) stays, taking the last place. "No space"
 * (space null) is not capped. The tree-aware form of the space cap's
 * `overSpaceCap(groups, keep, max)` (openItems.ts), with the same answer for
 * a group with no nesting.
 */
export function overCapByTree<T extends { id: string }>(
  groups: ReadonlyArray<{ space: string | null; items: readonly T[] }>,
  keep: string | null,
  keyOf: (item: T) => string | null,
  links: readonly SpawnLink[],
  max: number,
): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.space === null) continue;
    const places: T[][] = [];
    for (const n of nestInOrder(g.items, keyOf, links)) {
      if (n.depth === 0) places.push([n.item]);
      else places[places.length - 1].push(n.item);
    }
    if (places.length <= max) continue;
    const kept = places.findIndex(p => p.some(i => i.id === keep));
    const room = kept >= max ? max - 1 : max;
    places.forEach((p, n) => { if (n >= room && n !== kept) out.push(...p.map(i => i.id)); });
  }
  return out;
}

const FOLDED_KEY = 'termag.chat.foldedAgents';

/** The parents folded in this browser (row keys); unreadable storage is none. */
export function readFoldedAgents(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  try {
    const v = JSON.parse(storage?.getItem(FOLDED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

export function toggleFoldedAgent(folded: ReadonlySet<string>, key: string, storage: Pick<Storage, 'setItem'> | null): Set<string> {
  const next = new Set(folded);
  if (next.has(key)) next.delete(key); else next.add(key);
  try { storage?.setItem(FOLDED_KEY, JSON.stringify([...next])); } catch { /* full or blocked: this page still folds */ }
  return next;
}
