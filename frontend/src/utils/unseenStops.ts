/**
 * "Stopped since you looked": a workstream whose agent
 * came to rest after its owner last had it on screen keeps a marker until
 * they open it. Pure helpers so the ageing and the storage round trip are
 * testable without a DOM; ProjectControl owns the state.
 *
 * Seen times are per browser (localStorage), keyed by project and workstream
 * id so a rename keeps them. The first read on a browser sets a
 * baseline, so a fresh install doesn't light up everything that stopped today.
 */
export const SEEN_STOPS_KEY = 'termag-seen-stops';
/** Strong marker for this long after the stop. */
export const UNSEEN_FRESH_MS = 15 * 60 * 1000;
/** Then dimmer up to this age, then faint. */
export const UNSEEN_RECENT_MS = 60 * 60 * 1000;
/** Gone after this, seen or not. */
export const UNSEEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export type UnseenAge = 'fresh' | 'recent' | 'old';

export interface SeenStops {
  /** Baseline: stops before this count as seen for keys with no entry. */
  since: number;
  seen: Record<string, number>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readSeenStops(storage: StorageLike | null, now: number): SeenStops {
  try {
    const raw = storage?.getItem(SEEN_STOPS_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<SeenStops> : null;
    if (parsed && typeof parsed.since === 'number' && parsed.seen && typeof parsed.seen === 'object') {
      const seen: Record<string, number> = {};
      // Entries older than the marker's lifetime can't hide anything any more.
      for (const [k, v] of Object.entries(parsed.seen)) {
        if (typeof v === 'number' && now - v < UNSEEN_MAX_AGE_MS) seen[k] = v;
      }
      return { since: parsed.since, seen };
    }
  } catch { /* corrupt or unavailable: start over */ }
  const fresh = { since: now, seen: {} };
  writeSeenStops(storage, fresh);
  return fresh;
}

export function writeSeenStops(storage: StorageLike | null, store: SeenStops): void {
  try { storage?.setItem(SEEN_STOPS_KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

/**
 * Two views of the store (this tab's and what another tab saved) combined:
 * the later seen time per key wins, and the earlier baseline.
 */
export function mergeSeenStops(a: SeenStops, b: SeenStops): SeenStops {
  const seen = { ...a.seen };
  for (const [k, v] of Object.entries(b.seen)) if (!(seen[k] >= v)) seen[k] = v;
  return { since: Math.min(a.since, b.since), seen };
}

/**
 * Mark a session seen as of `now`, or as of its stop when that is later: the
 * stop time is the server's clock, and a browser running behind it would
 * otherwise leave the session you just watched stop marked unseen.
 */
export function markSeen(store: SeenStops, key: string, now: number, stoppedAt?: string | null): SeenStops {
  const stop = stoppedAt ? Date.parse(stoppedAt) : NaN;
  const at = Number.isFinite(stop) ? Math.max(now, stop) : now;
  if ((store.seen[key] ?? 0) >= at) return store;
  return { ...store, seen: { ...store.seen, [key]: at } };
}

/** How long ago the session stopped unseen, or null when there's nothing to mark. */
export function unseenStopAge(
  store: SeenStops,
  key: string,
  status: string | undefined,
  stoppedAt: string | null | undefined,
  now: number,
): UnseenAge | null {
  if (status !== 'idle' && status !== 'not_running') return null;
  const stop = stoppedAt ? Date.parse(stoppedAt) : NaN;
  if (!Number.isFinite(stop)) return null;
  if (stop <= (store.seen[key] ?? store.since)) return null;
  const age = Math.max(0, now - stop);
  if (age >= UNSEEN_MAX_AGE_MS) return null;
  return age < UNSEEN_FRESH_MS ? 'fresh' : age < UNSEEN_RECENT_MS ? 'recent' : 'old';
}

/** "now", "12m", "3h" — the stopped list's age column. */
export function formatStopAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
