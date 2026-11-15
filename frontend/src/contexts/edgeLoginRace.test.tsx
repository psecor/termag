// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider, probeBackend } from './ConnectionContext';
import { connectionTracker } from '../utils/connectionTracker';
import {
  EDGE_SIGNED_OUT_KEY,
  edgeCheckpoint,
  edgeDialGate,
  holdWhileEdgeSignedOut,
  isEdgeSignedOut,
  markEdgeSignedIn,
} from '../utils/edgeSession';

// The 401 loop, as one tab sees it while another signs in.
//
// The ALB once its session has timed out with its cookie still in the browser
// (session_timeout 8 hours, cookie 7 days): every request, a page or a
// background fetch or socket, is redirected to Okta with a fresh
// AWSALBAuthNonce. The browser has one nonce cookie, and a login's callback
// gets a 401 unless the cookie still holds that login's nonce.
const alb = {
  expired: false,
  nonce: 0,
  /** One request through the ALB: a redirect that resets the nonce, or through to termag. */
  pass(): boolean {
    if (!this.expired) return true;
    this.nonce += 1;
    return false;
  },
};

/** A socket through the ALB: a redirected handshake fails, after resetting the nonce. */
class AlbSocket {
  static opened = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  open = false;
  constructor() {
    const through = alb.pass();
    setTimeout(() => {
      if (through) { this.open = true; AlbSocket.opened += 1; this.onopen?.(); }
      else this.onclose?.({ code: 1006 });
    }, 0);
  }
  drop() { this.open = false; this.onclose?.({ code: 1006 }); }
}

/**
 * Tab B's background traffic: the real ConnectionProvider (its probe), an
 * axios instance polling every 5 s as the warp sample does, and a socket owner
 * that redials 1 s after a close, written the way ProjectContext, Terminal and
 * BrowserPane are (edgeSession.test.ts checks that each uses edgeDialGate).
 */
function backgroundTraffic() {
  const api = axios.create({
    adapter: async (config) => {
      if (!alb.pass()) throw new Error('Network Error');
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  holdWhileEdgeSignedOut(api);
  const poll = setInterval(() => { api.get('/termag/api/warp').catch(() => {}); }, 5_000);

  let socket: AlbSocket | null = null;
  let redial: ReturnType<typeof setTimeout> | null = null;
  const edge = edgeDialGate();
  const connect = () => {
    if (redial) { clearTimeout(redial); redial = null; }
    if (!edge.allows(connect)) return;
    const ws = new AlbSocket();
    socket = ws;
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      redial = setTimeout(connect, 1_000);
    };
  };
  connect();
  return {
    socket: () => socket,
    stop: () => { clearInterval(poll); if (redial) clearTimeout(redial); edge.cancel(); },
  };
}

let root: Root;
let container: HTMLDivElement;
let traffic: ReturnType<typeof backgroundTraffic>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  alb.expired = false;
  alb.nonce = 0;
  AlbSocket.opened = 0;
  vi.stubGlobal('fetch', vi.fn(async () => (alb.pass() ? { type: 'basic', status: 200 } : { type: 'opaqueredirect', status: 0 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<ConnectionProvider><div /></ConnectionProvider>); });
  traffic = backgroundTraffic();
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(traffic.socket()?.open).toBe(true);
});

afterEach(() => {
  traffic.stop();
  act(() => root.unmount());
  container.remove();
  markEdgeSignedIn(edgeCheckpoint());
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The session times out: the socket drops and the tab is no longer online, so it probes. */
async function sessionExpires() {
  alb.expired = true;
  await act(async () => {
    for (let i = 0; i < 3; i += 1) connectionTracker.failure();
    traffic.socket()?.drop();
  });
}

/** Another tab writes, or clears, the shared mark; `storage` reaches this one. */
async function otherTabWrites(newValue: string | null) {
  if (newValue != null) localStorage.setItem(EDGE_SIGNED_OUT_KEY, newValue);
  else localStorage.removeItem(EDGE_SIGNED_OUT_KEY);
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: EDGE_SIGNED_OUT_KEY, newValue })); });
}

/** Two minutes at Okta (FastPass, MFA), while this tab is in the background and then looked at. */
async function signingInElsewhere() {
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
}

describe("a tab's background traffic never resets another tab's Okta login", () => {
  it('goes quiet on its own finding, so the login that follows keeps its nonce', async () => {
    await sessionExpires();
    // Its own probe and redials find the redirect: those requests are the last.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(isEdgeSignedOut()).toBe(true);
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).not.toBeNull();

    // Another tab's click starts the login: its navigation's redirect sets the nonce.
    alb.nonce += 1;
    const loginNonce = alb.nonce;
    await signingInElsewhere();
    expect(alb.nonce).toBe(loginNonce);
  });

  it("goes quiet at once on another tab's finding, before it sends anything", async () => {
    await sessionExpires();
    await otherTabWrites(String(Date.now()));
    alb.nonce += 1;
    const loginNonce = alb.nonce;
    await signingInElsewhere();
    expect(alb.nonce).toBe(loginNonce);
    expect(isEdgeSignedOut()).toBe(true);
  });

  it("stays quiet when a probe sent before another tab's finding comes back 200", async () => {
    let answer!: (r: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { answer = r; })));
    const probe = probeBackend();
    await sessionExpires();
    await otherTabWrites(String(Date.now()));
    // The edge let it through before the expiry.
    await act(async () => { answer({ type: 'basic', status: 200 }); await probe; });
    expect(isEdgeSignedOut()).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => (alb.pass() ? { type: 'basic', status: 200 } : { type: 'opaqueredirect', status: 0 })));
    alb.nonce += 1;
    const loginNonce = alb.nonce;
    await signingInElsewhere();
    expect(alb.nonce).toBe(loginNonce);
  });

  it('wakes when that tab signs in: one check, and the socket redials', async () => {
    await sessionExpires();
    await otherTabWrites(String(Date.now()));
    await signingInElsewhere();
    const opened = AlbSocket.opened;

    // The callback kept its nonce: the session is back, and that tab's user
    // loading clears the mark.
    alb.expired = false;
    await otherTabWrites(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(isEdgeSignedOut()).toBe(false);
    expect(traffic.socket()?.open).toBe(true);
    expect(AlbSocket.opened).toBe(opened + 1);
  });
});
