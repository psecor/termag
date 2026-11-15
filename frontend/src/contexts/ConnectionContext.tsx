import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  CONNECTION_THRESHOLDS as T,
  ConnectionState,
  deriveConnectionState,
  isSocketStale,
  shouldReconnectOnForeground,
} from '../utils/connection';
import { connectionTracker, TrackerSnapshot } from '../utils/connectionTracker';
import { edgeCheckpoint, isEdgeSignedOut, markEdgeSignedIn, markEdgeSignedOut, onEdgeSessionChange } from '../utils/edgeSession';

export { connectionTracker } from '../utils/connectionTracker';
export { isEdgeSignedOut, markEdgeSignedOut } from '../utils/edgeSession';

/** Health endpoint the probe hits. Must sit under the app's base path. */
export const PROBE_PATH = '/termag/health';

/**
 * Cheap reachability probe against the health endpoint. Used on tab-visible and
 * while we already believe we're not online, so it is safe to run every few
 * seconds.
 *
 * Credentials are included because every `/termag/*` path is behind the edge's
 * OIDC gate on the hosted deployment: a cookie-less request never reaches
 * termag. Sending the cookie is what makes the probe able to succeed there at
 * all. Once that session expires the edge redirects (the
 * browser still holds the expired ALB cookie) or answers 401 (it holds none);
 * the probe then marks every tab signed out (`markEdgeSignedOut`,
 * utils/edgeSession.ts) rather than following the redirect.
 *
 * A successful probe is evidence about HTTP only. It is recorded as such, so it
 * cannot vouch for the status socket — see `ConnectionSample.lastSocketContactAt`.
 */
export async function probeBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), T.probeTimeoutMs);
  const sent = edgeCheckpoint();
  try {
    // Any HTTP response at all counts: the point is "did the request reach a
    // termag server", not "is it healthy". `cache: no-store` defeats the
    // browser serving a cached 200 while the network is down.
    const res = await fetch(PROBE_PATH, { cache: 'no-store', credentials: 'include', redirect: 'manual', signal: ctrl.signal });
    if (isEdgeSessionExpired(res)) {
      markEdgeSignedOut();
      return false;
    }
    markEdgeSignedIn(sent);
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

/**
 * Reload so the page navigation runs the Okta login. Only call this for the
 * person at the tab. A tab never starts the login by itself: the ALB's
 * AWSALBAuthNonce cookie lives 15 minutes, so a login started while nobody was
 * looking (a probe in a background tab, a screen waking at night) parks on the
 * Okta page, and signing in there later fails the callback with a 401 that no
 * reload fixes. Every other tab stays quiet meanwhile (utils/edgeSession.ts),
 * because each request they sent would overwrite this login's nonce.
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
  // so it starts the login (see reauthenticate for why nothing else may).
  // Another tab's finding counts too: it arrives through utils/edgeSession.ts.
  const [signedOut, setSignedOut] = useState(isEdgeSignedOut);
  useEffect(() => {
    const sync = () => setSignedOut(isEdgeSignedOut());
    const off = onEdgeSessionChange(sync);
    sync();
    return off;
  }, []);
  // Back from signed out (this tab's login, or another tab's): check in once.
  // The sockets redial on their own (edgeDialGate).
  const wasSignedOut = useRef(signedOut);
  useEffect(() => {
    if (wasSignedOut.current && !signedOut) void probeBackend();
    wasSignedOut.current = signedOut;
  }, [signedOut]);
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
  // Neither while signed out: each probe would reset the nonce of a login in
  // progress in another tab (utils/edgeSession.ts).
  const lastForegroundReconnectAt = useRef<number | null>(null);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    if (state !== 'online' && !signedOut) {
      // Checked as it fires too: another tab's mark can land before this re-renders.
      id = setInterval(() => { if (!isEdgeSignedOut()) void probeBackend(); }, T.probeIntervalMs);
    }
    const onForeground = () => {
      if (document.visibilityState !== 'visible' || isEdgeSignedOut()) return;
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
  }, [state, signedOut]);

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
