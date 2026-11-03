export type WorkspaceChange = 'projects' | 'boxes' | 'prs';

/**
 * The list a `{type: 'workspace', what}` push from /ws/status says changed
 * (backend services/workspaceEvents.ts), or null for any other frame. `prs`:
 * a session opened or changed one of the user's PRs (services/prLiveUpdates.ts).
 */
export function workspaceChangeFromPush(msg: { type?: unknown; what?: unknown }): WorkspaceChange | null {
  if (msg.type !== 'workspace') return null;
  return msg.what === 'projects' || msg.what === 'boxes' || msg.what === 'prs' ? msg.what : null;
}
