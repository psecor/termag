// One way for a long list in the simple UI to show part of itself: its first
// `step` rows, then a "Show more" row (pages/chat/ShowMoreRow.tsx) that shows
// `step` more on each click and goes away once nothing is left. Only a reload
// takes a list back to its first `step`. Rows past the window are only
// hidden, never removed, and a row
// `keep` names (the open tab) shows wherever it is. How far a list is open
// lasts for the page, not across a reload. A row is whatever the list counts
// as one: a tab, or a tree's top-level row with everything nested under it,
// so a parent and its children are never split.
import { useCallback, useMemo, useState } from 'react';

export const INCREMENTAL_STEP = 10;

export interface IncrementalList<T> {
  /** The rows shown, in their order. */
  visible: T[];
  /** How many rows are past the window; the "Show more" row shows while there are any. */
  hidden: number;
  showMore: () => void;
  /** Opens the window to at least `n` rows (a row moved into it from past it keeps the row it displaced on screen). */
  showAtLeast: (n: number) => void;
  step: number;
}

/** `rows` with the first `shown` of them showing, and any later row `keep` says must show. */
export function incrementalWindow<T>(
  rows: readonly T[], shown: number, keep?: (row: T) => boolean,
): Pick<IncrementalList<T>, 'visible' | 'hidden'> {
  const visible = rows.filter((row, i) => i < shown || (keep?.(row) ?? false));
  return { visible, hidden: rows.length - visible.length };
}

/**
 * A list's whole order after the row `id` moves to place `to` among `shown`
 * (what is on screen, in order), with moves counted on screen rather than in
 * the whole list: the rows shown, rearranged, then the hidden ones in their
 * order. A kept row shown past the window joins the rows before the hidden
 * ones, so a window of `shown.length` shows exactly what was shown, and no
 * row goes into the hidden range, or comes out of it, by a move.
 */
export function moveShown<T>(all: readonly T[], shown: readonly T[], id: T, to: number): T[] {
  const order = shown.filter(x => x !== id);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
  const on = new Set(shown);
  return [...order, ...all.filter(x => !on.has(x))];
}

/**
 * Windows for several lists at once, each by its `key` (a space): for a list
 * drawn in a loop, where a hook per list can't be. Each starts at `step`.
 */
export function useIncrementalWindows(step = INCREMENTAL_STEP): <T>(key: string, rows: readonly T[], keep?: (row: T) => boolean) => IncrementalList<T> {
  const [open, setOpen] = useState<ReadonlyMap<string, number>>(() => new Map());
  const set = useCallback((key: string, n: number) => setOpen(m => new Map(m).set(key, n)), []);
  return useCallback(<T,>(key: string, rows: readonly T[], keep?: (row: T) => boolean): IncrementalList<T> => {
    const shown = open.get(key) ?? step;
    return {
      ...incrementalWindow(rows, shown, keep),
      showMore: () => set(key, shown + step),
      showAtLeast: (n: number) => { if (n > shown) set(key, n); },
      step,
    };
  }, [open, step, set]);
}

/** One list's window: `useIncrementalList(rows, { step: 10, keep })`. */
export function useIncrementalList<T>(rows: readonly T[], { step = INCREMENTAL_STEP, keep }: { step?: number; keep?: (row: T) => boolean } = {}): IncrementalList<T> {
  const windowFor = useIncrementalWindows(step);
  return useMemo(() => windowFor('', rows, keep), [windowFor, rows, keep]);
}
