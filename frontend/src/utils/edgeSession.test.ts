// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_SIGNED_OUT_KEY,
  EdgeSignedOutError,
  edgeCheckpoint,
  edgeDialGate,
  holdWhileEdgeSignedOut,
  isEdgeSignedOut,
  markEdgeSignedIn,
  markEdgeSignedOut,
} from './edgeSession';

/** What another tab's write looks like here: `storage` fires only in the other tabs. */
function otherTab(newValue: string | null, key: string | null = EDGE_SIGNED_OUT_KEY) {
  if (key && newValue != null) localStorage.setItem(key, newValue);
  else if (key) localStorage.removeItem(key);
  else localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

afterEach(() => {
  markEdgeSignedIn(edgeCheckpoint());
  localStorage.clear();
});

describe('the edge session, shared by every tab', () => {
  it('tells the other tabs when this one finds it expired, and when it is back', () => {
    markEdgeSignedOut();
    expect(isEdgeSignedOut()).toBe(true);
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).not.toBeNull();
    markEdgeSignedIn(edgeCheckpoint());
    expect(isEdgeSignedOut()).toBe(false);
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).toBeNull();
  });

  it("follows another tab's finding and its sign-in", () => {
    otherTab(String(Date.now()));
    expect(isEdgeSignedOut()).toBe(true);
    otherTab(null);
    expect(isEdgeSignedOut()).toBe(false);
  });

  it('reads a cleared storage as signed in, and ignores other keys', () => {
    otherTab(String(Date.now()));
    otherTab('x', 'termag.somethingElse');
    expect(isEdgeSignedOut()).toBe(true);
    otherTab(null, null);
    expect(isEdgeSignedOut()).toBe(false);
  });

  it('keeps a mark made while the request that succeeded was in flight: its 200 predates the expiry', () => {
    const sent = edgeCheckpoint();
    markEdgeSignedOut();
    markEdgeSignedIn(sent);
    expect(isEdgeSignedOut()).toBe(true);
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).not.toBeNull();
    markEdgeSignedIn(edgeCheckpoint());
    expect(isEdgeSignedOut()).toBe(false);
  });

  it("keeps another tab's mark made in flight, before its storage event arrives here", () => {
    const sent = edgeCheckpoint();
    localStorage.setItem(EDGE_SIGNED_OUT_KEY, String(sent.at + 1));
    markEdgeSignedIn(sent);
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).not.toBeNull();
    expect(isEdgeSignedOut()).toBe(true);
  });

  it('does not adopt a mark left from before the page loaded: the navigation got through the edge', async () => {
    localStorage.setItem(EDGE_SIGNED_OUT_KEY, '1');
    vi.resetModules();
    const fresh = await import('./edgeSession');
    expect(fresh.isEdgeSignedOut()).toBe(false);
    // …and the page's user loading clears it for the tabs still waiting.
    fresh.markEdgeSignedIn(fresh.edgeCheckpoint());
    expect(localStorage.getItem(EDGE_SIGNED_OUT_KEY)).toBeNull();
  });
});

describe('holdWhileEdgeSignedOut', () => {
  it('fails a request at once, unsent, while signed out', async () => {
    const adapter = vi.fn(async (config) => ({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config }));
    const api = axios.create({ adapter });
    holdWhileEdgeSignedOut(api);

    otherTab(String(Date.now()));
    await expect(api.get('/termag/api/projects')).rejects.toBeInstanceOf(EdgeSignedOutError);
    expect(adapter).not.toHaveBeenCalled();

    otherTab(null);
    await expect(api.get('/termag/api/projects')).resolves.toMatchObject({ data: 'ok' });
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe('edgeDialGate', () => {
  it('lets a socket dial while signed in', () => {
    const redial = vi.fn();
    expect(edgeDialGate().allows(redial)).toBe(true);
    expect(redial).not.toHaveBeenCalled();
  });

  it('holds the dial while signed out and redials once when a tab signs in', () => {
    const gate = edgeDialGate();
    const redial = vi.fn();
    markEdgeSignedOut();
    expect(gate.allows(redial)).toBe(false);
    // Asked again (a backoff timer, a foreground kick): still one pending redial.
    expect(gate.allows(redial)).toBe(false);
    otherTab(null);
    expect(redial).toHaveBeenCalledTimes(1);
    markEdgeSignedOut();
    markEdgeSignedIn(edgeCheckpoint());
    expect(redial).toHaveBeenCalledTimes(1);
  });

  it("redials after a sign-in when it held on another tab's mark before that tab's storage event came", async () => {
    // The mark is in storage, but this tab has not been told: a thawed tab's timer runs first.
    localStorage.setItem(EDGE_SIGNED_OUT_KEY, String(Date.now()));
    const gate = edgeDialGate();
    const redial = vi.fn();
    expect(gate.allows(redial)).toBe(false);
    await Promise.resolve();
    otherTab(null);
    expect(redial).toHaveBeenCalledTimes(1);
  });

  it('drops the wait on cancel (the owner unmounted)', () => {
    const gate = edgeDialGate();
    const redial = vi.fn();
    markEdgeSignedOut();
    gate.allows(redial);
    gate.cancel();
    markEdgeSignedIn(edgeCheckpoint());
    expect(redial).not.toHaveBeenCalled();
  });
});

// Every termag request path has to go quiet, or the one left over resets the
// login's nonce. A new axios instance or socket that skips the gate fails here.
describe('every termag axios instance and socket honours the signed-out state', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(src);
  const read = (path: string) => readFileSync(path, 'utf8');

  it('axios.create', () => {
    const creators = files.filter(f => read(f).includes('axios.create('));
    expect(creators.length).toBeGreaterThan(0);
    const missing = creators.filter(f => !read(f).includes('holdWhileEdgeSignedOut('));
    expect(missing.map(f => relative(src, f))).toEqual([]);
  });

  it("a fetch that sends termag's cookies (the probe is the one that may, as it finds the expiry)", () => {
    const fetchers = files.filter(f => /fetch\([^)]*\{[^}]*credentials:/s.test(read(f)) && !f.endsWith('ConnectionContext.tsx'));
    expect(fetchers.length).toBeGreaterThan(0);
    const missing = fetchers.filter(f => !read(f).includes('isEdgeSignedOut('));
    expect(missing.map(f => relative(src, f))).toEqual([]);
  });

  it('new WebSocket', () => {
    const owners = files.filter(f => read(f).includes('new WebSocket('));
    expect(owners.length).toBeGreaterThan(0);
    const missing = owners.filter(f => !read(f).includes('edgeDialGate('));
    expect(missing.map(f => relative(src, f))).toEqual([]);
  });
});
