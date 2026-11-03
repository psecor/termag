/**
 * The simple UI's chat lifecycle (option C), as pure decisions; the
 * route (routes/chats.ts) runs them through the existing project archive and
 * box power paths.
 *
 *   Archive  → the project is archived (sessions killed, workflows kept) and
 *              its box stopped (never hibernated), so it costs only
 *              storage.
 *   Reopen   → the box is started again (history is on its disk) and the
 *              project unarchived.
 *   Delete   → only from the archive: the project row is removed. The box is
 *              terminated, and the history on it goes, only when this chat
 *              is the last project on a box that still exists. A shared box
 *              stays.
 */
import type { PowerAction } from './boxPowerPolicy';

export interface LifecycleBox {
  kind: string;
  status: string;
}

const PARKED = ['stopping', 'stopped', 'hibernating', 'hibernated'];

export type ArchivePower =
  | { action: Extract<PowerAction, 'stop'> }
  | { action: null; reason: string };

/**
 * What archiving a chat does to its box. A chat has its own box, so the box
 * goes down with it, unless something else still lives there, it is not one
 * termag powers (a self-managed host), or stop would not be accepted.
 * A box still coming up (`starting`) is stopped too: stop is already allowed from there.
 */
export function archivePowerFor(box: LifecycleBox | null, otherLiveProjects: number): ArchivePower {
  if (!box) return { action: null, reason: 'the chat has no box' };
  if (box.status === 'terminated' || box.status === 'failed') return { action: null, reason: `the box is ${box.status}` };
  if (box.kind !== 'ec2') return { action: null, reason: 'a self-managed host is not powered from termag' };
  if (otherLiveProjects > 0) return { action: null, reason: 'other projects still use this box' };
  if (PARKED.includes(box.status)) return { action: null, reason: `the box is already ${box.status}` };
  if (box.status !== 'ready' && box.status !== 'starting') return { action: null, reason: `the box is ${box.status}` };
  return { action: 'stop' };
}

export type ReopenPlan =
  | { start: boolean }
  | { stored: true }
  | { refused: { status: number; error: string } };

/**
 * Whether a reopen may mark the chat live.
 *
 * Archive's revoke fail-opens when the agent is offline: the queue under
 * `~/.termag/chats` stays, and the next hello drops it only while the row is
 * still archived. Unarchiving first makes that hello park the queue and take
 * up a turn whose tmux session is still alive (hibernate, or the agent died
 * and the box did not). chat-history would then `resumeQueue` it, in the
 * permission mode stored on the job.
 *
 * A connected agent must chat-clear first (`revokeError` null). A disconnected
 * one leaves the row archived so that hello's chat-recover drops the keys.
 * A stopped instance's turn is already closed as died; this adds no kill for it.
 */
export function reopenRelease(connected: boolean, revokeError: string | null):
  | { unarchive: true }
  | { unarchive: false; pending: true }
  | { unarchive: false; error: string } {
  if (!connected) return { unarchive: false, pending: true };
  if (revokeError) return { unarchive: false, error: revokeError };
  return { unarchive: true };
}

/**
 * Whether a reopen from the stored transcript may mark the chat live. Its
 * parked queue and live turn get the same quarantine as `reopenRelease`. An
 * agent still connected must chat-clear first, whatever its token says now:
 * revoking or expiring a token does not close a socket already open. With no
 * agent connected, a box that can no longer connect (terminated or removed,
 * its tokens revoked) has nothing left to resume. A failed box keeps its token
 * and may still dial in, so it is refused rather than left pending, since it
 * may never connect.
 */
export function storedReopenRelease(canConnect: boolean, connected: boolean, revokeError: string | null):
  | { unarchive: true }
  | { unarchive: false; error: string } {
  if (connected) return revokeError ? { unarchive: false, error: revokeError } : { unarchive: true };
  if (!canConnect) return { unarchive: true };
  return { unarchive: false, error: "This chat's failed box can still connect, and a turn left on it could run again. Terminate the box, then reopen the chat." };
}

/**
 * What reopening a chat needs from its box: a start when it is down, or
 * nothing. A chat whose box is gone reopens only from its stored transcript
 * (`storedHistory`), read-only until resume lands.
 */
export function reopenPlanFor(box: LifecycleBox | null, storedHistory = false): ReopenPlan {
  if (!box || box.status === 'terminated' || box.status === 'failed') {
    if (storedHistory) return { stored: true };
    return { refused: { status: 409, error: "This chat's box is gone, and its history with it. Delete the chat instead." } };
  }
  if (box.status === 'stopping' || box.status === 'hibernating') {
    return { refused: { status: 409, error: `The box is still ${box.status}. Reopen the chat once it has.` } };
  }
  return { start: box.kind === 'ec2' && (box.status === 'stopped' || box.status === 'hibernated') };
}

/**
 * Whether deleting a chat terminates its box: yes, unless the box is already
 * gone or holds any other project (archived ones included, whose history is
 * on that disk too).
 */
export function deleteTerminatesBox(box: LifecycleBox | null, otherProjects: number): boolean {
  return !!box && box.status !== 'terminated' && otherProjects === 0;
}

/**
 * Projects on this box besides the chat being deleted. `totalOnBox` counts
 * every project on the instance, and that includes this chat.
 */
export function otherProjectsFromTotal(totalOnBox: number): number {
  return Math.max(0, totalOnBox - 1);
}
