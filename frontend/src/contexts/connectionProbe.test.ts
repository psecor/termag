import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROBE_PATH, probeBackend, retryConnection } from './ConnectionContext';
import { connectionTracker } from '../utils/connectionTracker';

function fetchMock(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('probeBackend', () => {
  beforeEach(() => {
    connectionTracker.reconnectSocket = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    connectionTracker.reconnectSocket = null;
  });

  it('probes a path the OIDC edge can answer, with the session cookie attached', () => {
    // A cookie-less request to a gated path is redirected to the identity
    // provider, which reads as a network failure cross-origin — the probe could
    // never succeed on the hosted deployment. The old target,
    // /termag/public/status, is not a route at all: it falls through to the SPA.
    const spy = fetchMock(async () => ({ ok: true }));
    void probeBackend();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/termag/health');
    expect(PROBE_PATH.startsWith('/termag/')).toBe(true);
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
  });

  it('records a successful probe as HTTP evidence only', async () => {
    fetchMock(async () => ({ ok: true }));
    const before = connectionTracker.snapshot.lastSocketContactAt;
    await expect(probeBackend()).resolves.toBe(true);
    expect(connectionTracker.snapshot.lastContactAt).not.toBeNull();
    expect(connectionTracker.snapshot.lastSocketContactAt).toBe(before);
  });

  it('counts a network-level failure', async () => {
    fetchMock(async () => { throw new TypeError('Failed to fetch'); });
    const before = connectionTracker.snapshot.consecutiveFailures;
    await expect(probeBackend()).resolves.toBe(false);
    expect(connectionTracker.snapshot.consecutiveFailures).toBe(before + 1);
  });
});

describe('probeBackend on an expired edge session', () => {
  let reload: ReturnType<typeof vi.fn>;
  let store: Map<string, string>;

  beforeEach(() => {
    reload = vi.fn();
    store = new Map<string, string>();
    vi.stubGlobal('window', { location: { reload } });
    const storage = (m: Map<string, string>) => ({
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
    });
    // localStorage is shared by every tab; sessionStorage is this tab's own.
    vi.stubGlobal('localStorage', storage(store));
    vi.stubGlobal('sessionStorage', storage(new Map()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not follow the redirect, so the probe never starts its own login', () => {
    // A followed redirect is what set a fresh ALB nonce cookie per probe.
    const spy = fetchMock(async () => ({ type: 'basic', status: 200 }));
    void probeBackend();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });

  it.each([
    ['a redirect to the identity provider', { type: 'opaqueredirect', status: 0 }],
    ['a 401 from the edge', { type: 'basic', status: 401 }],
  ])('reloads the page on %s instead of counting contact', async (_name, res) => {
    fetchMock(async () => res);
    const before = connectionTracker.snapshot.lastContactAt;
    await expect(probeBackend()).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(connectionTracker.snapshot.lastContactAt).toBe(before);
  });

  it('reloads at most once a minute', async () => {
    fetchMock(async () => ({ type: 'opaqueredirect', status: 0 }));
    await probeBackend();
    await probeBackend();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when another tab reloaded within the minute', async () => {
    // Shared storage: a second tab reloading would reset the ALB nonce again.
    store.set('termag:edge-reauth-at', String(Date.now()));
    fetchMock(async () => ({ type: 'opaqueredirect', status: 0 }));
    await expect(probeBackend()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves a healthy response alone', async () => {
    fetchMock(async () => ({ type: 'basic', status: 200 }));
    await expect(probeBackend()).resolves.toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('retryConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    connectionTracker.reconnectSocket = null;
  });

  it('reopens the status socket, not just the HTTP probe', async () => {
    // "Retry now" used to probe only, which never reattached anything; the
    // recovery users saw was the reconnect timer happening to fire.
    const order: string[] = [];
    connectionTracker.reconnectSocket = () => { order.push('reconnect'); };
    fetchMock(async () => { order.push('probe'); return { ok: true }; });
    await retryConnection();
    expect(order).toEqual(['reconnect', 'probe']);
  });
});
