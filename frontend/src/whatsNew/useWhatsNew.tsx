// What's new for a button to show and open: whether the
// flag is on, each tab's entries for this person, what they've seen, and the
// dialog, loaded the first time it opens.
import React, { Suspense, lazy, useMemo, useState, useSyncExternalStore } from 'react';
import { FLAGS, useFlag, useOnFlags, type FlagKey } from '../flags';
import { SEEN_KEY, addSeen, localDay, parseSeen, tabEntries, unseenIds } from './view';
import { SURFACES, WHATS_NEW_ENTRIES, type Surface, type WhatsNewEntry } from './whatsNew';
import './whatsNew.css';

const WhatsNewDialog = lazy(() => import('./WhatsNewDialog'));

const ENTRY_FLAGS: FlagKey[] = [...new Set(WHATS_NEW_ENTRIES.flatMap(e => e.flags))];
const KNOWN_IDS = WHATS_NEW_ENTRIES.map(e => e.id);
const NOTHING_SEEN: ReadonlySet<string> = new Set();

export type Tabs = Record<Surface, WhatsNewEntry[]>;

// Seen state, in localStorage and shared by every button on the page: a tab
// opened in one place clears the dot on the others, and in other windows
// through the storage event.
const listeners = new Set<() => void>();
let cached: { raw: string | null; seen: ReadonlySet<string> } = { raw: null, seen: NOTHING_SEEN };

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function readSeen(): ReadonlySet<string> {
  let raw: string | null = null;
  try { raw = storage()?.getItem(SEEN_KEY) ?? null; } catch { /* storage blocked: nothing seen */ }
  if (raw !== cached.raw) cached = { raw, seen: parseSeen(raw) };
  return cached.seen;
}

function subscribeSeen(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => { if (e.key === SEEN_KEY) onChange(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(onChange); window.removeEventListener('storage', onStorage); };
}

/** Marks `ids` seen, keeping only the ids of entries that still exist. */
export function markSeen(ids: readonly string[]): void {
  const seen = readSeen();
  if (ids.every(id => seen.has(id))) return;
  try { storage()?.setItem(SEEN_KEY, addSeen(seen, ids, KNOWN_IDS)); } catch { return; /* full or blocked */ }
  listeners.forEach(l => l());
}

export function useWhatsNew(): { enabled: boolean; tabs: Tabs; seen: ReadonlySet<string> } {
  const enabled = useFlag(FLAGS.whatsNew, false);
  const onKey = [...useOnFlags(ENTRY_FLAGS)].sort().join(' ');
  const seen = useSyncExternalStore(subscribeSeen, readSeen, () => NOTHING_SEEN);
  const today = localDay();
  const tabs = useMemo(() => {
    const on = new Set(onKey.split(' '));
    return Object.fromEntries(SURFACES.map(s => [s, tabEntries(WHATS_NEW_ENTRIES, s, k => on.has(k), today)])) as Tabs;
  }, [onKey, today]);
  return { enabled, tabs, seen };
}

/**
 * For a What's new button in `surface`'s UI: whether to show it, how many of
 * that UI's entries are unseen (its dot), `open`, and the dialog to render
 * beside the button (null while closed).
 */
export function useWhatsNewDialog(surface: Surface): { enabled: boolean; unseen: number; open: () => void; dialog: React.ReactNode } {
  const { enabled, tabs, seen } = useWhatsNew();
  const [isOpen, setOpen] = useState(false);
  const dialog = enabled && isOpen
    ? <Suspense fallback={null}><WhatsNewDialog surface={surface} tabs={tabs} seen={seen} onClose={() => setOpen(false)} /></Suspense>
    : null;
  return { enabled, unseen: unseenIds(tabs[surface], seen).length, open: () => setOpen(true), dialog };
}

/** The button's accessible name: "What's new", and how many are unseen. */
export function whatsNewLabel(unseen: number): string {
  return unseen ? `What's new, ${unseen} unseen` : "What's new";
}
