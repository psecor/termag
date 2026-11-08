// Where a status-strip row or a search hit lands in the desktop workspace:
// the phone's conversationHref / paneHitHref
// answered as a workspace switch instead of an /m/ URL.
import type { InboxRow } from '../mobile/inbox';
import { opensReview } from '../mobile/inbox';
import type { PaneSearchHit } from '../services/api';

export type WorkspacePane = 'agent' | 'ctrl' | 'review';

export type WorkspaceTarget =
  /** `session`: which review pane, when the pane is a review; `slot`: which terminal tab, when past the ctrl pane; absent, the first. */
  | { kind: 'pane'; projectId: string; workstream: string; pane: WorkspacePane; session?: string; slot?: number }
  /** A Claude Code cloud session: no pane here, its page on claude.ai. */
  | { kind: 'external'; url: string }
  | { kind: 'none' };

/** A session row: its workstream, with the review dock open when the row is about its review (the pane that rings). */
export function rowTarget(row: Pick<InboxRow, 'kind' | 'url' | 'projectId' | 'workstream' | 'status' | 'ring'> & { review?: InboxRow['review'] }): WorkspaceTarget {
  if (row.kind === 'cloud') return row.url ? { kind: 'external', url: row.url } : { kind: 'none' };
  const workstream = row.workstream || 'main';
  if (!opensReview(row)) return { kind: 'pane', projectId: row.projectId, workstream, pane: 'agent' };
  return { kind: 'pane', projectId: row.projectId, workstream, pane: 'review', ...(row.review?.session ? { session: row.review.session } : {}) };
}

/** A pane-text hit: its workstream and the pane the text was in (a data pane opens the agent; a review or extra-terminal hit, its own pane). */
export function hitTarget(hit: Pick<PaneSearchHit, 'projectId' | 'workstream' | 'role'> & { session?: string; slot?: number }): WorkspaceTarget {
  const pane: WorkspacePane = hit.role === 'ctrl' || hit.role === 'review' ? hit.role : 'agent';
  // A review names its pane by session; a terminal slot past the ctrl pane by its slot number, so the workspace opens that tab and not the ctrl pane.
  if (pane === 'review') return { kind: 'pane', projectId: hit.projectId, workstream: hit.workstream || 'main', pane, ...(hit.session ? { session: hit.session } : {}) };
  if (pane === 'ctrl' && hit.slot !== undefined && hit.slot >= 2) return { kind: 'pane', projectId: hit.projectId, workstream: hit.workstream || 'main', pane, slot: hit.slot };
  return { kind: 'pane', projectId: hit.projectId, workstream: hit.workstream || 'main', pane };
}

/** Fired after a switch so MainLayout can focus the pane (or open the review dock). */
export const FOCUS_PANE_EVENT = 'termag:focus-pane';
/** `session`: which review pane to open; `slot`: which terminal tab; absent, the first. */
export interface FocusPaneDetail { projectId: string; workstream: string; pane: WorkspacePane; session?: string; slot?: number }

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

/** The search shortcut's label on this browser's platform. */
export function currentSearchShortcut(): string {
  return searchShortcutLabel(
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform,
  );
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
