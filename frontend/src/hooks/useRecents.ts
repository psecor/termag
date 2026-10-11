import { useCallback, useEffect, useRef, useState } from 'react';
import { visitsApi, RecentRow, VISIT_RECORDED_EVENT } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const CACHE_PREFIX = 'termag:recents:';
const POLL_MS = 30_000;
// Visits are posted via sendBeacon; give the server a beat to write the row
// before we re-read, or the just-opened session is missing from the top.
const AFTER_VISIT_MS = 600;

// Cache is keyed by user so a different account on the same browser profile
// never sees the previous user's project names, even for one paint.
function cacheKey(userId: string): string { return CACHE_PREFIX + userId; }

function readCache(userId: string | null): RecentRow[] | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as RecentRow[]) : null;
  } catch { return null; }
}

/**
 * The user's recent sessions, newest first. Server is the source of truth
 * (visits are recorded there); the last default-sized payload is cached per
 * user in localStorage so the sidebar switcher renders instantly on page load.
 * Polls while the tab is visible and refreshes right after a visit is recorded.
 *
 * `refresh` is stable for a given `limit`, so it is safe in effect deps.
 * Responses are sequenced: when `limit` changes mid-flight, an older response
 * can never overwrite a newer one.
 */
export function useRecents(limit: number | 'all' = 10): { rows: RecentRow[] | null; loading: boolean; refresh: () => void } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState<RecentRow[] | null>(() => {
    const cached = readCache(userId);
    if (!cached) return null;
    return limit === 'all' ? cached : cached.slice(0, limit);
  });
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const data = await visitsApi.recent(limit);
      if (my !== seq.current) return; // superseded (newer request or unmounted)
      setRows(data);
      // Cache only the default-sized list so the first paint stays small.
      if (limit !== 'all' && userId) {
        try { localStorage.setItem(cacheKey(userId), JSON.stringify(data)); } catch { /* ignore */ }
      }
    } catch { /* keep last good rows */ }
    finally { if (my === seq.current) setLoading(false); }
  }, [limit, userId]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => { void load(); }, POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.visibilityState === 'visible') { void load(); start(); } else stop(); };
    const onVisit = () => { setTimeout(() => { void load(); }, AFTER_VISIT_MS); };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener(VISIT_RECORDED_EVENT, onVisit);
    return () => {
      seq.current++; // invalidate any in-flight response for the old limit/user
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener(VISIT_RECORDED_EVENT, onVisit);
    };
  }, [load]);

  const refresh = useCallback(() => { void load(); }, [load]);
  return { rows, loading, refresh };
}
