// The ⌘K palette's list: every selectable thing in
// display order, so ↑/↓ walk all of it. Pure so the ordering is testable.
import type { InboxRow } from '../mobile/inbox';
import type { PaneSearchHit, PaneSearchResult } from '../services/api';
import { STATUS_LABEL, type AgentStatusValue } from '../types';

export type PaletteItem =
  | { kind: 'row'; row: InboxRow }
  | { kind: 'cta'; q: string }
  | { kind: 'hit'; hit: PaneSearchHit; q: string }
  | { kind: 'recent-query'; q: string };

export interface PaletteInput {
  /** The trimmed query. */
  q: string;
  history: string[];
  recent: InboxRow[];
  /** Sessions matching the query (searchRows). */
  hits: InboxRow[];
  /** The query the pane search last ran for, if any. */
  paneQuery: string | null;
  /** That search's result, once done. */
  paneResult: PaneSearchResult | null;
}

/**
 * Empty query: recent searches, then recent sessions. Otherwise: the matching
 * sessions, then the pane-text hits for this query, or — before a pane search
 * has run for it — the "Search pane text for …" item (2+ characters, as the
 * route requires).
 */
export function paletteItems({ q, history, recent, hits, paneQuery, paneResult }: PaletteInput): PaletteItem[] {
  if (!q) {
    return [...history.map(h => ({ kind: 'recent-query' as const, q: h })), ...recent.map(row => ({ kind: 'row' as const, row }))];
  }
  const out: PaletteItem[] = hits.map(row => ({ kind: 'row' as const, row }));
  if (paneQuery === q && paneResult) out.push(...paneResult.hits.map(hit => ({ kind: 'hit' as const, hit, q })));
  else if (paneQuery !== q && q.length >= 2) out.push({ kind: 'cta', q });
  return out;
}

/** Keep a highlight inside a list that shrank under it. */
export function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(i, length - 1));
}

/** A pane hit's status for its glyph; the field is a wide string, so only own keys count. */
export function hitStatus(status: string): AgentStatusValue {
  return Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? (status as AgentStatusValue) : 'not_running';
}
