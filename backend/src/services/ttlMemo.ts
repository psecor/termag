/**
 * Single-value TTL memo
 *
 * Holds one in-flight promise, stamped when the load starts. Fresh while
 * `clock() - loadedAt < ttlMs`. A rejection is forgotten so the next call
 * retries, and the forget-handler is what keeps a rejected load from becoming
 * an unhandled rejection when the caller has not attached one yet.
 *
 * The clock is injected so a test can expire the entry without sleeping.
 */

interface MemoState<T> {
  loadedAt: number;
  value: Promise<T>;
}

export function ttlMemo<T>(
  load: () => Promise<T>,
  ttlMs: number,
  clock: () => number = Date.now,
): () => Promise<T> {
  let state: MemoState<T> | null = null;

  return () => {
    const now = clock();
    if (state && now - state.loadedAt < ttlMs) return state.value;

    const value = load();
    state = { loadedAt: now, value };
    void value.catch(() => {
      if (state?.value === value) state = null;
    });
    return value;
  };
}

/**
 * Stale-while-revalidate over one value. Fresh (younger than `freshMs`): the
 * value. Stale but younger than `maxStaleMs`: the old value at once, and one
 * reload in the background whose result serves the next call. Older than
 * that, or never loaded: the caller waits for the load. A failed background
 * reload keeps the old value, so a GitHub blip does not blank a dashboard;
 * the ceiling keeps a lasting failure (a revoked token) from hiding forever.
 */
export function swrMemo<T>(
  load: () => Promise<T>,
  freshMs: number,
  maxStaleMs: number,
  clock: () => number = Date.now,
): () => Promise<T> {
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  const reload = (): Promise<T> => {
    inflight ??= load()
      .then(v => { value = { v, at: clock() }; return v; })
      .finally(() => { inflight = null; });
    return inflight;
  };

  return () => {
    const age = value ? clock() - value.at : Infinity;
    if (value && age < freshMs) return Promise.resolve(value.v);
    if (value && age < maxStaleMs) {
      reload().catch(() => { /* keep serving the old value until maxStaleMs */ });
      return Promise.resolve(value.v);
    }
    return reload();
  };
}
