import { useEffect, useState } from 'react';
import { environmentsApi, type EnvironmentPoolView } from '../services/api';

/**
 * An environment's pool (GET /api/environments/:id/pool), read once per environment while `id` is set: the
 * environment page's pool line and the create dialogs' "ready in about 20 s". Null when it has none, before it
 * answers, and on a failure.
 */
export function useEnvironmentPool(id: string | null | undefined): EnvironmentPoolView | null {
  const [pool, setPool] = useState<{ id: string; pool: EnvironmentPoolView | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // Through a promise, so a failure of any kind (the API mocked without it, too) reads as no pool.
    Promise.resolve().then(() => environmentsApi.pool(id)).then(p => { if (!cancelled) setPool({ id, pool: p }); }).catch(() => { if (!cancelled) setPool({ id, pool: null }); });
    return () => { cancelled = true; };
  }, [id]);
  return id && pool?.id === id ? pool.pool : null;
}
