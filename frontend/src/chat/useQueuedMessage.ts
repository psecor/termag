// The message a chat holds for Claude until it is up. localStorage is the one
// source of truth (chat/newChat.ts): the hook's state only mirrors it, so a
// message storage does not hold is never shown or sent, and a reload or a
// second tab sees the same queue. Everything is keyed to one conversation: a
// send that lands after the view moved to another chat settles its own queue
// and leaves the open chat alone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { flattenForSend, sendErrorText } from './compose';
import { CLAIM_RENEW_MS, claimHeldUntil, claimQueued, finishQueued, isQueueKey, queueKey, queuedSendId, readQueued, releaseQueued, renewClaim, writeQueued } from './newChat';

const store = () => (typeof localStorage !== 'undefined' ? localStorage : null);

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

// Per page, not per mounted hook, so a chat view that remounts (New chat and
// back) is still the tab that holds the claim and sees its own send in flight.
const TAB_ID = randomId();
const inFlight = new Set<string>();
// Same-tab storage writes fire no `storage` event; this one tells every mounted
// hook a send for that project settled.
const SETTLED_EVENT = 'termag-chat-queue-settled';

export interface QueuedMessageOptions {
  /** The conversation's project; null while it is not known. */
  projectId: string | null;
  workstream: string;
  /** Claude can take a message now. */
  up: boolean;
  offline: boolean;
  /**
   * Hands the message to Claude: types it into the agent pane, or a chat-runner turn.
   * `sendId` is the same for every try of the same queued text (chat/newChat.ts queuedSendId):
   * the chat runner takes a message once however often it is sent with its id.
   */
  send: (projectId: string, workstream: string, keys: string, sendId?: string) => Promise<void>;
  /** Send the text as typed (newlines kept) rather than flattened for a pane, for the chat runner. */
  raw?: boolean;
}

export interface QueuedMessage {
  queued: string | null;
  /** The message just sent, until the pane shows it back. */
  echo: string | null;
  /** Why the last send failed; the message stays queued until retry(). */
  error: string | null;
  /** Queue text behind what is waiting; false when storage would not hold it. */
  enqueue: (text: string) => boolean;
  retry: () => void;
}

export function useQueuedMessage(o: QueuedMessageOptions): QueuedMessage {
  // New session starts a chat on a project's main workstream, or on a new
  // worktree's (chat/newChat.ts queueKey); each has its own queue.
  const key = o.projectId ? queueKey(o.projectId, o.workstream) : null;
  const [queued, setQueued] = useState<string | null>(null);
  const [echo, setEcho] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to look at storage again and, if it is due, try the send.
  const [attempt, setAttempt] = useState(0);
  const current = useRef(key);
  current.current = key;

  useEffect(() => {
    setQueued(key ? readQueued(store(), key) : null);
    setEcho(null);
    setError(null);
  }, [key]);

  // Another tab (storage) or another mount in this tab (SETTLED_EVENT) moved
  // this chat's queue: read it again.
  useEffect(() => {
    if (!key || typeof window === 'undefined') return;
    const reread = () => { setQueued(readQueued(store(), key)); setAttempt(n => n + 1); };
    const onStorage = (e: StorageEvent) => { if (isQueueKey(e.key, key)) reread(); };
    const onSettled = (e: Event) => { if ((e as CustomEvent<string>).detail === key) reread(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SETTLED_EVENT, onSettled);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SETTLED_EVENT, onSettled);
    };
  }, [key]);

  const { projectId, up, offline, send, workstream, raw } = o;
  useEffect(() => {
    if (!key || !queued || !up || offline || error || inFlight.has(key)) return;
    if (readQueued(store(), key) == null) {
      // Storage no longer holds it (sent elsewhere, or never stored): nothing to send.
      setQueued(null);
      return;
    }
    const text = claimQueued(store(), key, TAB_ID, Date.now());
    if (!text) {
      // Another tab holds the claim: its send settles through a storage
      // event, and if that tab went away, this one takes over when the claim
      // expires. With no claim in the future (storage refusing writes), say
      // so and leave the retry to the user, never to a timer.
      const until = claimHeldUntil(store(), key);
      if (until == null || until <= Date.now()) {
        setError('this browser could not reserve the message for sending');
        return;
      }
      const t = setTimeout(() => setAttempt(n => n + 1), until - Date.now() + 50);
      return () => clearTimeout(t);
    }
    const keys = raw ? text.trim() : flattenForSend(text);
    // A send whose answer never came (the box may have taken it) goes again with the same id, on Retry or from another tab.
    const sendId = queuedSendId(store(), key, text, randomId) ?? undefined;
    inFlight.add(key);
    // The claim stays this tab's while the send is in flight, however long the orchestrator holds it,
    // so no other tab sends the message again meanwhile. Not cleared by this effect's cleanup: the send
    // outlives a re-render or unmount, and the claim with it; it stops when the send settles.
    const renew = setInterval(() => renewClaim(store(), key, TAB_ID, Date.now()), CLAIM_RENEW_MS);
    // The key is the queue's (project@workstream for a worktree); the send is the project's.
    send(projectId!, workstream, keys, sendId)
      .then(() => {
        finishQueued(store(), key, text);
        if (current.current === key) setEcho(keys);
      })
      .catch(err => {
        releaseQueued(store(), key, TAB_ID);
        if (current.current === key) setError(sendErrorText(err));
      })
      .finally(() => {
        clearInterval(renew);
        inFlight.delete(key);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SETTLED_EVENT, { detail: key }));
      });
  }, [key, projectId, queued, up, offline, error, send, workstream, raw, attempt]);

  const enqueue = useCallback((text: string): boolean => {
    if (!key) return false;
    const waiting = readQueued(store(), key);
    const next = waiting ? `${waiting} ${text}` : text;
    const ok = writeQueued(store(), key, next);
    setQueued(readQueued(store(), key));
    return ok;
  }, [key]);

  const retry = useCallback(() => setError(null), []);

  return { queued, echo, error, enqueue, retry };
}
