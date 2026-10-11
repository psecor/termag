/**
 * Connection state for a polling client. The web derives this from status
 * socket silence (frontend/src/utils/connection.ts: 40s degraded, 75s offline,
 * 3 failures offline). Polling gives faster negative evidence, so a single
 * failed poll already degrades.
 */
export type ConnectionState = 'live' | 'degraded' | 'offline';

export const POLL_THRESHOLDS = {
  degradedAfterMs: 40_000,
  offlineAfterMs: 75_000,
  offlineAfterFailures: 3,
} as const;

export interface Contact { lastOkAt: number | null; consecutiveFailures: number }

export function connectionState(c: Contact, now: number): ConnectionState {
  if (c.consecutiveFailures >= POLL_THRESHOLDS.offlineAfterFailures) return 'offline';
  if (c.lastOkAt == null) return c.consecutiveFailures > 0 ? 'degraded' : 'live';
  const silent = now - c.lastOkAt;
  if (silent >= POLL_THRESHOLDS.offlineAfterMs) return 'offline';
  if (silent >= POLL_THRESHOLDS.degradedAfterMs || c.consecutiveFailures > 0) return 'degraded';
  return 'live';
}
