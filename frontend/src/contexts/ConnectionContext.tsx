import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  CONNECTION_THRESHOLDS as T,
  ConnectionState,
  deriveConnectionState,
  isSocketStale,
  shouldReconnectOnForeground,
} from '../utils/connection';
import { connectionTracker, TrackerSnapshot } from '../utils/connectionTracker';

export { connectionTracker } from '../utils/connectionTracker';

/** Health endpoint the probe hits. Must sit under the app's base path. */
export const PROBE_PATH = '/termag/health';

/**
 * Cheap reachability probe against the health endpoint. Used on tab-visible and
 * while we already believe we're not online, so it is safe to run every few
 * seconds.
 *
 * Credentials are included because every `/termag/*` path is behind the edge's
 * OIDC gate on the hosted deployment: a cookie-less request is answered with a
 * redirect to the identity provider, which the browser reports as a network
 * failure cross-origin. Sending the cookie is what makes the probe able to
 * succeed there at all. Once that session expires the edge redirects or
 * answers 401 even with the cookie; the probe then marks the tab signed out
 * (see `markEdgeSignedOut`) rather than following the redirect.
 *
 * A successful probe is evidence about HTTP only. It is recorded as such, so it
 * cannot vouch for the status socket — see `ConnectionSample.lastSocketContactAt`.
 */
export async function probeBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), T.probeTimeoutMs);
  try {
    // Any HTTP response at all counts: the point is "did the request reach a
    // termag server", not "is it healthy". `cache: no-store` defeats the
    // browser serving a cached 200 while the network is down.
    const res = await fetch(PROBE_PATH, { cache: 'no-store', credentials: 'include', redirect: 'manual', signal: ctrl.signal });
    if (isEdgeSessionExpired(res)) {
      markEdgeSignedOut();
      return false;
    }
    setEdgeSignedOut(false);
    connectionTracker.contact('http');
    return true;
  } catch {
    connectionTracker.failure();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health route has no auth of its own, so a redirect (to the identity
 * provider) or a 401 can only come from the edge: the ALB session expired.
 */
export function isEdgeSessionExpired(res: Pick<Response, 'type' | 'status'>): boolean {
  return res.type === 'opaqueredirect' || res.status === 401;
}

let edgeSignedOut = false;
const signedOutListeners = new Set<() => void>();

function setEdgeSignedOut(value: boolean): void {
  if (edgeSignedOut === value) return;
  edgeSignedOut = value;
  signedOutListeners.forEach(fn => fn());
}

/** True while the edge session is expired and nobody has asked to sign in yet. */
export function isEdgeSignedOut(): boolean {
  return edgeSignedOut;
}

/**
 * Note the expired session and wait for the person at this tab. A tab never
 * starts the Okta login by itself: the ALB's AWSALBAuthNonce cookie lives
 * 15 minutes, so a login started while nobody was looking (a probe in a
 * background tab, or a screen waking at night) parks on the Okta page, and
 * signing in there hours later fails the callback with a 401 that no reload
 * fixes. The provider shows the signed-out notice and calls `reauthenticate`
 * on the next click or key press.
 */
export function markEdgeSignedOut(): void {
  setEdgeSignedOut(true);
}

/**
 * Reload so the page navigation, not a background request, runs the Okta
 * login (background requests get a 401 from the ALB rather than a redirect,
 * and must not start logins of their own: each overwrites the nonce cookie).
 * Only call this for the person at the tab; see `markEdgeSignedOut`.
 */
export function reauthenticate(): void {
  edgeLogin.start();
}

/** The navigation itself; an object so a jsdom test can watch it (its location is not stubbable). */
export const edgeLogin = { start: () => window.location.reload() };

/**
 * What "Retry now" does. The probe alone never reattached anything — it only
 * refreshed the last-contact clock — so the user-visible recovery was really
 * the reconnect timer firing while the tab happened to be in front. Reopen the
 * status socket first, unconditionally: this is an explicit request, so it
 * skips the foreground throttle. reconnectNow also kicks every mounted
 * terminal pane, including ones that still look connected (half-open PTYs).
 */
export async function retryConnection(): Promise<boolean> {
  connectionTracker.reconnectNow();
  return probeBackend();
}

interface ConnectionContextValue {
  state: ConnectionState;
  /** Epoch ms of the last proof of reachability, or null before first contact. */
  lastContactAt: number | null;
  /** Current clock, re-rendered on the provider's tick so "since" readouts stay live. */
  now: number;
  /** The edge session expired; the next click or key press signs in again. */
  signedOut: boolean;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  state: 'online',
  lastContactAt: null,
  now: Date.now(),
  signedOut: false,
});

const TICK_MS = 2_000;
const TITLE_PREFIX = '⚠ offline · ';

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [snap, setSnap] = useState<TrackerSnapshot>(connectionTracker.snapshot);
  const [now, setNow] = useState(Date.now());

  // Follow the tracker.
  useEffect(() => connectionTracker.subscribe(() => setSnap(connectionTracker.snapshot)), []);

  // Signed out: the next click, tap or key press is the person at this tab,
  // so it starts the login (see markEdgeSignedOut for why nothing else may).
  const [signedOut, setSignedOut] = useState(edgeSignedOut);
  useEffect(() => {
    const sync = () => setSignedOut(edgeSignedOut);
    signedOutListeners.add(sync);
    sync();
    return () => { signedOutListeners.delete(sync); };
  }, []);
  useEffect(() => {
    if (!signedOut) return;
    const onInteract = () => reauthenticate();
    window.addEventListener('pointerdown', onInteract, true);
    window.addEventListener('keydown', onInteract, true);
    return () => {
      window.removeEventListener('pointerdown', onInteract, true);
      window.removeEventListener('keydown', onInteract, true);
    };
  }, [signedOut]);

  // Tick so time-based transitions (quiet socket) happen without an event.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const state = deriveConnectionState({ now, ...snap });

  // A socket that claims to be open but has been silent too long is presumed
  // half-open. Close it locally: onclose fires at once and the owner's
  // reconnect loop produces real evidence either way.
  useEffect(() => {
    if (isSocketStale({ now, lastSocketContactAt: snap.lastSocketContactAt, socketOpen: snap.socketOpen })) {
      connectionTracker.closeSocket?.();
    }
  }, [now, snap.socketOpen, snap.lastSocketContactAt]);

  // Probe while not online, and reopen the status socket the moment the tab
  // comes back. A backgrounded tab has throttled timers and a frozen one stops
  // answering the server's pings, so the socket is usually gone — or about to
  // be — by the time the user looks at it again. Waiting for the reconnect
  // timer is what left the "connection lost" notice up until someone clicked.
  const lastForegroundReconnectAt = useRef<number | null>(null);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    if (state !== 'online') {
      id = setInterval(() => { void probeBackend(); }, T.probeIntervalMs);
    }
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      const at = Date.now();
      const s = connectionTracker.snapshot;
      if (shouldReconnectOnForeground({
        now: at,
        lastSocketContactAt: s.lastSocketContactAt,
        socketOpen: s.socketOpen,
        lastReconnectAt: lastForegroundReconnectAt.current,
      })) {
        lastForegroundReconnectAt.current = at;
        connectionTracker.reconnectNow();
      }
      void probeBackend();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
    };
  }, [state]);

  // Make it visible in the tab strip too.
  useEffect(() => {
    const base = document.title.startsWith(TITLE_PREFIX) ? document.title.slice(TITLE_PREFIX.length) : document.title;
    document.title = state === 'offline' ? TITLE_PREFIX + base : base;
  }, [state]);

  return (
    <ConnectionContext.Provider value={{ state, lastContactAt: snap.lastContactAt, now, signedOut }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export const useConnection = () => useContext(ConnectionContext);
