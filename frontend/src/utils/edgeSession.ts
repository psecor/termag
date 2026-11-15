// The edge (ALB → Okta) session as every termag tab in this browser sees it.
//
// When the ALB's session times out (session_timeout, 8 hours in production)
// the browser still holds its AWSELBAuthSessionCookie, whose own expiry is 7
// days. To the ALB that is "expired authentication information", and it
// answers any request carrying it, a page or a background fetch or socket, with
// a redirect to Okta that sets a fresh AWSALBAuthNonce cookie. The
// oidc_deny_background rule's 401 is only for a request with no ALB cookie at
// all. The browser has one nonce cookie, and the callback
// (/oauth2/idpresponse) answers 401 unless it still holds the nonce of the
// login coming back. So one tab's probe, poll or socket reconnect during
// another tab's Okta sign-in failed that sign-in, and reloading the callback
// never helps (gotcha auth-okta-login-on-gesture).
//
// So once any tab learns the session expired, every tab goes quiet: no API
// call, socket or probe leaves the browser until a tab has signed in again.
// The mark is shared through localStorage, whose `storage` event reaches the
// other tabs; a tab that gets its user back clears it, which wakes the rest.

import type { AxiosInstance } from 'axios';

/** localStorage key: present (an epoch ms) while the edge session is expired. */
export const EDGE_SIGNED_OUT_KEY = 'termag.edgeSignedOutAt';

let signedOut = false;
/** Counts the marks this tab has made or heard of; a checkpoint holds the count at its send. */
let generation = 0;
const listeners = new Set<() => void>();
/** When this page loaded. A mark from before then is not this page's to adopt (see the end of this file). */
const loadedAt = Date.now();

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The shared mark's time, or null when there is none. */
function sharedMarkAt(): number | null {
  try {
    const raw = storage()?.getItem(EDGE_SIGNED_OUT_KEY);
    if (raw == null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

/** Tell the other tabs. Storage can be unavailable; this tab goes quiet regardless. */
function share(value: boolean, at: number): void {
  const s = storage();
  if (!s) return;
  try {
    if (value) s.setItem(EDGE_SIGNED_OUT_KEY, String(at));
    else if (s.getItem(EDGE_SIGNED_OUT_KEY) != null) s.removeItem(EDGE_SIGNED_OUT_KEY);
  } catch { /* storage full or blocked */ }
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function set(value: boolean): void {
  if (signedOut === value) return;
  signedOut = value;
  notify();
}

/**
 * True while the edge session is expired, as this tab or another one found it.
 * It reads the shared mark too, not only the `storage` event's copy: a tab
 * thawing from the background can run its timers before that event arrives.
 * Such a mark is adopted as this tab's own, so the sign-in that clears it is a
 * change here too and wakes whatever waited on it (edgeDialGate). Listeners
 * hear of the adoption a microtask later, never in the middle of a caller.
 */
export function isEdgeSignedOut(): boolean {
  if (signedOut) return true;
  const at = sharedMarkAt();
  if (at == null || at < loadedAt) return false;
  signedOut = true;
  generation += 1;
  queueMicrotask(notify);
  return true;
}

/**
 * The edge answered a probe with a redirect or a 401: the session expired.
 * Every tab stops sending until one signs in. The tab doesn't start the login
 * itself; it waits for a click or key press (ConnectionContext).
 */
export function markEdgeSignedOut(): void {
  generation += 1;
  if (!signedOut) share(true, Date.now());
  set(true);
}

/** What `markEdgeSignedIn` compares against; take it as the request is sent. */
export interface EdgeCheckpoint {
  readonly generation: number;
  readonly at: number;
}

export function edgeCheckpoint(): EdgeCheckpoint {
  return { generation, at: Date.now() };
}

/**
 * The edge let a request through (a probe, or the page's user loading after a
 * sign-in): every tab may talk again. Clearing the mark wakes the other tabs.
 *
 * `sent` is the request's checkpoint. A request in flight when a tab found the
 * session expired proves nothing about now: its 200 left the edge before the
 * expiry. So a mark made after it was sent stays, here or in another tab not
 * heard from yet; otherwise a stale 200 would wake every tab during a sign-in
 * and reset its nonce.
 */
export function markEdgeSignedIn(sent: EdgeCheckpoint): void {
  if (generation !== sent.generation) return;
  const shared = sharedMarkAt();
  if (shared != null && shared > sent.at) return;
  share(false, 0);
  set(false);
}

/** Calls `fn` whenever this tab's view of the edge session changes. */
export function onEdgeSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * For a socket owner's connect(). `allows(redial)` is true when the socket may
 * dial now. While the edge session is expired it is false, and `redial` runs
 * once a tab has signed in: a dial then would only reach the ALB and start
 * another Okta login. `cancel` drops the wait (the owner's cleanup).
 */
export function edgeDialGate(): { allows(redial: () => void): boolean; cancel(): void } {
  let off: (() => void) | null = null;
  const cancel = () => { off?.(); off = null; };
  return {
    allows(redial) {
      cancel();
      if (!isEdgeSignedOut()) return true;
      const stop = onEdgeSessionChange(() => {
        if (isEdgeSignedOut()) return;
        cancel();
        redial();
      });
      off = stop;
      return false;
    },
    cancel,
  };
}

/** The error a request held by `holdWhileEdgeSignedOut` fails with. It was never sent. */
export class EdgeSignedOutError extends Error {
  constructor() {
    super('Signed out of termag: the request was not sent');
    this.name = 'EdgeSignedOutError';
  }
}

export function isEdgeSignedOutError(err: unknown): err is EdgeSignedOutError {
  return err instanceof EdgeSignedOutError;
}

/**
 * Every request of an axios instance fails at once, unsent, while the edge
 * session is expired. Each termag axios instance installs it
 * (edgeSession.test.ts checks).
 */
export function holdWhileEdgeSignedOut(instance: AxiosInstance): void {
  instance.interceptors.request.use(config => {
    if (isEdgeSignedOut()) throw new EdgeSignedOutError();
    return config;
  });
}

// Another tab's mark or its sign-in. `storage` fires only in the other tabs, so
// this never echoes a tab's own write; a cleared storage (key null) reads as
// signed in. A page doesn't adopt a mark left from before it loaded: it got here
// by a navigation the ALB let through, and its user loading clears the mark.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== null && e.key !== EDGE_SIGNED_OUT_KEY) return;
    if (e.key !== null && e.newValue != null) {
      generation += 1;
      set(true);
    } else {
      set(false);
    }
  });
}
