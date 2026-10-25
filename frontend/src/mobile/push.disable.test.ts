import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unsubscribe = vi.fn<(endpoint: string) => Promise<void>>();
vi.mock('../services/api', () => ({ pushApi: { unsubscribe: (e: string) => unsubscribe(e) } }));

import { disablePush, PUSH_CHECK_MS } from './push';

const KEY = 'termag.push.endpoint';

/** A browser whose getSubscription() answers with `answer`, or never when undefined. */
function browser(answer?: { endpoint: string; unsubscribe: () => Promise<boolean> } | null) {
  const store = new Map<string, string>();
  const reg = {
    update: () => Promise.resolve(),
    pushManager: { getSubscription: () => (answer === undefined ? new Promise(() => {}) : Promise.resolve(answer)) },
  };
  vi.stubGlobal('navigator', { serviceWorker: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg) } });
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  });
  return store;
}

describe('disablePush', () => {
  beforeEach(() => { unsubscribe.mockReset(); unsubscribe.mockResolvedValue(undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('unsubscribes on the server, then in the browser', async () => {
    const sub = { endpoint: 'https://push.example/a', unsubscribe: vi.fn(() => Promise.resolve(true)) };
    const store = browser(sub);
    store.set(KEY, 'https://push.example/a');
    expect(await disablePush()).toBe(true);
    expect(unsubscribe.mock.calls).toEqual([['https://push.example/a']]);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
  });

  it('uses the remembered endpoint when the browser never answers (WebKit)', async () => {
    vi.useFakeTimers();
    const store = browser(undefined);
    store.set(KEY, 'https://push.example/a');
    const done = disablePush();
    await vi.advanceTimersByTimeAsync(PUSH_CHECK_MS);
    expect(await done).toBe(true);
    expect(unsubscribe.mock.calls).toEqual([['https://push.example/a']]);
  });

  it('reports failure when the browser never answers and nothing was remembered', async () => {
    vi.useFakeTimers();
    browser(undefined);
    const done = disablePush();
    await vi.advanceTimersByTimeAsync(PUSH_CHECK_MS);
    expect(await done).toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('removes the server row the browser already dropped (Chrome, notifications blocked)', async () => {
    const store = browser(null);
    store.set(KEY, 'https://push.example/a');
    expect(await disablePush()).toBe(true);
    expect(unsubscribe.mock.calls).toEqual([['https://push.example/a']]);
  });

  it('keeps the subscription when the server call fails, so trying again works', async () => {
    unsubscribe.mockRejectedValue(new Error('offline'));
    const sub = { endpoint: 'https://push.example/a', unsubscribe: vi.fn(() => Promise.resolve(true)) };
    const store = browser(sub);
    store.set(KEY, 'https://push.example/a');
    expect(await disablePush()).toBe(false);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe('https://push.example/a');
  });
});
