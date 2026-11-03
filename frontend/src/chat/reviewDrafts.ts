// A review session's card state: the findings the
// reviewer last returned, which ones the user ticked, the verdict picked, and
// the finding whose line Files changed shows. Kept per session in this
// browser, and shared by the card in the chat and the drafts in the side
// panel's Files changed, so a tick in one is a draft in the other.
import { useSyncExternalStore } from 'react';
import type { ReviewDecision, ReviewFinding, ReviewFindings } from './reviewCard';

export interface CardState {
  /** The round the card is about, and the reviewer's findings for it. */
  findings: ReviewFindings | null;
  ticks: Record<string, boolean>;
  decision: ReviewDecision | null;
  /** The finding Files changed shows, by id. */
  focus: string | null;
  /** When it was asked for: asking again for the same finding shows it again. */
  focusAt?: number;
  /** When its findings were first drawn. */
  registeredAt?: number;
  /** When the user last ticked, chose or clicked in it: Files changed works from the card last used. */
  touchedAt?: number;
  /** What was posted from this card, and when (until the rounds' own record has it). */
  posted: null | { event: ReviewDecision; comments: number; at: string; url: string | null };
}

const KEY = 'termag.reviews.cards';
const EMPTY: CardState = { findings: null, ticks: {}, decision: null, focus: null, posted: null };
type Store = Record<string, CardState>;

function parse(text: string | null): Store {
  try { return JSON.parse(text ?? '{}') as Store; } catch { return {}; }
}
const stored = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
// What was last read or written: another tab's write is seen by its text changing.
let raw: string | null = typeof localStorage === 'undefined' ? null : stored();
let store: Store = parse(raw);
const listeners = new Set<() => void>();
/** Reads what another tab wrote since, if anything; true when the cards changed. */
function reread(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const now = stored();
  if (now === raw) return false;
  raw = now;
  store = parse(now);
  return true;
}
// Another tab's ticks, verdict or focus show here as they're made: one listener for the page, which reads the cards
// once and tells every view (the card, Files changed), not one per view where only the first would see the change.
const onStorage = (e: StorageEvent) => { if ((e.key === null || e.key === KEY) && reread()) listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};

/**
 * A card's key: the session and round, and for a findings card the fence it was drawn from, so a second
 * ```review block in a round (a retry, two in one reply) has state of its own rather than taking the first's.
 */
export const cardKey = (projectId: string, workstream: string, round: number, fence?: string) =>
  // Trimmed: a block that's whole while it streams, then gains a newline before its closing fence, is the same card.
  `${projectId}|${workstream}|${round}${fence ? `|${fenceId(fence.trim())}` : ''}`;

/** A short, stable id for a fence's text (djb2). */
export function fenceId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function cardState(key: string): CardState {
  return store[key] ?? EMPTY;
}

const USES: ReadonlyArray<keyof CardState> = ['ticks', 'decision', 'focus', 'focusAt'];

export function updateCard(key: string, patch: Partial<CardState>): void {
  // What other tabs wrote since, first, so this write doesn't put back what they changed.
  const theirs = reread();
  // Ticks merge tick by tick: a caller passes the ones it changed, so another tab's on the same card stay.
  const base = cardState(key);
  const merged = { ...base, ...patch, ...(patch.ticks ? { ticks: { ...base.ticks, ...patch.ticks } } : {}) };
  if (JSON.stringify(merged) === JSON.stringify(cardState(key))) {
    if (theirs) listeners.forEach(fn => fn());
    return;
  }
  const next = USES.some(k => k in patch) ? { ...merged, touchedAt: Date.now() } : merged;
  store = { ...store, [key]: next };
  raw = JSON.stringify(store);
  try { localStorage.setItem(KEY, raw); } catch { /* not kept */ }
  listeners.forEach(fn => fn());
}

export function useCardState(key: string | null): CardState {
  return useSyncExternalStore(subscribe, () => (key ? cardState(key) : EMPTY));
}

/**
 * The card the side panel's Files changed works from (its drafts, the finding it shows): the one last used, so a
 * click or a tick in an older block shows there, else the one last drawn. On a tie (two blocks drawn in one flush)
 * the later block wins: the store keeps the order cards were first drawn in.
 */
export function useLatestCard(projectId: string, workstream: string): { key: string; state: CardState } | null {
  return useSyncExternalStore(subscribe, () => latestCard(projectId, workstream));
}
let latestMemo: { at: Store; id: string; value: { key: string; state: CardState } | null } | null = null;
export function latestCard(projectId: string, workstream: string): { key: string; state: CardState } | null {
  const id = `${projectId}|${workstream}|`;
  if (latestMemo && latestMemo.at === store && latestMemo.id === id) return latestMemo.value;
  let best: { key: string; state: CardState; round: number; at: number } | null = null;
  for (const [key, state] of Object.entries(store)) {
    if (!key.startsWith(id) || !state.findings) continue;
    const round = Number(key.slice(id.length).split('|')[0]);
    const at = Math.max(state.touchedAt ?? 0, state.registeredAt ?? 0);
    if (!best || at > best.at || (at === best.at && round >= best.round)) best = { key, state, round, at };
  }
  const value = best ? { key: best.key, state: best.state } : null;
  latestMemo = { at: store, id, value };
  return value;
}

/** Whether a finding is ticked: the user's tick, else the reviewer's suggestion. */
export function isTicked(state: CardState, f: ReviewFinding): boolean {
  return state.ticks[f.id] ?? f.ticked;
}
