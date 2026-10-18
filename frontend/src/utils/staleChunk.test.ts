import { describe, it, expect } from 'vitest';
import { isChunkLoadError, RELOAD_GUARD_KEY, RELOAD_GUARD_MS, shouldReloadForStaleChunk } from './staleChunk';

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

describe('isChunkLoadError', () => {
  it('recognises the browsers\' failed-dynamic-import messages', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/termag/assets/MobileApp-BSYyvsvz.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error("Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\"."))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /termag/assets/MobileApp-x.css'))).toBe(true);
  });
  it('leaves ordinary errors alone', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'rows')"))).toBe(false);
    expect(isChunkLoadError(new Error('Request failed with status code 503'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('shouldReloadForStaleChunk', () => {
  const T = 1_760_000_000_000;

  it('reloads the first time and records when', () => {
    const s = memStorage();
    expect(shouldReloadForStaleChunk(s, T)).toBe(true);
    expect(s.dump()).toEqual({ [RELOAD_GUARD_KEY]: String(T) });
  });

  it('refuses a second reload inside the guard window, allows one after it', () => {
    const s = memStorage({ [RELOAD_GUARD_KEY]: String(T) });
    expect(shouldReloadForStaleChunk(s, T + 5_000)).toBe(false);
    expect(shouldReloadForStaleChunk(s, T + RELOAD_GUARD_MS - 1)).toBe(false);
    expect(shouldReloadForStaleChunk(s, T + RELOAD_GUARD_MS)).toBe(true);
    expect(s.getItem(RELOAD_GUARD_KEY)).toBe(String(T + RELOAD_GUARD_MS));
  });

  it('treats garbage in storage as no previous reload', () => {
    expect(shouldReloadForStaleChunk(memStorage({ [RELOAD_GUARD_KEY]: 'nope' }), T)).toBe(true);
  });

  it('does not reload blind when there is no storage to guard with', () => {
    expect(shouldReloadForStaleChunk(null, T)).toBe(false);
    const throwing = { getItem: () => { throw new Error('private mode'); }, setItem: () => {} };
    expect(shouldReloadForStaleChunk(throwing, T)).toBe(false);
  });
});
