// The ⌘K palette's list: every selectable thing in
// display order, so ↑/↓ walk all of it. Pure so the ordering is testable.
import type { InboxRow } from '../mobile/inbox';
import type { PaneSearchHit, PaneSearchResult, PrRow } from '../services/api';
import { STATUS_LABEL, type AgentStatusValue } from '../types';

/** Opens the ⌘K palette from elsewhere on the page (the PR overlay's Search… and `/`). */
export const OPEN_PALETTE_EVENT = 'termag:open-palette';
export interface OpenPaletteDetail { via: 'prs-overlay' }

/** A command the palette runs, such as Branch off…, listed under Actions when the query matches it. */
export interface PaletteAction {
  id: string;
  label: string;
  /** What it acts on, beside the label: the project's name. */
  detail?: string;
  /** More words that find it. */
  keywords?: string[];
  run: () => void;
}

export type PaletteItem =
  | { kind: 'action'; action: PaletteAction }
  | { kind: 'row'; row: InboxRow }
  | { kind: 'pr'; row: PrRow }
  | { kind: 'cta'; q: string }
  | { kind: 'hit'; hit: PaneSearchHit; q: string }
  | { kind: 'recent-query'; q: string };

export interface PaletteInput {
  /** The trimmed query. */
  q: string;
  /** Actions matching the query (matchActions). */
  actions: PaletteAction[];
  history: string[];
  recent: InboxRow[];
  /** Sessions matching the query (searchRows). */
  hits: InboxRow[];
  /** Pull requests matching the query, from every lane (searchPrRows). */
  prs?: PrRow[];
  /** The query the pane search last ran for, if any. */
  paneQuery: string | null;
  /** That search's result, once done. */
  paneResult: PaneSearchResult | null;
}

/**
 * Empty query: recent searches, then recent sessions. Otherwise: the matching
 * actions first (so ⌘K, b, Enter branches off), then the matching sessions,
 * then the matching pull requests, then the pane-text hits for this query, or — before a pane search
 * has run for it — the "Search pane text for …" item (2+ characters, as the
 * route requires).
 */
export function paletteItems({ q, actions, history, recent, hits, prs = [], paneQuery, paneResult }: PaletteInput): PaletteItem[] {
  if (!q) {
    return [...history.map(h => ({ kind: 'recent-query' as const, q: h })), ...recent.map(row => ({ kind: 'row' as const, row }))];
  }
  const out: PaletteItem[] = [
    ...actions.map(action => ({ kind: 'action' as const, action })),
    ...hits.map(row => ({ kind: 'row' as const, row })),
    ...prs.map(row => ({ kind: 'pr' as const, row })),
  ];
  if (paneQuery === q && paneResult) out.push(...paneResult.hits.map(hit => ({ kind: 'hit' as const, hit, q })));
  else if (paneQuery !== q && q.length >= 2) out.push({ kind: 'cta', q });
  return out;
}

/**
 * The actions the query finds. A matched action takes the top slot, so Enter
 * runs it instead of opening the first session; short queries are the ones
 * most likely meant for a session name, so they only match the start of the
 * label (`b`, `br` find Branch off…). From MIN_WORD_MATCH characters on, the
 * start of a keyword or of any word matches too (`off`, `workst`). An empty
 * query finds none.
 */
export const MIN_WORD_MATCH = 3;

export function matchActions(actions: PaletteAction[], q: string): PaletteAction[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/);
  const finds = (a: PaletteAction) => {
    if (a.label.toLowerCase().startsWith(needle)) return true;
    if (needle.length < MIN_WORD_MATCH) return false;
    return [a.label, ...(a.keywords ?? [])].some(t => t.toLowerCase().startsWith(needle) || words(t).some(w => w.startsWith(needle)));
  };
  return actions.filter(finds);
}

/**
 * The custom event for opening an item: which kind, and for an
 * action its id. The query's length, never its text, which can name projects
 * and sessions.
 */
export function paletteSelectEvent(item: PaletteItem, q: string): { key: string; data: Record<string, string | number> } {
  if (item.kind === 'action') return { key: 'palette-action', data: { action: item.action.id, queryLength: q.length } };
  return { key: 'palette-select', data: { kind: item.kind, queryLength: q.length } };
}

/** Keep a highlight inside a list that shrank under it. */
export function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(i, length - 1));
}

/** A pane hit's status for its glyph; the field is a wide string, so only own keys count. */
export function hitStatus(status: string): AgentStatusValue {
  return Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? (status as AgentStatusValue) : 'not_running';
}
