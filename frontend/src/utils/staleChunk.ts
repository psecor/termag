// Recovering from a deploy that happened under an open page.
//
// Every built asset carries a content hash in its name, and the orchestrator
// is replaced wholesale on each roll, so the new instance only has the new
// names. A page loaded before the roll still holds the old main bundle, which
// imports the old chunk names when a lazy route (the phone client, Settings,
// the dashboard…) is first visited. The server answers an unknown path under
// the app with the SPA page itself, so the import rejects with a module /
// MIME error and, without a boundary, React unmounts everything: a blank
// screen that a reload fixes. These helpers make that reload automatic,
// once, and give the boundary a way to tell this case from a real crash.

/** sessionStorage key: when this tab last reloaded for a stale chunk. */
export const RELOAD_GUARD_KEY = 'termag-chunk-reload-at';
/** Reload at most once per this window per tab, so a truly broken build cannot loop. */
export const RELOAD_GUARD_MS = 60_000;

const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk|'text\/html' is not a valid JavaScript MIME type|Expected a JavaScript module script/i;

/** Does this error look like a failed lazy import (a stale chunk name) rather than app logic? */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : '';
  return CHUNK_ERROR_RE.test(msg);
}

/**
 * Should the page reload now for a stale chunk? Records the attempt so the
 * next call within RELOAD_GUARD_MS says no (the build really is broken, or
 * the server keeps serving a page whose chunks do not exist).
 */
export function shouldReloadForStaleChunk(storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined, now: number): boolean {
  if (!storage) return false;   // nothing to guard with: reloading blind could loop
  try {
    const last = Number(storage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false;
    storage.setItem(RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    // No storage (private mode) means no guard; reloading blind could loop.
    return false;
  }
}
