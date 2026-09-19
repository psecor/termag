// Pure model for "can this page reach the termag backend right now?".
//
// Why this exists: the status WebSocket is receive-only from the browser's
// side and the server's keepalive pings are invisible to page JavaScript. When
// the network dies underneath us (VPN drop, laptop sleep) the socket becomes
// half-open: no close event, no error, just silence — which is exactly what a
// healthy, quiet socket looks like. So the UI kept streaming the starfield at
// the last known speed with every status dot frozen green.
//
// The fix is to treat *time since the server last said anything* as the
// signal, fed by three sources the ConnectionProvider wires up:
//   - every message on the status socket (the server now sends a heartbeat on
//     the same 25s cadence as its protocol ping),
//   - every REST response, success or HTTP error (an HTTP error still proves
//     the server is reachable; only network-level failures count against us),
//   - an explicit probe of the health endpoint when the tab becomes visible
//     again or while we already believe we're offline.
//
// Kept free of React and DOM so the thresholds can be unit-tested.

export type ConnectionState = 'online' | 'degraded' | 'offline';

export interface ConnectionSample {
  now: number;
  /** Epoch ms of the last proof the server was reachable; null before first contact. */
  lastContactAt: number | null;
  /** Whether the status WebSocket currently reports itself open. */
  socketOpen: boolean;
  /** Network-level failures since the last successful contact. */
  consecutiveFailures: number;
}

export const CONNECTION_THRESHOLDS = {
  /** Server heartbeat cadence (backend WS_HEARTBEAT_MS). Thresholds are set relative to it. */
  heartbeatMs: 25_000,
  /** One missed heartbeat plus slack → degraded. */
  degradedAfterMs: 40_000,
  /** Two missed heartbeats plus slack → offline. */
  offlineAfterMs: 75_000,
  /** Network-level failures in a row that mean offline regardless of timers. */
  offlineAfterFailures: 3,
  /**
   * Quiet time after which the client force-closes the status socket so the
   * reconnect loop runs. Closing a half-open socket locally fires onclose
   * immediately; a real reconnect then either succeeds (contact) or fails
   * (failure), both of which move the state machine.
   */
  socketStaleMs: 60_000,
  /** How often to re-probe the health endpoint while not online. */
  probeIntervalMs: 10_000,
  /** Timeout for a single probe. */
  probeTimeoutMs: 5_000,
} as const;

export function deriveConnectionState(s: ConnectionSample): ConnectionState {
  if (s.consecutiveFailures >= CONNECTION_THRESHOLDS.offlineAfterFailures) return 'offline';
  if (s.lastContactAt == null) {
    // Still connecting for the first time. Not "offline" yet — we have no
    // evidence either way — but not online either.
    return 'degraded';
  }
  const quiet = s.now - s.lastContactAt;
  if (quiet >= CONNECTION_THRESHOLDS.offlineAfterMs) return 'offline';
  if (quiet >= CONNECTION_THRESHOLDS.degradedAfterMs) return 'degraded';
  if (!s.socketOpen) return 'degraded';
  return 'online';
}

/** True when the socket claims to be open but has been silent long enough to distrust it. */
export function isSocketStale(s: Pick<ConnectionSample, 'now' | 'lastContactAt' | 'socketOpen'>): boolean {
  if (!s.socketOpen || s.lastContactAt == null) return false;
  return s.now - s.lastContactAt >= CONNECTION_THRESHOLDS.socketStaleMs;
}

/** Compact "how long ago" for the footer readout: 12s, 3m, 1h 05m. */
export function formatSince(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * How the starfield should render for a given state. `speedScale` multiplies
 * the activity-driven warp; `tint` is the colour every star is blended toward
 * and `tintMix` how far (0 = untouched). The component eases toward these
 * targets frame by frame so offline reads as "drifting to a stop", not a cut.
 */
export function starfieldTargets(state: ConnectionState): {
  speedScale: number;
  tint: [number, number, number];
  tintMix: number;
} {
  switch (state) {
    case 'offline':
      // Dead stop, desaturated: a cool grey so it can't be mistaken for the
      // slow blue-white drift that means "idle but connected".
      return { speedScale: 0, tint: [120, 118, 125], tintMix: 0.85 };
    case 'degraded':
      // A crawl, warmed toward amber: something is being retried.
      return { speedScale: 0.15, tint: [255, 176, 60], tintMix: 0.55 };
    default:
      return { speedScale: 1, tint: [255, 255, 255], tintMix: 0 };
  }
}
