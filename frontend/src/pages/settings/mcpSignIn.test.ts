import { describe, expect, it, vi } from 'vitest';
import { clearPendingSignIn, isLoopbackSignIn, loadPendingSignIn, openSignIn, PENDING_SIGN_IN_TTL_MS, savePendingSignIn } from './mcpSignIn';

const authorize = (redirect: string) =>
  `https://oauth2.example.test/authorize?response_type=code&client_id=c&redirect_uri=${encodeURIComponent(redirect)}&state=s`;
const LOOPBACK = authorize('http://localhost:53682/callback');
const NORMAL = authorize('https://termag.example.test/termag/api/mcp-connectors/oauth/callback');

function fakeWindow(opened: { opener: unknown } | null) {
  return { open: vi.fn(() => opened), location: { assign: vi.fn() } };
}

describe('isLoopbackSignIn', () => {
  it('is true only for an authorize URL whose redirect_uri is the localhost callback', () => {
    expect(isLoopbackSignIn(LOOPBACK)).toBe(true);
    expect(isLoopbackSignIn(NORMAL)).toBe(false);
    expect(isLoopbackSignIn(authorize('http://localhost:53682/other'))).toBe(false);
    expect(isLoopbackSignIn('not a url')).toBe(false);
  });
});

describe('openSignIn', () => {
  it('sends the Settings tab to a normal sign-in, as before', () => {
    const w = fakeWindow(null);
    expect(openSignIn(NORMAL, w)).toBe('navigated');
    expect(w.location.assign).toHaveBeenCalledWith(NORMAL);
    expect(w.open).not.toHaveBeenCalled();
  });

  it('opens a localhost sign-in in a new tab with no opener, and leaves Settings where it is', () => {
    const tab = { opener: 'settings' as unknown };
    const w = fakeWindow(tab);
    expect(openSignIn(LOOPBACK, w)).toBe('opened');
    expect(w.open).toHaveBeenCalledWith(LOOPBACK, '_blank');
    expect(tab.opener).toBeNull();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('says so when the browser blocks the new tab, and still leaves Settings where it is', () => {
    const w = fakeWindow(null);
    expect(openSignIn(LOOPBACK, w)).toBe('blocked');
    expect(w.location.assign).not.toHaveBeenCalled();
  });
});

describe('the pending localhost sign-in kept across a reload', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const P = { connectorId: 'c1', authorizeUrl: 'https://login.example.test/authorize?state=s', blocked: true };

  it('comes back while the sign-in\'s state is good, and not after', () => {
    const store = memory();
    savePendingSignIn(P, store, 1_000);
    expect(loadPendingSignIn(store, 1_000 + PENDING_SIGN_IN_TTL_MS)).toEqual(P);
    expect(loadPendingSignIn(store, 1_001 + PENDING_SIGN_IN_TTL_MS)).toBeNull();
    expect(store.getItem('termag.mcp.pendingSignIn')).toBeNull();
  });

  it('is gone once cleared, and ignores what it did not write', () => {
    const store = memory();
    savePendingSignIn(P, store, 1_000);
    clearPendingSignIn(store);
    expect(loadPendingSignIn(store, 1_000)).toBeNull();
    store.setItem('termag.mcp.pendingSignIn', '{"connectorId":1}');
    expect(loadPendingSignIn(store, 1_000)).toBeNull();
    store.setItem('termag.mcp.pendingSignIn', 'not json');
    expect(loadPendingSignIn(store, 1_000)).toBeNull();
  });
});
