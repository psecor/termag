import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { SESSION_COOKIE, LEGACY_SESSION_COOKIE, sessionCookieOptions, clearLegacySessionCookie } from './sessionCookie';

// Pinning tests for security-review SR2 / R5 (PRD I6): every cookie termag
// sets is `__Host-`, so no other example.com host can toss one at it.

/** A Set-Cookie line, split into its name and lower-cased attributes. */
function parse(line: string): { name: string; value: string; attrs: Map<string, string> } {
  const [pair, ...rest] = line.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf('=');
    attrs.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? '' : a.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/** Expired on arrival: what clearing a cookie looks like. */
function isDeletion(c: ReturnType<typeof parse>): boolean {
  const expires = c.attrs.get('expires');
  return c.attrs.get('max-age') === '0' || (expires !== undefined && Date.parse(expires) <= Date.now());
}

/** The browser's `__Host-` rules: Secure, Path=/, no Domain. */
function expectHostPrefixed(c: ReturnType<typeof parse>): void {
  expect(c.name.startsWith('__Host-')).toBe(true);
  expect(c.attrs.has('secure')).toBe(true);
  expect(c.attrs.get('path')).toBe('/');
  expect(c.attrs.has('domain')).toBe(false);
}

describe('sessionCookieOptions', () => {
  it('names a __Host- cookie in production: Secure, Path=/, no Domain, HttpOnly, Lax', () => {
    const { name, cookie } = sessionCookieOptions(true);
    expect(name).toBe('__Host-termag.sid');
    expect(cookie).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    expect(cookie).not.toHaveProperty('domain');
  });

  it('keeps termag.sid on /termag, not Secure, off production (plain http can hold no __Host- cookie)', () => {
    const { name, cookie } = sessionCookieOptions(false);
    expect(name).toBe('termag.sid');
    expect(cookie).toMatchObject({ path: '/termag', secure: false, httpOnly: true, sameSite: 'lax' });
  });
});

describe('the production session middleware, over https behind the proxy', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/termag', clearLegacySessionCookie);
    app.use('/termag', session({ ...sessionCookieOptions(true), secret: 'test-secret', resave: false, saveUninitialized: false, rolling: true, store: new session.MemoryStore() }));
    app.post('/termag/login', (req, res) => { (req.session as unknown as { who: string }).who = 'pat'; res.status(204).end(); });
    app.get('/termag/me', (req, res) => { res.json({ who: (req.session as unknown as { who?: string }).who ?? null }); });
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  const https = { 'x-forwarded-proto': 'https' };

  async function signIn(): Promise<string> {
    const res = await fetch(`${base}/termag/login`, { method: 'POST', headers: https });
    const [line] = res.headers.getSetCookie();
    return parse(line).value;
  }

  it('every cookie it sets is __Host-, and the only other one it sends is the old one, expired', async () => {
    const res = await fetch(`${base}/termag/login`, { method: 'POST', headers: { ...https, cookie: `${LEGACY_SESSION_COOKIE}=s%3Aold.sig; other=1` } });
    const cookies = res.headers.getSetCookie().map(parse);
    expect(cookies.map(c => c.name).sort()).toEqual([SESSION_COOKIE, LEGACY_SESSION_COOKIE].sort());
    for (const c of cookies) {
      if (isDeletion(c)) continue;
      expectHostPrefixed(c);
      expect(c.attrs.has('httponly')).toBe(true);
      expect(c.attrs.get('samesite')?.toLowerCase()).toBe('lax');
    }
    const legacy = cookies.find(c => c.name === LEGACY_SESSION_COOKIE)!;
    expect(isDeletion(legacy)).toBe(true);
    expect(legacy.attrs.get('path')).toBe('/termag');
  });

  it('renews the cookie on use with the same attributes (rolling)', async () => {
    const sid = await signIn();
    const res = await fetch(`${base}/termag/me`, { headers: { ...https, cookie: `${SESSION_COOKIE}=${sid}` } });
    expect(await res.json()).toEqual({ who: 'pat' });
    const [line] = res.headers.getSetCookie();
    expectHostPrefixed(parse(line));
  });

  it('does not accept the session under its old name: the rename signs everyone out once', async () => {
    const sid = await signIn();
    const res = await fetch(`${base}/termag/me`, { headers: { ...https, cookie: `${LEGACY_SESSION_COOKIE}=${sid}` } });
    expect(await res.json()).toEqual({ who: null });
  });

  it('leaves the request alone when no old cookie comes in', async () => {
    const res = await fetch(`${base}/termag/me`, { headers: { ...https, cookie: 'xtermag.sid=1' } });
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

// A new cookie would come from one of these. Each match must be listed, by
// file and count, with what it does, so adding a cookie anywhere, a file
// already listed included, means reading this test.
const COOKIE_CALL = /\.(?:clear)?cookie\(|['"`]set-cookie['"`]|\bsession\(\s*\{|document\.cookie/gi;
const KNOWN: Record<string, { count: number; why: string }> = {
  'backend/src/auth/sessionCookie.ts': { count: 1, why: 'clears the old termag.sid' },
  'backend/src/index.ts': { count: 1, why: 'the session middleware, from sessionCookieOptions' },
  'backend/src/services/t3RelayHeaders.ts': { count: 1, why: 'drops the box\'s set-cookie' },
  // Preview links: the preview host's own session, on its own
  // registrable domain, is __Host- too (sessionSetCookie, pinned in previewHostRules.test.ts).
  'backend/src/services/previewHost.ts': { count: 1, why: 'the code exchange sets __Host-termag-preview (sessionSetCookie) and, on a browser\'s first session on a link, the __Host-termag-preview-link clear marker (linkMarkerSetCookie, row 2b, SR19)' },
  'backend/src/services/previewHostRules.ts': { count: 2, why: 'the relay rewrites an app\'s set-cookie (no Domain, never __Host-termag-preview)' },
  'backend/src/services/previewHostFixture.ts': { count: 1, why: 'test helper: reads the exchange\'s set-cookie' },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    // fixtures/ is test code run in a child process (tracing's sessionContext), never served.
    if (statSync(path).isDirectory()) return entry === 'node_modules' || entry === 'fixtures' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('every cookie termag sets is __Host-', () => {
  it('the preview host\'s session cookie is __Host- with the same attributes', async () => {
    const { sessionSetCookie, PREVIEW_COOKIE } = await import('../services/previewHostRules');
    expect(PREVIEW_COOKIE.startsWith('__Host-')).toBe(true);
    expect(sessionSetCookie('v', 60)).toMatch(/^__Host-termag-preview=v; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=60$/);
    const { linkMarkerSetCookie, PREVIEW_LINK_MARKER } = await import('../services/previewHostRules');
    expect(PREVIEW_LINK_MARKER.startsWith('__Host-')).toBe(true);
    expect(linkMarkerSetCookie(Buffer.alloc(32, 1), 'my-app', 'l1')).toMatch(/^__Host-termag-preview-link=l1\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  });

  const root = join(__dirname, '../../..');

  it('sets cookies only where this test knows about', () => {
    const hits = Object.fromEntries([join(root, 'backend/src'), join(root, 'frontend/src')]
      .flatMap(sources)
      .map(f => [relative(root, f), readFileSync(f, 'utf8').match(COOKIE_CALL)?.length ?? 0] as const)
      .filter(([, count]) => count > 0));
    expect(hits).toEqual(Object.fromEntries(Object.entries(KNOWN).map(([f, { count }]) => [f, count])));
  });

  it('builds the session cookie from sessionCookieOptions, with no name or cookie of its own', () => {
    const index = readFileSync(join(root, 'backend/src/index.ts'), 'utf8');
    const start = index.indexOf('session({');
    const block = index.slice(start, index.indexOf('\n});', start));
    expect(block).toContain('...sessionCookieOptions(PRODUCTION_COOKIES)');
    expect(block).not.toMatch(/^\s*(name|cookie)\s*:/m);
    expect(index).toMatch(/const PRODUCTION_COOKIES = process\.env\.NODE_ENV === 'production';/);
  });
});
