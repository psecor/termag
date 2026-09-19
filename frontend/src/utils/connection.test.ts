import { describe, it, expect } from 'vitest';
import {
  CONNECTION_THRESHOLDS as T,
  deriveConnectionState,
  formatSince,
  isSocketStale,
  starfieldTargets,
} from './connection';

const NOW = 1_000_000_000;

function sample(over: Partial<Parameters<typeof deriveConnectionState>[0]> = {}) {
  return { now: NOW, lastContactAt: NOW - 1000, socketOpen: true, consecutiveFailures: 0, ...over };
}

describe('deriveConnectionState', () => {
  it('is online with an open socket and recent contact', () => {
    expect(deriveConnectionState(sample())).toBe('online');
  });

  it('is degraded, not offline, before any contact has been made', () => {
    expect(deriveConnectionState(sample({ lastContactAt: null, socketOpen: false }))).toBe('degraded');
  });

  it('is degraded while the socket is closed but contact is still recent', () => {
    // Server restart: clean close, reconnect loop running, REST still answering.
    expect(deriveConnectionState(sample({ socketOpen: false }))).toBe('degraded');
  });

  it('stays online through the normal heartbeat gap', () => {
    // The socket is quiet for up to one heartbeat interval in the healthy case.
    expect(deriveConnectionState(sample({ lastContactAt: NOW - T.heartbeatMs - 5000 }))).toBe('online');
  });

  it('goes degraded after one missed heartbeat even though the socket looks open', () => {
    // The half-open-socket case: nothing closed, nothing arrived.
    expect(deriveConnectionState(sample({ lastContactAt: NOW - T.degradedAfterMs }))).toBe('degraded');
  });

  it('goes offline after two missed heartbeats', () => {
    expect(deriveConnectionState(sample({ lastContactAt: NOW - T.offlineAfterMs }))).toBe('offline');
  });

  it('goes offline immediately on enough consecutive network failures', () => {
    // Recent contact does not save us: the failures are newer evidence.
    expect(deriveConnectionState(sample({ consecutiveFailures: T.offlineAfterFailures }))).toBe('offline');
    expect(deriveConnectionState(sample({ consecutiveFailures: T.offlineAfterFailures - 1 }))).toBe('online');
  });

  it('failures before first contact also mean offline', () => {
    expect(deriveConnectionState(sample({ lastContactAt: null, socketOpen: false, consecutiveFailures: 3 }))).toBe('offline');
  });
});

describe('isSocketStale', () => {
  it('is false for a closed socket or before first contact', () => {
    expect(isSocketStale({ now: NOW, lastContactAt: NOW - 999_999, socketOpen: false })).toBe(false);
    expect(isSocketStale({ now: NOW, lastContactAt: null, socketOpen: true })).toBe(false);
  });

  it('flips once an open socket has been quiet past the stale threshold', () => {
    expect(isSocketStale({ now: NOW, lastContactAt: NOW - T.socketStaleMs + 1, socketOpen: true })).toBe(false);
    expect(isSocketStale({ now: NOW, lastContactAt: NOW - T.socketStaleMs, socketOpen: true })).toBe(true);
  });

  it('stale threshold sits between degraded and offline so the reconnect runs before we call it offline', () => {
    expect(T.socketStaleMs).toBeGreaterThan(T.degradedAfterMs);
    expect(T.socketStaleMs).toBeLessThan(T.offlineAfterMs);
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
