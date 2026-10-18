/**
 * Built ledgers, kept for a few minutes. A review reads the index and then
 * several sessions from the same ledger; building one fans out to every box,
 * so each of those calls must not build it again. Concurrent callers for the
 * same key share one build.
 *
 * Keyed by user, window start, timezone and briefing id: a scheduled run's
 * window is fixed, and an on-demand review keeps the start it resolved
 * (its `until` is "now", so a cached copy is at most its TTL old).
 *
 * A briefing run's ledger lives longer than the run can (its window is fixed,
 * and a slow review must not fan out to the boxes again); an on-demand one
 * only a few minutes, since it is "until now".
 */
import type { BriefingWindow, Ledger } from './types';

/** Above the run timeout (runner.ts RUN_TIMEOUT_MS, 20 min), so a slow review never builds twice. */
export const LEDGER_CACHE_TTL_MS = 25 * 60 * 1000;
/** On-demand ledgers end "now"; past this a fresh one is worth the fan-out. */
export const LEDGER_CACHE_LIVE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;

interface Entry { at: number; ttl: number; ledger: Promise<Ledger> }
const entries = new Map<string, Entry>();

export function ledgerCacheKey(userId: string, window: Pick<BriefingWindow, 'since' | 'tz'>, briefingId: string | null): string {
  return `${userId}|${window.since}|${window.tz}|${briefingId ?? ''}`;
}

function prune(now: number): void {
  for (const [k, e] of entries) if (now - e.at >= e.ttl) entries.delete(k);
  // Oldest first (insertion order), should a burst of distinct windows arrive.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
}

/** A live cached ledger for the key, or null. Never builds. */
export function peekLedger(key: string, now: number = Date.now()): Promise<Ledger> | null {
  const e = entries.get(key);
  return e && now - e.at < e.ttl ? e.ledger : null;
}

/**
 * The cached ledger for the key, or `build()`'s. `onMiss` runs before a build
 * and may throw to refuse it (the route's rate limit); a hit never calls it.
 * A failed build is forgotten, so the next call tries again.
 */
export function cachedLedger(
  key: string, build: () => Promise<Ledger>, onMiss?: () => void, now: number = Date.now(), ttl: number = LEDGER_CACHE_TTL_MS,
): Promise<Ledger> {
  const hit = peekLedger(key, now);
  if (hit) return hit;
  onMiss?.();
  prune(now);
  const ledger = build();
  entries.set(key, { at: now, ttl, ledger });
  ledger.catch(() => { if (entries.get(key)?.ledger === ledger) entries.delete(key); });
  return ledger;
}

/** Tests. */
export function clearLedgerCache(): void {
  entries.clear();
}
