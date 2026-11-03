// The simple UI's tabs (simple-ui-side-panel-enabled): what the sidebar
// lists, grouped by space. A tab shows an agent session (a project
// workstream, in its own space: chat/chatSpaces.ts chatHomeSpace, or with
// none, the space its tab was opened from: OpenItem.openedIn), a
// space file, or a new tab on a space (its recents, Files beside them). Kept per user in this
// browser's localStorage. A tab has its own id, so two can show the same
// thing. The order is the person's, so it can differ between browsers: a
// new tab goes on top of its space, and so does a tab on each access (a
// file picked from an explorer, a new tab's recents or a link in a chat,
// and a message sent to an agent; pickItem, noteSent). Dragging (or
// Alt+Up/Down) moves a tab anywhere in its space, never to another, and it stays there until
// its next access. Going to a tab from the sidebar or a route moves nothing.
// There's no cap on how many tabs a person keeps: none closes for being old or
// far down. A long space shows its first rows and hides the rest behind Show
// more (chat/incrementalList.ts); only the person closes a tab, or its session
// going away does (reconcileItems).
import { chatHref } from './simpleChat';
import { parseSpaceFileLink, parseSpaceFolderLink } from '../utils/spaces';

/**
 * What a tab shows. A chat's group is its own space, fixed on the server when
 * it started, wherever it was opened from (lists from before kept the space a
 * chat was opened in as `space`, which is dropped). Only a chat with no space
 * of its own goes by its tab's `openedIn` (OpenItem).
 */
export type OpenItemRef =
  | { kind: 'chat'; projectId: string; workstream: string }
  | { kind: 'file'; space: string; path: string }
  | { kind: 'explorer'; space: string };

export type OpenItem = OpenItemRef & {
  id: string;
  openedAt: number;
  /**
   * A chat tab's: the space it was opened from (a space's explorer, its new
   * tab's recents), null when from No space's, unset when not known (a route,
   * the first load's seeding, a list from before). A chat in no space of its
   * own is in this space's group (groupOpenItems), so an ask thread fixed to
   * "No space" that a space's explorer lists stays under that space. Set when
   * the tab starts showing the chat, never by a later open from elsewhere.
   */
  openedIn?: string | null;
};

/**
 * The explorer of agents in no space (pages/chat/AgentsExplorer.tsx), for a
 * person with no spaces or spaces off, and beside an agent with no space: a
 * new tab on it is `{ kind: 'explorer', space: NO_SPACE_EXPLORER }`, at
 * /chat/agents, under No space. Not a valid space name, so no space has it.
 */
export const NO_SPACE_EXPLORER = '(none)';

export interface OpenItemsState {
  /** The first load seeded the list from the sessions that existed then. */
  seeded: boolean;
  /** In the person's order; a group's tabs keep their relative order. */
  items: OpenItem[];
}

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
    case 'chat': return { kind: 'chat', projectId: item.projectId, workstream: item.workstream };
    case 'file': return { kind: 'file', space: item.space, path: item.path };
    case 'explorer': return { kind: 'explorer', space: item.space };
  }
}

/** A new tab's item: a chat's records where it was opened from, when that is known. */
function newItem(ref: OpenItemRef, id: string, now: number, openedIn: string | null | undefined): OpenItem {
  return (ref.kind === 'chat' && openedIn !== undefined ? { ...ref, id, openedAt: now, openedIn } : { ...ref, id, openedAt: now }) as OpenItem;
}

/**
 * `prev` showing `ref` now: the same thing keeps its `openedAt` (when it was
 * last opened or accessed) and its `openedIn`; something else is new in the tab.
 */
function shown(prev: OpenItem, ref: OpenItemRef, now: number, openedIn?: string | null): OpenItem {
  if (itemKey(prev) !== itemKey(ref)) return newItem(ref, prev.id, now, openedIn);
  return prev;
}

/**
 * A route opened `ref`, in tab `tab` when the route names one. A tab that
 * exists shows `ref` from now on, in its place; a tab id no tab has yet is
 * a new tab, on top. With no tab named, the first tab already showing `ref`
 * is the one (it doesn't move), else a new tab goes on top. `openedIn` is
 * where a chat was opened from, for a tab that starts showing it (OpenItem).
 * Returns the state and the tab that shows `ref`.
 */
export function openItem(
  state: OpenItemsState, ref: OpenItemRef, tab: string | null, now: number, makeId: () => string = newTabId, openedIn?: string | null,
): { state: OpenItemsState; id: string } {
  const at = tab ? state.items.findIndex(i => i.id === tab) : state.items.findIndex(i => itemKey(i) === itemKey(ref));
  if (at < 0) {
    const id = tab ?? makeId();
    return { state: { ...state, items: [newItem(ref, id, now, openedIn), ...state.items] }, id };
  }
  const next = shown(state.items[at], ref, now, openedIn);
  if (JSON.stringify(next) === JSON.stringify(state.items[at])) return { state, id: next.id };
  const items = [...state.items];
  items[at] = next;
  return { state: { ...state, items }, id: next.id };
}

/** Tabs `ids` accessed at `now`: on top of their spaces, in the order they had. */
function toTop(items: OpenItem[], ids: ReadonlySet<string>, now: number): OpenItem[] {
  const moved = items.filter(i => ids.has(i.id)).map(i => ({ ...i, openedAt: now }));
  return [...moved, ...items.filter(i => !ids.has(i.id))];
}

/**
 * `ref` picked from an explorer, a new tab's recents or a link in a chat,
 * from tab `current`. The tab already showing it (`current` if it does,
 * else the first) is the one, and a file tab moves to the top of its space;
 * an agent's moves only when it is sent a message (noteSent). With none, a
 * new tab (`current` is one) shows it instead, on top, else a new tab on
 * top does. An agent of another space (`chatSpace`, its own) never takes a
 * space's new tab: it gets a tab of its own, in its own space. `openedIn` is
 * the space it was picked in (null: No space's explorer), which an agent in
 * no space of its own (`chatSpace` null) is grouped by; a tab already showing
 * the agent keeps its own. Returns the state and the tab to show it in.
 */
export function pickItem(
  state: OpenItemsState, ref: OpenItemRef, current: string | null, now: number, makeId: () => string = newTabId, chatSpace?: string | null,
  openedIn?: string | null,
): { state: OpenItemsState; id: string } {
  const key = itemKey(ref);
  const target = state.items.find(i => i.id === current && itemKey(i) === key) ?? state.items.find(i => itemKey(i) === key);
  if (target) {
    const items = state.items.map(i => (i === target ? shown(i, ref, now) : i));
    return { state: { ...state, items: ref.kind === 'file' ? toTop(items, new Set([target.id]), now) : items }, id: target.id };
  }
  const cur = current ? state.items.find(i => i.id === current) : undefined;
  if (cur?.kind === 'explorer' && (ref.kind !== 'chat' || chatSpace === undefined || (chatSpace ?? openedIn) === cur.space)) {
    const items = state.items.map(i => (i === cur ? shown(i, ref, now, openedIn) : i));
    return { state: { ...state, items: toTop(items, new Set([cur.id]), now) }, id: cur.id };
  }
  return openItem(state, ref, makeId(), now, newTabId, openedIn);
}

/** The person sent the agent session `ref` a message at `at`: its tabs go on top of their spaces. */
export function noteSent(state: OpenItemsState, ref: { projectId: string; workstream: string }, at: number): OpenItemsState {
  const key = itemKey({ kind: 'chat', ...ref });
  const ids = new Set(state.items.filter(i => itemKey(i) === key).map(i => i.id));
  return ids.size ? { ...state, items: toTop(state.items, ids, at) } : state;
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
  items.splice(at + 1, 0, newItem(refOf(items[at]), copyId, now, items[at].openedIn));
  return { ...state, items };
}

/** Closes tab `id`, or every tab in `id`: off the list only, the session or file itself stays. */
export function dismissItem(state: OpenItemsState, id: string | readonly string[]): OpenItemsState {
  const ids = new Set(typeof id === 'string' ? [id] : id);
  const items = state.items.filter(i => !ids.has(i.id));
  return items.length === state.items.length ? state : { ...state, items };
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
  return arrangeItems(state, group, order);
}

/**
 * Puts the tabs of `group` (one group's ids) in `order`, the same ids
 * rearranged, in the places the group's tabs hold, leaving every other
 * group's tabs where they are. Anything else in `order` is ignored.
 */
export function arrangeItems(state: OpenItemsState, group: readonly string[], order: readonly string[]): OpenItemsState {
  if (order.length !== group.length || order.some(id => !group.includes(id)) || order.every((id, i) => id === group[i])) return state;
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
  return { seeded: true, items: [...state.items, ...added] };
}

/** A session opened this recently stays even when the project list doesn't have it yet (New session just made it). */
export const RECONCILE_GRACE_MS = 2 * 60_000;

/** Tabs on sessions that no longer exist (deleted or archived) close. Files and explorers stay. */
export function reconcileItems(state: OpenItemsState, liveChats: ReadonlySet<string>, now: number): OpenItemsState {
  const items = state.items.filter(i => i.kind !== 'chat' || liveChats.has(itemKey(i)) || now - i.openedAt < RECONCILE_GRACE_MS);
  return items.length === state.items.length ? state : { ...state, items };
}

/** Where a chat tab's session is: its own space, and the spaces whose explorers list it (its box reaches them). */
export interface ChatListing { home: string | null; listedIn: readonly string[] }

/**
 * Places tabs from before `openedIn` (unset) on chats in no space of their
 * own, once: in the one space whose explorer lists the chat, else in No space
 * for good (null). `listingOf` is undefined for a chat not known yet, which
 * is left for a later pass, and a chat with a space of its own needs nothing.
 */
export function placeUnplacedItems(state: OpenItemsState, listingOf: (item: Extract<OpenItem, { kind: 'chat' }>) => ChatListing | undefined): OpenItemsState {
  let changed = false;
  const items = state.items.map(i => {
    if (i.kind !== 'chat' || i.openedIn !== undefined) return i;
    const at = listingOf(i);
    if (!at || at.home) return i;
    changed = true;
    return { ...i, openedIn: at.listedIn.length === 1 ? at.listedIn[0] : null };
  });
  return changed ? { ...state, items } : state;
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
    const openedIn = r.openedIn === null || (typeof r.openedIn === 'string' && r.openedIn) ? r.openedIn : undefined;
    return newItem({ kind: 'chat', projectId: r.projectId, workstream: r.workstream }, id, at, openedIn);
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
    return { seeded: data.seeded === true, items: unique };
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
  if (/^\/chat\/agents\/?$/.test(pathname)) return { kind: 'explorer', space: NO_SPACE_EXPLORER };
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
    case 'explorer': href = ref.space === NO_SPACE_EXPLORER ? '/chat/agents' : `/chat/files/${encodeURIComponent(ref.space)}`; break;
  }
  return tab ? `${href}${href.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tab)}` : href;
}

/**
 * A space's new tab with folder `dir` ('' for the root, else ending in `/`)
 * shown in its explorer (`?dir=`, ChatApp): where a link to a folder goes.
 */
export function folderHref(space: string, dir: string, tab?: string | null): string {
  return `${itemHref({ kind: 'explorer', space }, tab)}${tab ? '&' : '?'}dir=${encodeURIComponent(dir)}`;
}

/** The folder a route's `?dir=` names, ending in `/` ('' for the root); null for none, or for a path that isn't one. */
export function folderForRoute(search: string): string | null {
  const dir = new URLSearchParams(search).get('dir');
  if (dir == null || dir === '') return dir;
  const bare = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  if (bare.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  return `${bare}/`;
}

/**
 * What a space link in a reply opens in the app (ChatApp's SpaceFileLinks):
 * a file's link its file, a folder's (ending in `/`) its space's explorer
 * with `dir` shown. Null for any other link.
 */
export function spaceLinkTarget(href: string, origin: string, base: string): { ref: Extract<OpenItemRef, { space: string }>; dir?: string } | null {
  const folder = parseSpaceFolderLink(href, origin, base);
  if (folder) return { ref: { kind: 'explorer', space: folder.space }, dir: folder.dir };
  const file = parseSpaceFileLink(href, origin, base);
  return file ? { ref: { kind: 'file', ...file } } : null;
}

export interface OpenItemGroup { space: string | null; items: OpenItem[] }

/**
 * The sidebar's groups: one per space the user has, by name, each with its
 * tabs in the list's order, then "No space" (null) for sessions in none,
 * and new tabs on agents in no space. A session's group is its own space
 * (`spaceOf`, chat/chatSpaces.ts chatHomeSpace), however its tab was opened;
 * a session in no space of its own goes by its tab's `openedIn`, while the
 * user has that space; undefined for a session the project list doesn't have, which is left out.
 * Files and explorers of a space the user no longer has are left out too.
 * Spaces with nothing open still get a group, for their +.
 */
export function groupOpenItems(
  items: readonly OpenItem[],
  spaces: readonly string[],
  spaceOf: (item: Extract<OpenItemRef, { kind: 'chat' }>) => string | null | undefined,
): OpenItemGroup[] {
  const known = new Set(spaces);
  const groups = new Map<string, OpenItem[]>([...known].sort().map(s => [s, []]));
  const none: OpenItem[] = [];
  for (const item of items) {
    if (item.kind === 'chat') {
      const home = spaceOf(item);
      if (home === undefined) continue;
      const space = home ?? item.openedIn;
      (space && known.has(space) ? groups.get(space)! : none).push(item);
    } else if (known.has(item.space)) {
      groups.get(item.space)!.push(item);
    } else if (item.kind === 'explorer' && item.space === NO_SPACE_EXPLORER) {
      none.push(item);
    }
  }
  const out: OpenItemGroup[] = [...groups].map(([space, list]) => ({ space, items: list }));
  if (none.length) out.push({ space: null, items: none });
  return out;
}
