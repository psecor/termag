export type WorkspaceChange = 'projects' | 'boxes' | 'prs' | 'preview-links' | 'pins';

/** Fired on window when an agent asked for a preview link: an open links list reloads (previewLinks/PreviewLinksPanel.tsx). */
export const PREVIEW_LINKS_CHANGED_EVENT = 'termag:preview-links-changed';

/** Fired on window when a `pins` push arrives, or the status socket reconnects: the person's pinned sessions re-read (chat/sessionPins.ts). */
export const PINS_PUSH_EVENT = 'termag:pins-push';

/**
 * Dispatched on window when a `projects` push arrives (contexts/ProjectContext.tsx),
 * after the project list's own re-read starts: what else the push covers re-reads
 * on it, as the person's projects do (pages/chat/simpleData.tsx, GET /api/user-projects).
 */
export const PROJECTS_PUSH_EVENT = 'termag:projects-push';

/**
 * The list a `{type: 'workspace', what}` push from /ws/status says changed
 * (backend services/workspaceEvents.ts), or null for any other frame. `prs`:
 * a session opened or changed one of the user's PRs (services/prLiveUpdates.ts).
 * `preview-links`: an agent asked for a preview link (services/previewLinkRequests.ts).
 * `pins`: they pinned or unpinned a session in another tab (routes/sessionPins.ts).
 */
export function workspaceChangeFromPush(msg: { type?: unknown; what?: unknown }): WorkspaceChange | null {
  if (msg.type !== 'workspace') return null;
  return msg.what === 'projects' || msg.what === 'boxes' || msg.what === 'prs' || msg.what === 'preview-links' || msg.what === 'pins'
    ? msg.what : null;
}
