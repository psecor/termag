import { useEffect, useState } from 'react';
import { warmPoolApi } from '../services/api';

/**
 * Whether a warm-pool box is ready to claim right now (GET /api/warm-pool),
 * read once while `active`: what makes a
 * box that can't come from the pool (another disk, utils/boxDisk.ts) slower.
 * False until it answers, and on a failure.
 */
export function useWarmBoxReady(active: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    warmPoolApi.get().then(p => { if (!cancelled) setReady(p.warm > 0); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);
  return ready;
}
