// The tabs (chat/openItems.ts) as a store the sidebar, the explorer and the
// routes share: one per user, kept in localStorage, and followed across this
// browser's tabs through the storage event.
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  arrangeItems, dismissItem, duplicateItem, EMPTY_OPEN_ITEMS, newTabId, noteSent, openItem, openItemsKey, parseOpenItems, pickItem, placeUnplacedItems, reconcileItems,
  reorderItem, seedItems, serializeOpenItems, type ChatListing, type OpenItem, type OpenItemRef, type OpenItemsState,
} from './openItems';

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: { key: string; raw: string | null; state: OpenItemsState } | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function read(key: string): OpenItemsState {
  const raw = storage()?.getItem(key) ?? null;
  if (cache && cache.key === key && cache.raw === raw) return cache.state;
  const state = parseOpenItems(raw);
  cache = { key, raw, state };
  return state;
}

function write(key: string, next: OpenItemsState): void {
  const raw = serializeOpenItems(next);
  try { storage()?.setItem(key, raw); } catch { /* full or blocked: this tab still updates */ }
  cache = { key, raw, state: next };
  for (const l of listeners) l();
}

function update(key: string, fn: (s: OpenItemsState) => OpenItemsState): void {
  const prev = read(key);
  const next = fn(prev);
  if (next !== prev) write(key, next);
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key == null || e.key.startsWith('termag.chat.openItems.')) l(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
}

export interface OpenItemsApi {
  state: OpenItemsState;
  /** A route showing `ref` in tab `tab` (a new tab when no tab has that id), or in the first tab showing it, else a new one. Moves nothing. */
  open: (ref: OpenItemRef, tab: string | null) => void;
  /** `ref` picked from an explorer, recents or a chat link, from tab `current` (openItems.pickItem); returns the tab to show it in. */
  /** `chatSpace`: a picked agent's own space, so another space's agent gets its own tab (openItems.ts pickItem). */
  /** `openedIn`: the space it was picked in, null for No space's explorer (OpenItem.openedIn). */
  pick: (ref: OpenItemRef, current: string | null, chatSpace?: string | null, openedIn?: string | null) => string;
  /** A new tab, on top, showing `ref`, opened from `openedIn` (OpenItem.openedIn); returns its id. */
  openNew: (ref: OpenItemRef, openedIn?: string | null) => string;
  /** A copy of tab `id` just below it; returns the copy's id. */
  duplicate: (id: string) => string;
  /** Closes tab `id`, or every tab in `id`. */
  dismiss: (id: string | readonly string[]) => void;
  /** Moves tab `id` to `toIndex` among `group`, one group's tab ids in their shown order. */
  reorder: (group: readonly string[], id: string, toIndex: number) => void;
  /** Puts `group`'s tabs (one group's ids) in `order`, the same ids rearranged. */
  arrange: (group: readonly string[], order: readonly string[]) => void;
  /** The person sent the session a message, which puts its tabs on top of their spaces. */
  noteSent: (ref: { projectId: string; workstream: string }) => void;
  seed: (chats: ReadonlyArray<{ projectId: string; workstream: string; lastActiveAt: number | null }>) => void;
  reconcile: (liveChats: ReadonlySet<string>) => void;
  /** Places tabs from before `openedIn` on chats in no space of their own (openItems.placeUnplacedItems). */
  place: (listingOf: (item: Extract<OpenItem, { kind: 'chat' }>) => ChatListing | undefined) => void;
}

// React state rather than useSyncExternalStore: a store update always renders
// synchronously, so a write would commit a frame ahead of the navigation that
// goes with it, which react-router renders as a transition. Held in state, a
// write made inside startTransition joins the navigation and they commit together.
function useStoreState(key: string | null): OpenItemsState {
  const [held, setHeld] = useState(() => ({ key, state: key ? read(key) : EMPTY_OPEN_ITEMS }));
  useLayoutEffect(() => {
    const sync = () => setHeld(h => {
      const state = key ? read(key) : EMPTY_OPEN_ITEMS;
      return h.key === key && h.state === state ? h : { key, state };
    });
    sync();
    return subscribe(sync);
  }, [key]);
  return held.key === key ? held.state : key ? read(key) : EMPTY_OPEN_ITEMS;
}

export function useOpenItems(userId: string | null | undefined): OpenItemsApi {
  const key = userId ? openItemsKey(userId) : null;
  const state = useStoreState(key);
  const open = useCallback((ref: OpenItemRef, tab: string | null) => { if (key) update(key, s => openItem(s, ref, tab, Date.now()).state); }, [key]);
  const pick = useCallback((ref: OpenItemRef, current: string | null, chatSpace?: string | null, openedIn?: string | null) => {
    if (!key) return newTabId();
    let id = '';
    update(key, s => { const r = pickItem(s, ref, current, Date.now(), newTabId, chatSpace, openedIn); id = r.id; return r.state; });
    return id;
  }, [key]);
  const openNew = useCallback((ref: OpenItemRef, openedIn?: string | null) => {
    const id = newTabId();
    if (key) update(key, s => openItem(s, ref, id, Date.now(), newTabId, openedIn).state);
    return id;
  }, [key]);
  const duplicate = useCallback((id: string) => {
    const copy = newTabId();
    if (key) update(key, s => duplicateItem(s, id, copy, Date.now()));
    return copy;
  }, [key]);
  const dismiss = useCallback((id: string | readonly string[]) => { if (key) update(key, s => dismissItem(s, id)); }, [key]);
  const reorder = useCallback((group: readonly string[], id: string, to: number) => { if (key) update(key, s => reorderItem(s, group, id, to)); }, [key]);
  const arrange = useCallback((group: readonly string[], order: readonly string[]) => { if (key) update(key, s => arrangeItems(s, group, order)); }, [key]);
  const sent = useCallback((ref: { projectId: string; workstream: string }) => { if (key) update(key, s => noteSent(s, ref, Date.now())); }, [key]);
  const seed = useCallback((chats: Parameters<OpenItemsApi['seed']>[0]) => { if (key) update(key, s => seedItems(s, chats, Date.now())); }, [key]);
  const reconcile = useCallback((live: ReadonlySet<string>) => { if (key) update(key, s => reconcileItems(s, live, Date.now())); }, [key]);
  const place = useCallback((listingOf: Parameters<OpenItemsApi['place']>[0]) => { if (key) update(key, s => placeUnplacedItems(s, listingOf)); }, [key]);
  return useMemo(
    () => ({ state, open, pick, openNew, duplicate, dismiss, reorder, arrange, noteSent: sent, seed, reconcile, place }),
    [state, open, pick, openNew, duplicate, dismiss, reorder, arrange, sent, seed, reconcile, place],
  );
}

/**
 * Every open of a tab's route records it, moving nothing: in the tab the route names, else the first showing it, else a new tab.
 * A layout effect, so a route the tabs don't know yet (a direct load, back) is recorded before the first paint.
 */
export function useOpenOnRoute(api: OpenItemsApi, ref: OpenItemRef | null, tab: string | null): void {
  const k = ref ? JSON.stringify(ref) : '';
  useLayoutEffect(() => {
    if (ref) api.open(ref, tab);
  }, [k, tab, api.open]);
}
