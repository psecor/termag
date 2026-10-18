// The Search tab's pane-text results: pure helpers for
// where a hit opens and what a failed search says.
import type { PaneSearchHit, PaneSearchResult } from '../services/api';

/** A hit opens its pane's conversation: the workstream, and the tab for its role. */
export function paneHitHref(hit: Pick<PaneSearchHit, 'projectId' | 'workstream' | 'role'>): string {
  const q = new URLSearchParams();
  if (hit.workstream !== 'main') q.set('ws', hit.workstream);
  // The phone has agent, ctrl and review tabs; a data pane opens the agent tab.
  if (hit.role === 'ctrl' || hit.role === 'review') q.set('role', hit.role);
  const qs = q.toString();
  return `/m/p/${encodeURIComponent(hit.projectId)}${qs ? `?${qs}` : ''}`;
}

/** Thrown for a 200 that is not a search result. */
export class NoPaneSearchError extends Error {
  constructor() { super('no pane search on this backend'); this.name = 'NoPaneSearchError'; }
}

/**
 * The search payload, or NoPaneSearchError. A backend predating the route
 * answers it with the SPA's index.html and a 200 (frontend-only hot-patches
 * do run ahead of the backend), and rendering that as a result would crash.
 */
export function asPaneSearchResult(data: unknown): PaneSearchResult {
  const r = data as Partial<PaneSearchResult> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.hits) || typeof r.searched !== 'number') throw new NoPaneSearchError();
  return r as PaneSearchResult;
}

/**
 * A hit's identity. Not the tmux session name: same-named projects on two
 * boxes share it (the status map keys by instance + session for that reason).
 */
export function paneHitKey(hit: Pick<PaneSearchHit, 'projectId' | 'role' | 'workstream'>): string {
  return `${hit.projectId}|${hit.role}|${hit.workstream}`;
}

export function paneSearchError(err: unknown): string {
  if (err instanceof NoPaneSearchError) return 'This termag does not have pane search yet.';
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 429) return 'One pane search every few seconds; try again in a moment.';
  if (status === 400) return 'Type at least 2 characters to search pane text.';
  if (status === 404) return 'This termag does not have pane search yet.';
  return 'Pane search failed.';
}

/** "searched 12 panes · 1 unreachable": what the result covers. */
export function paneSearchScope(r: { searched: number; unreachable: number; skipped: number }): string {
  const parts = [`searched ${r.searched} pane${r.searched === 1 ? '' : 's'}`];
  if (r.unreachable) parts.push(`${r.unreachable} unreachable`);
  if (r.skipped) parts.push(`${r.skipped} not searched`);
  return parts.join(' · ');
}

/**
 * A phone row shows ~40 monospace characters, so a match deep in a long line
 * would be ellipsised away: start the line a little before the first match.
 */
export function focusLine(text: string, needle: string, lead = 16): string {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at <= lead + 1) return text;
  const from = text.startsWith('…') ? Math.max(1, at - lead) : at - lead;
  return `…${text.slice(from).replace(/^…/, '')}`;
}
