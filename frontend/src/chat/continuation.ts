// A chat whose box was terminated, or is stopped, carries on when its owner
// sends: the backend starts the new box (or the stopped
// one), restores the session, and holds the message until the chat can take
// it. The history says where that stands (`continuation`); these are what the
// chat view shows for it.
import type { ChatContinuation } from '../services/api';

/** How often a chat that is coming back looks again. */
export const CONTINUATION_POLL_MS = 3000;

const PHASE_TEXT = {
  'starting-box': 'Starting a new box for this chat…',
  restoring: 'Restoring this conversation…',
  starting: 'Starting the box…',
} as const;

/** The status line while the chat comes back, or null for its own. */
export function continuationStatus(c: ChatContinuation | null | undefined): { tone: 'working'; text: string } | null {
  return c?.phase ? { tone: 'working', text: PHASE_TEXT[c.phase] } : null;
}

/** Whether the view keeps looking: the box is coming up, or held messages are still to go in. */
export function continuationPolls(c: ChatContinuation | null | undefined): boolean {
  return Boolean(c && (c.phase || c.held?.some(m => !m.error)));
}

/**
 * The held messages to show as queued, without the ones already on screen:
 * a send's pending bubble, or the chat's newest message, which is the held
 * one gone in before the next history read drops it from the list.
 */
export function heldToShow(c: ChatContinuation | null | undefined, onScreen: readonly string[]): NonNullable<ChatContinuation['held']> {
  const left = [...onScreen];
  return (c?.held ?? []).filter(m => {
    const i = left.indexOf(m.text);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}
