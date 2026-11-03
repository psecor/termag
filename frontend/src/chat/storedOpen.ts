// A simple-UI chat whose box is parked, and whose transcript the orchestrator
// stores (chat-transcripts-enabled), opens on that
// copy and leaves the box alone: starting it is the person's call, by sending
// (the only way this view wakes it). Only a chat with nothing stored is started on open
// (box-open-start-enabled, hooks/useStartParkedBoxOnOpen.ts), so there is
// something to see. The conversation's history load (pages/chat/useSdkChat.ts)
// reports what it got here, and the open waits for that answer.
import type { Instance } from '../types';
import { canStartBox } from '../utils/boxPower';

/** What the open chat's history load found: its stored transcript, or anything else (the box answered, nothing stored, an error). */
export type StoredOpenAnswer = 'stored' | 'none';

const answers = new Map<string, StoredOpenAnswer>();
const listeners = new Set<() => void>();

export function storedOpenKey(projectId: string, workstream: string): string {
  return `${projectId}|${workstream}`;
}

/** The view's answer for a chat, or null while it has none (not loaded yet, or not open). */
export function reportStoredOpen(key: string, answer: StoredOpenAnswer | null): void {
  if ((answers.get(key) ?? null) === answer) return;
  if (answer) answers.set(key, answer);
  else answers.delete(key);
  listeners.forEach(l => l());
}

export function readStoredOpen(key: string): StoredOpenAnswer | null {
  return answers.get(key) ?? null;
}

export function subscribeStoredOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a history answer is a stored transcript worth showing instead of starting the box: one with something in it. */
export function storedOpenAnswer(h: { stored?: boolean; entries?: unknown[] } | null): StoredOpenAnswer {
  return h?.stored === true && (h.entries?.length ?? 0) > 0 ? 'stored' : 'none';
}

/**
 * For a view that shows the stored transcript: start on open only once the
 * history has answered, and only when it had nothing stored.
 */
export function openStartGate(answer: StoredOpenAnswer | null): 'wait' | 'skip' | 'start' {
  if (answer === null) return 'wait';
  return answer === 'stored' ? 'skip' : 'start';
}

type ParkedBox = Pick<Instance, 'id' | 'kind' | 'status' | 'ec2InstanceId'>;

/** A box that is down or on its way down, which a send brings back (now, or once it has stopped). */
export function boxIsDown(box: ParkedBox | null | undefined): boolean {
  if (!box || box.kind !== 'ec2' || !box.ec2InstanceId) return false;
  return box.status === 'stopped' || box.status === 'hibernated' || box.status === 'stopping' || box.status === 'hibernating';
}

/** The status line's words for a stored chat's box that is down, e.g. "Box is stopped". */
export function boxDownText(status: Instance['status']): string {
  switch (status) {
    case 'hibernated': return 'Box is hibernated';
    case 'stopping': return 'Box is stopping';
    case 'hibernating': return 'Box is hibernating';
    default: return 'Box is stopped';
  }
}

/** Whether the start asked for can go now; a box still stopping or hibernating is started once it has settled. */
export function startDue(asked: boolean, box: ParkedBox | null | undefined): boolean {
  return asked && box != null && canStartBox(box);
}

/** How long a start request may go unanswered before the view lets go of it; the next send tries again. */
export const START_WAIT_MS = 30_000;

/**
 * Once a start the route took has landed (its 202 and the box list's reload
 * after it), whether the box is down again: still or again stopped or
 * hibernated, failed, or gone from the list. The view then lets go of the
 * ask and says so (the next send starts it again), rather than "Starting the box…"
 * for a box that is not coming. Null while it is on its way or up.
 */
export function startDidNotTake(landed: boolean, box: (ParkedBox & Pick<Instance, 'provisioningError'>) | null | undefined): string | null {
  if (!landed) return null;
  if (!box) return 'The box is no longer in your list.';
  if (box.status === 'failed') return box.provisioningError ? `The box failed to start: ${box.provisioningError}` : 'The box failed to start.';
  if (canStartBox(box)) return `${boxDownText(box.status)}: it did not come up. Send again to start it.`;
  return null;
}
