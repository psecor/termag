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

/** Per-pane socket state in Terminal — not the same as the global ConnectionState. */
export type TerminalPaneState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'parked';

export interface ConnectionSample {
  now: number;
  /** Epoch ms of the last proof the server was reachable, from any source; null before first contact. */
  lastContactAt: number | null;
  /**
   * Epoch ms of the last frame that actually arrived on the status socket.
   * Tracked apart from `lastContactAt` because an HTTP response only proves
   * the server is reachable — it says nothing about this socket, and letting
   * it refresh the socket's clock would keep a half-open socket looking alive.
   */
  lastSocketContactAt: number | null;
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
  /**
   * Minimum gap between two foreground-triggered reconnects. `visibilitychange`
   * and `focus` both fire when a tab comes back, and they must not open two
   * sockets.
   */
  reconnectThrottleMs: 1_000,
} as const;

/**
 * Time the socket has been silent, for the purposes of trusting it. Only frames
 * that arrived on the socket count; HTTP evidence is deliberately excluded so a
 * probe or a REST call cannot make a dead socket look alive.
 */
function socketQuietMs(s: Pick<ConnectionSample, 'now' | 'lastSocketContactAt'>): number | null {
  if (s.lastSocketContactAt == null) return null;
  return s.now - s.lastSocketContactAt;
}

export function deriveConnectionState(s: ConnectionSample): ConnectionState {
  if (s.consecutiveFailures >= CONNECTION_THRESHOLDS.offlineAfterFailures) return 'offline';
  if (s.lastContactAt == null) {
    // Still connecting for the first time. Not "offline" yet — we have no
    // evidence either way — but not online either.
    return 'degraded';
  }
  // An open socket is judged on its own traffic; a closed one on any contact,
  // so a reachable server during a reconnect reads as degraded, not offline.
  const quiet = s.socketOpen
    ? socketQuietMs(s) ?? s.now - s.lastContactAt
    : s.now - s.lastContactAt;
  if (quiet >= CONNECTION_THRESHOLDS.offlineAfterMs) return 'offline';
  if (quiet >= CONNECTION_THRESHOLDS.degradedAfterMs) return 'degraded';
  if (!s.socketOpen) return 'degraded';
  return 'online';
}

/** True when the socket claims to be open but has been silent long enough to distrust it. */
export function isSocketStale(s: Pick<ConnectionSample, 'now' | 'lastSocketContactAt' | 'socketOpen'>): boolean {
  if (!s.socketOpen) return false;
  const quiet = socketQuietMs(s);
  if (quiet == null) return false;
  return quiet >= CONNECTION_THRESHOLDS.socketStaleMs;
}

export interface ForegroundReconnectInput {
  now: number;
  /** Epoch ms of the last frame on the status socket; null if none has arrived. */
  lastSocketContactAt: number | null;
  socketOpen: boolean;
  /** Epoch ms of the previous foreground-triggered reconnect; null if there wasn't one. */
  lastReconnectAt: number | null;
}

/**
 * Whether coming back to the tab should tear the status socket down and open a
 * new one at once, instead of waiting for the reconnect timer.
 *
 * A backgrounded tab gets its timers throttled and a frozen one stops answering
 * the server's pings altogether, so the socket is routinely dead — or killed by
 * the server — by the time the user looks again, with nothing on the client
 * having noticed. Reconnecting on sight is the only thing that heals that
 * without a click. A socket that carried a frame within the last heartbeat
 * interval is left alone: it is demonstrably live, and churning it on every
 * alt-tab would cost a round trip for nothing.
 */
export function shouldReconnectOnForeground(i: ForegroundReconnectInput): boolean {
  if (i.lastReconnectAt != null && i.now - i.lastReconnectAt < CONNECTION_THRESHOLDS.reconnectThrottleMs) {
    return false;
  }
  if (!i.socketOpen) return true;
  const quiet = socketQuietMs(i);
  if (quiet == null) return true;
  return quiet >= CONNECTION_THRESHOLDS.heartbeatMs;
}

/**
 * When the global connection returns to online, kick a pane that is sitting
 * on a backoff timer — but not one that is already attaching. reconnectNow
 * puts every pane into `connecting` first; if this then also fired, it would
 * tear down that in-flight socket and open a second one.
 */
export function shouldKickTerminalOnGlobalRecovery(
  previousGlobal: ConnectionState,
  global: ConnectionState,
  pane: TerminalPaneState,
): boolean {
  if (previousGlobal === 'online' || global !== 'online') return false;
  if (pane === 'connected' || pane === 'connecting') return false;
  return true;
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

// ── Full-screen takeover for sustained offline ─────────────────────────────
//
// Degraded gets a banner only: it covers short self-healing blips (backend
// restart, ALB idle drop) and a full-screen flash on every hot-patch would be
// noise. Offline is sustained loss, and there every terminal pane is a stale
// snapshot that looks live, so the whole view dims behind a centered notice.

export const TAKEOVER = {
  /** Offline must persist this long before the takeover appears, so a flap that recovers at once never shows it. */
  delayMs: 4_000,
  /** How long "peek at the stale terminals" hides the takeover before it returns on its own. */
  peekMs: 30_000,
  /** How long the "reconnected" note lingers after recovery. */
  reconnectedNoteMs: 3_000,
} as const;

export interface TakeoverInput {
  state: ConnectionState;
  /** Epoch ms when the state last became offline; null when not offline. */
  offlineSince: number | null;
  /** Epoch ms until which the user has asked to peek; null when not peeking. */
  peekUntil: number | null;
  now: number;
}

export function takeoverVisible(i: TakeoverInput): boolean {
  if (i.state !== 'offline' || i.offlineSince == null) return false;
  if (i.now - i.offlineSince < TAKEOVER.delayMs) return false;
  if (i.peekUntil != null && i.now < i.peekUntil) return false;
  return true;
}

/** Mirrors DRAIN_CLOSE_CODE in backend/src/services/orchestratorDrain.ts. */
export const DRAIN_CLOSE_CODE = 4503;
export const STATUS_RECONNECT_MS = 3000;

/**
 * When the status socket redials after a close. A draining orchestrator (a
 * deploy) closes with DRAIN_CLOSE_CODE while another process already serves,
 * so that one redials at once, with jitter so a room full of tabs doesn't land
 * in the same millisecond.
 */
export function statusReconnectDelayMs(code: number, random: () => number = Math.random): number {
  return code === DRAIN_CLOSE_CODE ? 250 + Math.floor(random() * 500) : STATUS_RECONNECT_MS;
}
