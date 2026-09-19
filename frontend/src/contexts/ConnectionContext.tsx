import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  CONNECTION_THRESHOLDS as T,
  ConnectionState,
  deriveConnectionState,
} from '../utils/connection';
import { connectionTracker, TrackerSnapshot } from '../utils/connectionTracker';

export { connectionTracker } from '../utils/connectionTracker';

/**
 * Cheap reachability probe against the unauthenticated health endpoint. Used
 * on tab-visible and while we already believe we're not online, so it never
 * churns the session cookie path and is safe to run every few seconds.
 */
export async function probeBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), T.probeTimeoutMs);
  try {
    // Any HTTP response at all counts: the point is "did the request reach a
    // termag server", not "is it healthy". `cache: no-store` defeats the
    // browser serving a cached 200 while the network is down.
    await fetch('/termag/public/status', { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    connectionTracker.contact();
    return true;
  } catch {
    connectionTracker.failure();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface ConnectionContextValue {
  state: ConnectionState;
  /** Epoch ms of the last proof of reachability, or null before first contact. */
  lastContactAt: number | null;
  /** Current clock, re-rendered on the provider's tick so "since" readouts stay live. */
  now: number;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  state: 'online',
  lastContactAt: null,
  now: Date.now(),
});

const TICK_MS = 2_000;
const TITLE_PREFIX = '⚠ offline · ';

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [snap, setSnap] = useState<TrackerSnapshot>(connectionTracker.snapshot);
  const [now, setNow] = useState(Date.now());

  // Follow the tracker.
  useEffect(() => connectionTracker.subscribe(() => setSnap(connectionTracker.snapshot)), []);

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
    if (snap.socketOpen && snap.lastContactAt != null && now - snap.lastContactAt >= T.socketStaleMs) {
      connectionTracker.closeSocket?.();
    }
  }, [now, snap.socketOpen, snap.lastContactAt]);

  // Probe while not online, and immediately when the tab comes back into view.
  // Background tabs get their timers throttled, so "I came back to the session"
  // is exactly when the stale-socket case needs a fresh answer.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    if (state !== 'online') {
      id = setInterval(() => { void probeBackend(); }, T.probeIntervalMs);
    }
    const onVis = () => { if (document.visibilityState === 'visible') void probeBackend(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [state]);

  // Make it visible in the tab strip too.
  useEffect(() => {
    const base = document.title.startsWith(TITLE_PREFIX) ? document.title.slice(TITLE_PREFIX.length) : document.title;
    document.title = state === 'offline' ? TITLE_PREFIX + base : base;
  }, [state]);

  return (
    <ConnectionContext.Provider value={{ state, lastContactAt: snap.lastContactAt, now }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export const useConnection = () => useContext(ConnectionContext);
