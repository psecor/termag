import { describe, it, expect } from 'vitest';
import {
  CONNECTION_THRESHOLDS as T,
  deriveConnectionState,
  formatSince,
  isSocketStale,
  shouldKickTerminalOnGlobalRecovery,
  shouldReconnectOnForeground,
  starfieldTargets,
  DRAIN_CLOSE_CODE,
  STATUS_RECONNECT_MS,
  statusReconnectDelayMs,
} from './connection';

const NOW = 1_000_000_000;

function sample(over: Partial<Parameters<typeof deriveConnectionState>[0]> = {}) {
  return {
    now: NOW,
    lastContactAt: NOW - 1000,
    lastSocketContactAt: NOW - 1000,
    socketOpen: true,
    consecutiveFailures: 0,
    ...over,
  };
}

describe('deriveConnectionState', () => {
  it('is online with an open socket and recent contact', () => {
    expect(deriveConnectionState(sample())).toBe('online');
  });

  it('is degraded, not offline, before any contact has been made', () => {
    expect(deriveConnectionState(sample({ lastContactAt: null, lastSocketContactAt: null, socketOpen: false }))).toBe('degraded');
  });

  it('is degraded while the socket is closed but contact is still recent', () => {
    // Server restart: clean close, reconnect loop running, REST still answering.
    expect(deriveConnectionState(sample({ socketOpen: false }))).toBe('degraded');
  });

  it('stays online through the normal heartbeat gap', () => {
    // The socket is quiet for up to one heartbeat interval in the healthy case.
    const at = NOW - T.heartbeatMs - 5000;
    expect(deriveConnectionState(sample({ lastContactAt: at, lastSocketContactAt: at }))).toBe('online');
  });

  it('goes degraded after one missed heartbeat even though the socket looks open', () => {
    // The half-open-socket case: nothing closed, nothing arrived.
    const at = NOW - T.degradedAfterMs;
    expect(deriveConnectionState(sample({ lastContactAt: at, lastSocketContactAt: at }))).toBe('degraded');
  });

  it('goes offline after two missed heartbeats', () => {
    const at = NOW - T.offlineAfterMs;
    expect(deriveConnectionState(sample({ lastContactAt: at, lastSocketContactAt: at }))).toBe('offline');
  });

  it('does not let HTTP contact vouch for a silent open socket', () => {
    // A health probe answering proves the server is up, not that this socket
    // still carries frames. Through the OIDC edge the probe is the one request
    // that keeps succeeding, so counting it would pin the UI at "online" over a
    // dead socket.
    expect(deriveConnectionState(sample({
      lastContactAt: NOW - 1000,
      lastSocketContactAt: NOW - T.offlineAfterMs,
    }))).toBe('offline');
  });

  it('still uses HTTP contact while the socket is closed', () => {
    // Mid-reconnect the socket has nothing to say; a reachable server should
    // read as degraded rather than offline.
    expect(deriveConnectionState(sample({
      socketOpen: false,
      lastContactAt: NOW - 1000,
      lastSocketContactAt: NOW - T.offlineAfterMs,
    }))).toBe('degraded');
  });

  it('goes offline immediately on enough consecutive network failures', () => {
    // Recent contact does not save us: the failures are newer evidence.
    expect(deriveConnectionState(sample({ consecutiveFailures: T.offlineAfterFailures }))).toBe('offline');
    expect(deriveConnectionState(sample({ consecutiveFailures: T.offlineAfterFailures - 1 }))).toBe('online');
  });

  it('failures before first contact also mean offline', () => {
    expect(deriveConnectionState(sample({ lastContactAt: null, lastSocketContactAt: null, socketOpen: false, consecutiveFailures: 3 }))).toBe('offline');
  });
});

describe('isSocketStale', () => {
  it('is false for a closed socket or before first contact', () => {
    expect(isSocketStale({ now: NOW, lastSocketContactAt: NOW - 999_999, socketOpen: false })).toBe(false);
    expect(isSocketStale({ now: NOW, lastSocketContactAt: null, socketOpen: true })).toBe(false);
  });

  it('flips once an open socket has been quiet past the stale threshold', () => {
    expect(isSocketStale({ now: NOW, lastSocketContactAt: NOW - T.socketStaleMs + 1, socketOpen: true })).toBe(false);
    expect(isSocketStale({ now: NOW, lastSocketContactAt: NOW - T.socketStaleMs, socketOpen: true })).toBe(true);
  });

  it('stale threshold sits between degraded and offline so the reconnect runs before we call it offline', () => {
    expect(T.socketStaleMs).toBeGreaterThan(T.degradedAfterMs);
    expect(T.socketStaleMs).toBeLessThan(T.offlineAfterMs);
  });
});

describe('shouldReconnectOnForeground', () => {
  const base = { now: NOW, lastSocketContactAt: NOW - 1000, socketOpen: true, lastReconnectAt: null };

  it('reconnects when the socket is closed', () => {
    expect(shouldReconnectOnForeground({ ...base, socketOpen: false })).toBe(true);
  });

  it('reconnects an open socket that has been quiet for a heartbeat or more', () => {
    // The frozen-tab case: the server may already have terminated it for a
    // missed pong, with no close event delivered to a frozen page.
    expect(shouldReconnectOnForeground({ ...base, lastSocketContactAt: NOW - T.heartbeatMs })).toBe(true);
  });

  it('leaves a socket alone when it carried a frame within the last heartbeat', () => {
    // A quick alt-tab should not cost a reconnect round trip.
    expect(shouldReconnectOnForeground({ ...base, lastSocketContactAt: NOW - T.heartbeatMs + 1 })).toBe(false);
  });

  it('reconnects when the socket claims to be open but never delivered anything', () => {
    expect(shouldReconnectOnForeground({ ...base, lastSocketContactAt: null })).toBe(true);
  });

  it('throttles the second of the visibilitychange/focus pair', () => {
    // Both events fire on tab return; only one socket should come of it.
    expect(shouldReconnectOnForeground({ ...base, socketOpen: false, lastReconnectAt: NOW })).toBe(false);
    expect(shouldReconnectOnForeground({
      ...base,
      socketOpen: false,
      lastReconnectAt: NOW - T.reconnectThrottleMs,
    })).toBe(true);
  });

  it('throttle window is shorter than the reconnect delay it replaces', () => {
    expect(T.reconnectThrottleMs).toBeLessThan(3_000);
  });
});

describe('shouldKickTerminalOnGlobalRecovery', () => {
  it('kicks a pane sitting on backoff when the backend returns', () => {
    expect(shouldKickTerminalOnGlobalRecovery('offline', 'online', 'reconnecting')).toBe(true);
    expect(shouldKickTerminalOnGlobalRecovery('degraded', 'online', 'failed')).toBe(true);
  });

  it('does not tear down an in-flight attach that reconnectNow already started', () => {
    // Status socket coming online after reconnectNow would otherwise retry
    // again because connecting !== connected.
    expect(shouldKickTerminalOnGlobalRecovery('offline', 'online', 'connecting')).toBe(false);
  });

  it('does not kick a pane that still looks connected', () => {
    expect(shouldKickTerminalOnGlobalRecovery('offline', 'online', 'connected')).toBe(false);
  });

  it('does not kick unless the global state just became online', () => {
    expect(shouldKickTerminalOnGlobalRecovery('online', 'online', 'reconnecting')).toBe(false);
    expect(shouldKickTerminalOnGlobalRecovery('offline', 'degraded', 'failed')).toBe(false);
  });
});

describe('formatSince', () => {
  it('formats seconds, minutes, and hours compactly', () => {
    expect(formatSince(0)).toBe('0s');
    expect(formatSince(12_400)).toBe('12s');
    expect(formatSince(3 * 60_000 + 5000)).toBe('3m');
    expect(formatSince(65 * 60_000)).toBe('1h 05m');
    expect(formatSince(-5)).toBe('0s');
  });
});

describe('starfieldTargets', () => {
  it('online leaves the stars untouched', () => {
    expect(starfieldTargets('online')).toEqual({ speedScale: 1, tint: [255, 255, 255], tintMix: 0 });
  });

  it('offline stops the stars and desaturates them', () => {
    const t = starfieldTargets('offline');
    expect(t.speedScale).toBe(0);
    expect(t.tintMix).toBeGreaterThan(0.5);
    // Grey: channels within a narrow band of each other.
    expect(Math.max(...t.tint) - Math.min(...t.tint)).toBeLessThan(20);
  });

  it('degraded is a distinct look: still moving, warm tint', () => {
    const t = starfieldTargets('degraded');
    expect(t.speedScale).toBeGreaterThan(0);
    expect(t.speedScale).toBeLessThan(0.5);
    expect(t.tint[0]).toBeGreaterThan(t.tint[2]); // red > blue = warm
    expect(t.tintMix).toBeGreaterThan(0);
    expect(t.tint).not.toEqual(starfieldTargets('offline').tint);
  });
});

import { TAKEOVER, takeoverVisible } from './connection';

describe('takeoverVisible', () => {
  const base = { state: 'offline' as const, offlineSince: NOW - TAKEOVER.delayMs - 1, peekUntil: null, now: NOW };

  it('shows once offline has persisted past the delay', () => {
    expect(takeoverVisible(base)).toBe(true);
  });

  it('does not flash for an offline that has only just begun', () => {
    expect(takeoverVisible({ ...base, offlineSince: NOW - TAKEOVER.delayMs + 1 })).toBe(false);
  });

  it('never shows for degraded or online, even with a stale offlineSince', () => {
    expect(takeoverVisible({ ...base, state: 'degraded' })).toBe(false);
    expect(takeoverVisible({ ...base, state: 'online' })).toBe(false);
  });

  it('is hidden while peeking and returns when the peek expires', () => {
    expect(takeoverVisible({ ...base, peekUntil: NOW + 1 })).toBe(false);
    expect(takeoverVisible({ ...base, peekUntil: NOW })).toBe(true);
  });

  it('requires an offlineSince when offline (defensive)', () => {
    expect(takeoverVisible({ ...base, offlineSince: null })).toBe(false);
  });

  it('delay is short enough to feel immediate but longer than the provider tick', () => {
    expect(TAKEOVER.delayMs).toBeGreaterThanOrEqual(2_000);
    expect(TAKEOVER.delayMs).toBeLessThanOrEqual(10_000);
  });
});

describe('statusReconnectDelayMs', () => {
  it('redials within a second after a drain close, with jitter', () => {
    expect(statusReconnectDelayMs(DRAIN_CLOSE_CODE, () => 0)).toBe(250);
    expect(statusReconnectDelayMs(DRAIN_CLOSE_CODE, () => 0.999)).toBe(749);
  });

  it('keeps the usual 3 s after any other close', () => {
    expect(statusReconnectDelayMs(1006)).toBe(STATUS_RECONNECT_MS);
  });
});
