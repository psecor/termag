// Above a review session's composer while its PR changed since the user's
// review: who pushed, and Check the
// fixes, which asks the session to read the new head (chat/reviewCard.ts
// followUpMessage). The Reviews page's row has the same button.
import React, { useSyncExternalStore } from 'react';
import { Button } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { followUpMessage } from '../../chat/reviewCard';
import { prShort, type QueueItem } from '../../chat/reviews';
import { chatApi } from '../../services/api';

const ASKED_KEY = 'termag.reviews.followups';

/** Sends the follow-up into the session, a few tries 2 s apart while its chat runner comes up; false if none took. */
async function sendFollowUp(projectId: string, workstream: string, text: string, tries = 5): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { await chatApi.send(projectId, workstream, text); return true; } catch { if (i < tries - 1) await new Promise(r => setTimeout(r, 2000)); }
  }
  return false;
}
function asked(): Record<string, string> { try { return JSON.parse(localStorage.getItem(ASKED_KEY) ?? '{}'); } catch { return {}; } }
// Sends under way, and those that failed, by session and head: the queue's row and the session's strip share them, so
// they don't both send it, and each shows a send the other started (the row's navigates to the strip mid-send).
const inFlight = new Set<string>();
const failed = new Set<string>();
let askVersion = 0;
const askListeners = new Set<() => void>();
const notifyAsks = () => { askVersion++; for (const fn of askListeners) fn(); };
const subscribeAsks = (fn: () => void) => { askListeners.add(fn); return () => { askListeners.delete(fn); }; };
/** Draws again on each send's start and end. */
export function useFixesAsks(): number {
  return useSyncExternalStore(subscribeAsks, () => askVersion, () => 0);
}
/**
 * What a follow-up is for: the PR's head now. None while GitHub hasn't said what it is (a blip, the queue standing on
 * what it knew): there's no head to have the session read, so Check the fixes waits for one rather than sending
 * twice, once before the head is known and again after.
 */
export function followedUp(it: QueueItem): string | null {
  return it.round?.now?.headSha ?? null;
}
const askKey = (it: QueueItem) => `${it.session?.projectId}|${it.session?.workstream}|${followedUp(it) ?? ''}`;

/** Whether Check the fixes already went to this session for the PR's current head (or round), or is on its way. */
export function fixesAsked(it: QueueItem): boolean {
  const what = followedUp(it);
  if (!it.session || !what) return false;
  return inFlight.has(askKey(it)) || asked()[`${it.session.projectId}|${it.session.workstream}`] === what;
}

/** A send to this session for the PR's head (or round) under way, wherever it started. */
export function fixesSending(it: QueueItem): boolean {
  return inFlight.has(askKey(it));
}
/** The last send to it failed, wherever it started. */
export function fixesFailed(it: QueueItem): boolean {
  return failed.has(askKey(it));
}

/** Asks the session to check the fixes; marked sent for this head only once the session has it. */
export async function checkTheFixes(it: QueueItem): Promise<boolean> {
  const k = askKey(it);
  if (!it.session || !it.round || !followedUp(it) || inFlight.has(k)) return false;
  inFlight.add(k); failed.delete(k); notifyAsks();
  let sent = false;
  try {
    sent = await sendFollowUp(it.session.projectId, it.session.workstream, followUpMessage({
      author: it.author, prKey: prShort(it.repo, it.number), head: it.round.now?.headSha ?? null, round: it.round.round, askedAgain: it.round.now?.askedAgain ?? false,
    }));
  } finally {
    inFlight.delete(k);
    if (sent) {
      try { localStorage.setItem(ASKED_KEY, JSON.stringify({ ...asked(), [`${it.session.projectId}|${it.session.workstream}`]: followedUp(it) ?? '' })); } catch { /* not kept */ }
    } else {
      failed.add(k);
    }
    notifyAsks();
  }
  return sent;
}

export function FollowUpStrip({ item }: { item: QueueItem }) {
  useFixesAsks();
  const sending = fixesSending(item);
  const failedLast = !sending && fixesFailed(item);
  if (!sending && fixesAsked(item)) return null;
  return (
    <div className="rv-strip" role="status">
      <Icon name="arrow-merge" size="small" aria-hidden="true" />
      <span>
        {item.author ?? 'The author'} {item.round?.now?.askedAgain ? 'asked for your review again' : 'pushed since your review'}{item.round?.now?.headSha ? ` (now ${item.round.now.headSha.slice(0, 7)})` : ''}.
        {failedLast && ' The session didn\'t take the message: is its box up?'}
      </span>
      {followedUp(item) ? (
        <Button size="small" variant="primary" isDisabled={sending} onPress={() => { void checkTheFixes(item); }}>
          {sending ? 'Sending…' : failedLast ? 'Try again' : 'Check the fixes'}
        </Button>
      ) : <span className="rv-note">Reading its head from GitHub…</span>}
    </div>
  );
}
