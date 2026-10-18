/**
 * Stopping a simple-UI chat when its project is archived, its workstream is
 * deleted, or its box is terminated. The turn is a tmux session the agent and
 * ctrl teardown does not kill (`<user>-chat-<turn>-r`). `clearChatsOnBox`
 * reports what the box did; this module decides whether that is enough to
 * revoke.
 */
import { ChatClearResult, clearChatsOnBox } from './chatRunner';

export interface ChatKeyRow {
  chatKey: string;
  projectId: string;
  workstreamId: string;
}

export interface ProjectChatShape {
  id: string;
  archived: boolean;
  workstreams: { id: string; archived: boolean }[];
}

/**
 * Chats a reconnect must not take up. A missing project, an archived project,
 * or a workstream that is gone or archived. Names are not keys: the key is
 * `projectId--workstreamId`.
 */
export function deadChatKeys(projects: readonly ProjectChatShape[], keys: readonly ChatKeyRow[]): string[] {
  const byId = new Map(projects.map(p => [p.id, p]));
  const dead: string[] = [];
  for (const key of keys) {
    const project = byId.get(key.projectId);
    if (!project || project.archived) {
      dead.push(key.chatKey);
      continue;
    }
    const workstream = project.workstreams.find(w => w.id === key.workstreamId);
    if (!workstream || workstream.archived) dead.push(key.chatKey);
  }
  return dead;
}

/**
 * Why a revoke must not proceed, or null when it may.
 *
 * An offline box is allowed to archive: the next hello refuses those chats.
 * `offlineBlocks` is a host we are not about to destroy (an external box, or
 * one with no EC2 teardown). Revoking its token only drops the socket, and
 * the tmux turn keeps running. A connected box must report every turn
 * stopped; `stopped: false` means one is still running.
 */
export function chatRevokeError(
  connected: boolean,
  results: readonly ChatClearResult[],
  opts?: { offlineBlocks?: boolean },
): string | null {
  if (!connected) {
    if (opts?.offlineBlocks) return "The box's agent is offline, so its chat turns cannot be stopped";
    return null;
  }
  for (const result of results) {
    if ('skipped' in result) return `Could not stop the chat on workstream ${result.workstream} (${result.skipped})`;
    if ('error' in result) return `Could not stop the chat on workstream ${result.workstream}: ${result.error}`;
    if (result.stopped !== true) return `Could not stop the chat on workstream ${result.workstream}`;
  }
  return null;
}

/** Clear one project's chats and say whether the revoke may proceed. */
export async function revokeChats(
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  connected: boolean,
  projectId: string,
  workstreamIds: readonly string[],
  opts?: { offlineBlocks?: boolean },
): Promise<string | null> {
  if (!connected) return chatRevokeError(false, [], opts);
  const results = await clearChatsOnBox(send, projectId, workstreamIds);
  return chatRevokeError(true, results);
}
