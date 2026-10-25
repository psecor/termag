import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROBE_PATH, isEdgeSignedOut, probeBackend, reauthenticate, retryConnection } from './ConnectionContext';
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

  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
  });

  afterEach(async () => {
    // Leave the module signed in for the next test.
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'basic', status: 200 })));
    await probeBackend();
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
  ])('marks the tab signed out on %s, without reloading or counting contact', async (_name, res) => {
    // A reload here starts the Okta login with nobody at the tab; the ALB's
    // nonce cookie expires in 15 minutes and the later sign-in gets a 401.
    fetchMock(async () => res);
    const before = connectionTracker.snapshot.lastContactAt;
    await expect(probeBackend()).resolves.toBe(false);
    expect(isEdgeSignedOut()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(connectionTracker.snapshot.lastContactAt).toBe(before);
  });

  it('clears the signed-out mark once the edge answers again (signed in from another tab)', async () => {
    fetchMock(async () => ({ type: 'basic', status: 401 }));
    await probeBackend();
    fetchMock(async () => ({ type: 'basic', status: 200 }));
    await expect(probeBackend()).resolves.toBe(true);
    expect(isEdgeSignedOut()).toBe(false);
  });

  it('leaves a healthy response alone', async () => {
    fetchMock(async () => ({ type: 'basic', status: 200 }));
    await expect(probeBackend()).resolves.toBe(true);
    expect(isEdgeSignedOut()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reauthenticate reloads, so the navigation runs the login', () => {
    reauthenticate();
    expect(reload).toHaveBeenCalledTimes(1);
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
