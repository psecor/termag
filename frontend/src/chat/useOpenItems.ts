// The tabs (chat/openItems.ts) as a store the sidebar, the explorer and the
// routes share: one per user, kept in localStorage, and followed across this
// browser's tabs through the storage event.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  dismissItem, duplicateItem, EMPTY_OPEN_ITEMS, newTabId, openItem, openItemsKey, parseOpenItems, reconcileItems, reorderItem, seedItems,
  serializeOpenItems, type OpenItemRef, type OpenItemsState,
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
  /** `ref` shown in tab `tab` (a new tab when no tab has that id), or in the first tab showing it, else a new one. */
  open: (ref: OpenItemRef, tab: string | null) => void;
  /** A copy of tab `id` just below it; returns the copy's id. */
  duplicate: (id: string) => string;
  dismiss: (id: string) => void;
  /** Moves tab `id` to `toIndex` among `group`, one group's tab ids in their shown order. */
  reorder: (group: readonly string[], id: string, toIndex: number) => void;
  seed: (chats: ReadonlyArray<{ projectId: string; workstream: string; lastActiveAt: number | null }>) => void;
  reconcile: (liveChats: ReadonlySet<string>) => void;
}

export function useOpenItems(userId: string | null | undefined): OpenItemsApi {
  const key = userId ? openItemsKey(userId) : null;
  const state = useSyncExternalStore(subscribe, () => (key ? read(key) : EMPTY_OPEN_ITEMS));
  const open = useCallback((ref: OpenItemRef, tab: string | null) => { if (key) update(key, s => openItem(s, ref, tab, Date.now()).state); }, [key]);
  const duplicate = useCallback((id: string) => {
    const copy = newTabId();
    if (key) update(key, s => duplicateItem(s, id, copy, Date.now()));
    return copy;
  }, [key]);
  const dismiss = useCallback((id: string) => { if (key) update(key, s => dismissItem(s, id)); }, [key]);
  const reorder = useCallback((group: readonly string[], id: string, to: number) => { if (key) update(key, s => reorderItem(s, group, id, to)); }, [key]);
  const seed = useCallback((chats: Parameters<OpenItemsApi['seed']>[0]) => { if (key) update(key, s => seedItems(s, chats, Date.now())); }, [key]);
  const reconcile = useCallback((live: ReadonlySet<string>) => { if (key) update(key, s => reconcileItems(s, live, Date.now())); }, [key]);
  return useMemo(() => ({ state, open, duplicate, dismiss, reorder, seed, reconcile }), [state, open, duplicate, dismiss, reorder, seed, reconcile]);
}

/** Every open of a tab's route records it: in the tab the route names, else the first showing it, else a new tab on top. */
export function useOpenOnRoute(api: OpenItemsApi, ref: OpenItemRef | null, tab: string | null): void {
  const k = ref ? JSON.stringify(ref) : '';
  useEffect(() => {
    if (ref) api.open(ref, tab);
  }, [k, tab, api.open]);
}
