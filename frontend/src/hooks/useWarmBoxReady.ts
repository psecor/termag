import { useEffect, useState } from 'react';
import { warmPoolApi } from '../services/api';
import { FLAGS, useFlag } from '../flags';

/**
 * Whether a warm-pool box is ready to claim right now (GET /api/warm-pool),
 * read once while `active` and the owner is in warm-pool-enabled: what makes a
 * box that can't come from the pool (another disk, utils/boxDisk.ts) slower.
 * False until it answers, and on a failure.
 */
export function useWarmBoxReady(active: boolean): boolean {
  const on = useFlag(FLAGS.warmPool, false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!on || !active) return;
    let cancelled = false;
    warmPoolApi.get().then(p => { if (!cancelled) setReady(p.warm > 0); }).catch(() => {});
    return () => { cancelled = true; };
  }, [on, active]);
  return on && ready;
}
