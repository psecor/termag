// Where a status-strip row or a search hit lands in the desktop workspace:
// the phone's conversationHref / paneHitHref
// answered as a workspace switch instead of an /m/ URL.
import type { InboxRow } from '../mobile/inbox';
import { opensReview } from '../mobile/inbox';
import type { PaneSearchHit } from '../services/api';

export type WorkspacePane = 'agent' | 'ctrl' | 'review';

export type WorkspaceTarget =
  | { kind: 'pane'; projectId: string; workstream: string; pane: WorkspacePane }
  /** A Claude Code cloud session: no pane here, its page on claude.ai. */
  | { kind: 'external'; url: string }
  | { kind: 'none' };

/** A session row: its workstream, with the review dock open when the row is about its review. */
export function rowTarget(row: Pick<InboxRow, 'kind' | 'url' | 'projectId' | 'workstream' | 'status' | 'ring'>): WorkspaceTarget {
  if (row.kind === 'cloud') return row.url ? { kind: 'external', url: row.url } : { kind: 'none' };
  return { kind: 'pane', projectId: row.projectId, workstream: row.workstream || 'main', pane: opensReview(row) ? 'review' : 'agent' };
}

/** A pane-text hit: its workstream and the pane the text was in (a data pane opens the agent). */
export function hitTarget(hit: Pick<PaneSearchHit, 'projectId' | 'workstream' | 'role'>): WorkspaceTarget {
  const pane: WorkspacePane = hit.role === 'ctrl' || hit.role === 'review' ? hit.role : 'agent';
  return { kind: 'pane', projectId: hit.projectId, workstream: hit.workstream || 'main', pane };
}

/** Fired after a switch so MainLayout can focus the pane (or open the review dock). */
export const FOCUS_PANE_EVENT = 'termag:focus-pane';
export interface FocusPaneDetail { projectId: string; workstream: string; pane: WorkspacePane }

/**
 * The palette shortcut: ⌘K (Meta+K on any platform) or Ctrl+Shift+K. Plain
 * Ctrl+K stays with the terminal, where it is readline's kill-line.
 */
export function isSearchShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey) return false;
  if (e.metaKey) return !e.ctrlKey && !e.shiftKey;
  return e.ctrlKey && e.shiftKey;
}

/**
 * The shortcut to show for the palette: ⌘K on Apple platforms, Ctrl+Shift+K
 * elsewhere, where ⌘ is not a key and Ctrl+K reaches the terminal instead.
 * `platform` is navigator.userAgentData?.platform or navigator.platform.
 */
export function searchShortcutLabel(platform: string | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '') ? '⌘K' : 'Ctrl+Shift+K';
}

/** The workstream to open: the named one while it is live, else main. */
export function resolveWorkstream(workstreams: Array<{ name: string; archived?: boolean }>, name: string): string {
  return name !== 'main' && workstreams.some(ws => ws.name === name && !ws.archived) ? name : 'main';
}

/**
 * Run `attempt` every `everyMs` until it returns true or `forMs` passes: the
 * terminals remount after a switch (slower on a remote box), so the pane to
 * focus may not exist yet. Returns a cancel.
 */
export function retryUntil(attempt: () => boolean, everyMs = 100, forMs = 2000): () => void {
  let left = Math.ceil(forMs / everyMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (attempt() || --left <= 0) { timer = null; return; }
    timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, everyMs);
  return () => { if (timer) clearTimeout(timer); };
}
