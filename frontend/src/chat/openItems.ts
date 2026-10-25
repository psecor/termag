// The simple UI's tabs (simple-ui-side-panel-enabled): what the sidebar
// lists, grouped by space. A tab shows an agent session (a project
// workstream, in its box's space or the space it was opened in), a space
// file, or a new tab on a space (its recents, Files beside them). Kept per user in this
// browser's localStorage. A tab has its own id, so two can show the same
// thing, and what it shows can change: a file or agent picked in a tab's
// explorer replaces the tab's content. The order is the person's: a new tab
// goes on top of its space's stack, opening it again doesn't move it,
// dragging (or Alt+Up/Down) moves it within its space, and its menu closes
// it.
import { chatHref } from './simpleChat';

/** What a tab shows. `space` on a chat: the group it was opened in, while its box still reaches that space. */
export type OpenItemRef =
  | { kind: 'chat'; projectId: string; workstream: string; space?: string }
  | { kind: 'file'; space: string; path: string }
  | { kind: 'explorer'; space: string };

export type OpenItem = OpenItemRef & { id: string; openedAt: number };

export interface OpenItemsState {
  /** The first load seeded the list from the sessions that existed then. */
  seeded: boolean;
  /** In the person's order; a group's tabs keep their relative order. */
  items: OpenItem[];
}

export const OPEN_ITEMS_MAX = 50;
export const EMPTY_OPEN_ITEMS: OpenItemsState = { seeded: false, items: [] };

export function openItemsKey(userId: string): string {
  return `termag.chat.openItems.v1:${userId}`;
}

/** What a tab shows, as a key: two tabs on the same file share it. */
export function itemKey(ref: OpenItemRef): string {
  switch (ref.kind) {
    case 'chat': return `chat:${ref.projectId}|${ref.workstream}`;
    case 'file': return `file:${ref.space}:${ref.path}`;
    case 'explorer': return `explorer:${ref.space}`;
  }
}

const TAB_ID = /^[a-z0-9]{1,16}$/;

export function newTabId(): string {
  return Math.random().toString(36).slice(2, 10) || 't0';
}

function refOf(item: OpenItem): OpenItemRef {
  switch (item.kind) {
    case 'chat': return { kind: 'chat', projectId: item.projectId, workstream: item.workstream, ...(item.space ? { space: item.space } : {}) };
    case 'file': return { kind: 'file', space: item.space, path: item.path };
    case 'explorer': return { kind: 'explorer', space: item.space };
  }
}

/** Over the cap, the tabs opened longest ago go, never `keep`. */
function capped(items: OpenItem[], keep: string | null): OpenItem[] {
  if (items.length <= OPEN_ITEMS_MAX) return items;
  const drop = new Set(
    items.filter(i => i.id !== keep).sort((a, b) => a.openedAt - b.openedAt)
      .slice(0, items.length - OPEN_ITEMS_MAX).map(i => i.id),
  );
  return items.filter(i => !drop.has(i.id));
}

/** `prev` showing `ref` now: the same thing keeps its chat's space unless `ref` names one. */
function shown(prev: OpenItem, ref: OpenItemRef, now: number): OpenItem {
  if (itemKey(prev) !== itemKey(ref)) return { ...ref, id: prev.id, openedAt: now } as OpenItem;
  const space = ref.kind === 'chat' && ref.space ? ref.space : prev.kind === 'chat' ? prev.space : undefined;
  return { ...prev, openedAt: now, ...(prev.kind === 'chat' && space ? { space } : {}) } as OpenItem;
}

/**
 * A route opened `ref`, in tab `tab` when the route names one. A tab that
 * exists shows `ref` from now on, in its place; a tab id no tab has yet is
 * a new tab, on top. With no tab named, the first tab already showing `ref`
 * is the one (it doesn't move), else a new tab goes on top. Returns the
 * state and the tab that shows `ref`.
 */
export function openItem(
  state: OpenItemsState, ref: OpenItemRef, tab: string | null, now: number, makeId: () => string = newTabId,
): { state: OpenItemsState; id: string } {
  const at = tab ? state.items.findIndex(i => i.id === tab) : state.items.findIndex(i => itemKey(i) === itemKey(ref));
  if (at < 0) {
    const id = tab ?? makeId();
    return { state: { ...state, items: capped([{ ...ref, id, openedAt: now } as OpenItem, ...state.items], id) }, id };
  }
  const items = [...state.items];
  items[at] = shown(items[at], ref, now);
  return { state: { ...state, items }, id: items[at].id };
}

/** The tab a route shows: the one it names, else the first showing what it shows. */
export function activeTab(state: OpenItemsState, ref: OpenItemRef | null, tab: string | null): string | null {
  if (!ref) return null;
  if (tab && state.items.some(i => i.id === tab)) return tab;
  return state.items.find(i => itemKey(i) === itemKey(ref))?.id ?? null;
}

/** A copy of tab `id`, just below it, as tab `copyId`. */
export function duplicateItem(state: OpenItemsState, id: string, copyId: string, now: number): OpenItemsState {
  const at = state.items.findIndex(i => i.id === id);
  if (at < 0) return state;
  const items = [...state.items];
  items.splice(at + 1, 0, { ...refOf(items[at]), id: copyId, openedAt: now } as OpenItem);
  return { ...state, items: capped(items, copyId) };
}

export function dismissItem(state: OpenItemsState, id: string): OpenItemsState {
  return { ...state, items: state.items.filter(i => i.id !== id) };
}

/**
 * Moves tab `id` to `toIndex` among `group` (one group's tab ids, in their
 * shown order), leaving every other group's tabs where they are.
 */
export function reorderItem(state: OpenItemsState, group: readonly string[], id: string, toIndex: number): OpenItemsState {
  const from = group.indexOf(id);
  if (from < 0) return state;
  const to = Math.max(0, Math.min(group.length - 1, toIndex));
  if (to === from) return state;
  const order = [...group];
  order.splice(from, 1);
  order.splice(to, 0, id);
  const members = new Set(group);
  const byId = new Map(state.items.map(i => [i.id, i]));
  let n = 0;
  const items = state.items.map(i => (members.has(i.id) ? byId.get(order[n++])! : i));
  return { ...state, items };
}

/**
 * The first load: what was opened before, then a tab for every session that
 * exists, in the order given (most recent activity first), so turning the
 * flag on loses nobody's list. Later loads leave the list alone.
 */
export function seedItems(
  state: OpenItemsState,
  chats: ReadonlyArray<{ projectId: string; workstream: string; lastActiveAt: number | null }>,
  now: number,
  makeId: () => string = newTabId,
): OpenItemsState {
  if (state.seeded) return state;
  const have = new Set(state.items.map(i => itemKey(i)));
  const added: OpenItem[] = chats
    .filter(c => !have.has(itemKey({ kind: 'chat', ...c })))
    .map((c, i) => ({ kind: 'chat' as const, projectId: c.projectId, workstream: c.workstream, id: makeId(), openedAt: c.lastActiveAt ?? now - 1 - i }));
  return { seeded: true, items: capped([...state.items, ...added], null) };
}

/** A session opened this recently stays even when the project list doesn't have it yet (New session just made it). */
export const RECONCILE_GRACE_MS = 2 * 60_000;

/** Tabs on sessions that no longer exist (deleted or archived) close. Files and explorers stay. */
export function reconcileItems(state: OpenItemsState, liveChats: ReadonlySet<string>, now: number): OpenItemsState {
  const items = state.items.filter(i => i.kind !== 'chat' || liveChats.has(itemKey(i)) || now - i.openedAt < RECONCILE_GRACE_MS);
  return items.length === state.items.length ? state : { ...state, items };
}

function validItem(raw: unknown, fallbackId: string, ignoreId: boolean): OpenItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const at = typeof r.openedAt === 'number' && Number.isFinite(r.openedAt) ? r.openedAt : null;
  if (at == null) return null;
  const id = !ignoreId && typeof r.id === 'string' && TAB_ID.test(r.id) ? r.id : fallbackId;
  return validRef(r, id, at);
}

function validRef(r: Record<string, unknown>, id: string, at: number): OpenItem | null {
  if (r.kind === 'chat' && typeof r.projectId === 'string' && r.projectId && typeof r.workstream === 'string' && r.workstream) {
    return { kind: 'chat', projectId: r.projectId, workstream: r.workstream, id, openedAt: at, ...(typeof r.space === 'string' && r.space ? { space: r.space } : {}) };
  }
  if (r.kind === 'file' && typeof r.space === 'string' && r.space && typeof r.path === 'string' && r.path) {
    return { kind: 'file', space: r.space, path: r.path, id, openedAt: at };
  }
  if (r.kind === 'explorer' && typeof r.space === 'string' && r.space) return { kind: 'explorer', space: r.space, id, openedAt: at };
  return null;
}

/**
 * What storage holds, in its order, or the empty state for anything
 * unreadable. A version 1 list (no tab ids) gets ids by position, the same
 * in every browser tab until the next write stores them.
 */
export function parseOpenItems(raw: string | null): OpenItemsState {
  if (!raw) return EMPTY_OPEN_ITEMS;
  try {
    const data = JSON.parse(raw) as { v?: unknown; seeded?: unknown; items?: unknown };
    if ((data.v !== 1 && data.v !== 2) || !Array.isArray(data.items)) return EMPTY_OPEN_ITEMS;
    const v1 = data.v === 1;
    const items = data.items.map((r, i) => validItem(r, `m${i}`, v1)).filter((i): i is OpenItem => i != null);
    // Version 1 had one item per thing shown; version 2 may have two tabs on one.
    const seen = new Set<string>();
    const unique = items.filter(i => {
      const k = v1 ? itemKey(i) : i.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { seeded: data.seeded === true, items: capped(unique, null) };
  } catch {
    return EMPTY_OPEN_ITEMS;
  }
}

export function serializeOpenItems(state: OpenItemsState): string {
  return JSON.stringify({ v: 2, seeded: state.seeded, items: state.items });
}

/** A path segment decoded, or as-is when it isn't valid percent-encoding (a hand-typed lone `%`). */
function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** What a /chat route shows, or null for a route that is no tab's (Home, New session). */
export function itemForRoute(pathname: string, search: string): OpenItemRef | null {
  const chat = /^\/chat\/p\/([^/]+)\/?$/.exec(pathname);
  if (chat) {
    const ws = new URLSearchParams(search).get('ws') || 'main';
    return { kind: 'chat', projectId: decodeSegment(chat[1]), workstream: ws };
  }
  const explorer = /^\/chat\/files\/([^/]+)\/?$/.exec(pathname);
  if (explorer) return { kind: 'explorer', space: decodeSegment(explorer[1]) };
  const file = /^\/chat\/f\/([^/]+)\/(.+)$/.exec(pathname);
  if (file) return { kind: 'file', space: decodeSegment(file[1]), path: file[2].split('/').map(decodeSegment).join('/') };
  return null;
}

/** The tab a route names (`?tab=`), or null. */
export function tabForRoute(search: string): string | null {
  const tab = new URLSearchParams(search).get('tab');
  return tab && TAB_ID.test(tab) ? tab : null;
}

/** The route that shows `ref`, in tab `tab` when given. */
export function itemHref(ref: OpenItemRef, tab?: string | null): string {
  let href: string;
  switch (ref.kind) {
    case 'chat': href = chatHref(ref.projectId, ref.workstream); break;
    case 'file': href = `/chat/f/${encodeURIComponent(ref.space)}/${ref.path.split('/').map(encodeURIComponent).join('/')}`; break;
    case 'explorer': href = `/chat/files/${encodeURIComponent(ref.space)}`; break;
  }
  return tab ? `${href}${href.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tab)}` : href;
}

export interface OpenItemGroup { space: string | null; items: OpenItem[] }

/**
 * The space a session shows under: the one it was opened in while its box
 * reaches it, else its box's first. Until the index is `settled` for the
 * current boxes, a box it doesn't have yet keeps the session where it was.
 */
export function chatSpace(item: Extract<OpenItemRef, { kind: 'chat' }>, box: string | null, known: ReadonlySet<string>, index: ReadonlyMap<string, readonly string[]>, settled = true): string | null {
  if (!settled && box && !index.has(box) && item.space && known.has(item.space)) return item.space;
  const reach = box ? (index.get(box) ?? []).filter(s => known.has(s)) : [];
  if (item.space && reach.includes(item.space)) return item.space;
  return reach[0] ?? null;
}

/**
 * The sidebar's groups: one per space the user has, by name, each with its
 * tabs in the list's order, then "No space" (null) for sessions whose box
 * has none. `boxOf` is undefined for a session the project list doesn't
 * have, which is left out. Files and explorers of a space the user no longer
 * has are left out too. Spaces with nothing open still get a group, for
 * their +.
 */
export function groupOpenItems(
  items: readonly OpenItem[],
  spaces: readonly string[],
  boxOf: (item: Extract<OpenItemRef, { kind: 'chat' }>) => string | null | undefined,
  index: ReadonlyMap<string, readonly string[]>,
  settled = true,
): OpenItemGroup[] {
  const known = new Set(spaces);
  const groups = new Map<string, OpenItem[]>([...known].sort().map(s => [s, []]));
  const none: OpenItem[] = [];
  for (const item of items) {
    if (item.kind === 'chat') {
      const box = boxOf(item);
      if (box === undefined) continue;
      const space = chatSpace(item, box, known, index, settled);
      (space ? groups.get(space)! : none).push(item);
    } else if (known.has(item.space)) {
      groups.get(item.space)!.push(item);
    }
  }
  const out: OpenItemGroup[] = [...groups].map(([space, list]) => ({ space, items: list }));
  if (none.length) out.push({ space: null, items: none });
  return out;
}
