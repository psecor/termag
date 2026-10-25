export type WorkspaceChange = 'projects' | 'boxes';

/**
 * The list a `{type: 'workspace', what}` push from /ws/status says changed
 * (backend services/workspaceEvents.ts), or null for any other frame.
 */
export function workspaceChangeFromPush(msg: { type?: unknown; what?: unknown }): WorkspaceChange | null {
  if (msg.type !== 'workspace') return null;
  return msg.what === 'projects' || msg.what === 'boxes' ? msg.what : null;
}
