// The preview host end to end on real sockets (services/previewHost.ts):
// host dispatch, the code exchange, the per-request session check, reverify,
// and termag's own pages. Pins SR3 (the dispatch never calls next(), and a
// preview's /termag/api/* is relayed to the app), SR4 (the pre-auth
// surface, fuzzed), SR10, SR12, SR17 and A2/A3/A4.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import {
  CHECKOUT, cookieFor, DOMAIN, landingCode, openWs, previewFixture, previewHeaders, rawRequest, request, signIn, SITE, type Fixture,
} from './previewHostFixture';
import { codeHash, newSecret, PREVIEW_COOKIE, sessionIdHash } from './previewHostRules';
import { makeClosers, startHttpEcho } from './tunnelTestHarness';
import { linkTokenHash } from './previewLinkRules';

/** Where a clean step's 302 will go: its `next` (signed) or the root; null when the location isn't the clean step. */
const cleanNext = (loc: string | undefined): string | null => {
  const u = new URL(loc ?? '', 'https://x.test');
  return u.pathname === '/__termag/clean' ? (u.searchParams.get('next') ?? '/') : null;
};

const closers = makeClosers();
afterAll(() => closers.closeAll());

async function withApp(over: Parameters<typeof previewFixture>[1] = {}) {
  const f = await previewFixture(closers, over);
  const app = await startHttpEcho(closers);
  f.mem.addLink({ name: 'my-app', port: app.port });
  return { f, app };
}

const echoed = (a: { body: string }) => JSON.parse(a.body) as { method: string; url: string; headers: Record<string, string>; body: string };

describe('host dispatch (SR3)', () => {
  it('never lets a preview-host request reach the route after it, whatever its path, with or without a session', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const paths = ['/', '/termag', '/termag/', '/termag/api/projects', '/termag/api/status', '/termag/auth/login', '/termag/ws/agent', '/termag/health',
      '/termag/internal/github-authz/x', '/public/status', '/__termag', '/__termag/x', '/__termag/auth', '/termag/previews/my-app', '/%2e%2e/termag/api'];
    for (const path of paths) {
      for (const headers of [previewHeaders(), previewHeaders('my-app', { cookie })]) {
        for (const method of ['GET', 'POST', 'OPTIONS']) await request(f.port, path, { method, headers });
      }
    }
    // A host in the preview domain without nginx's marker, a bad name, a mismatched host.
    await request(f.port, '/termag/api/projects', { headers: { host: `my-app--abcdef.${DOMAIN}` } });
    await request(f.port, '/termag/api/projects', { headers: { ...previewHeaders(), 'x-termag-preview-name': 'other' } });
    await request(f.port, '/termag/api/projects', { headers: { ...previewHeaders(), host: 'app.termag.test' } });
    expect(f.sentinel).toEqual({ http: 0, upgrade: 0, paths: [] });
    // The main host still reaches termag.
    expect((await request(f.port, '/termag/api/projects', { headers: { host: 'app.termag.test' } })).status).toBe(299);
    expect(f.sentinel.http).toBe(1);
  });

  it('relays a preview\'s /termag/api/* to the app: it is the app\'s path, never termag\'s', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const a = await request(f.port, '/termag/api/projects?x=1', { headers: previewHeaders('my-app', { cookie }) });
    expect(a.status).toBe(200);
    expect(echoed(a).url).toBe('/termag/api/projects?x=1');
    expect(f.sentinel.http).toBe(0);
  });

  it('answers a preview-domain host nginx did not vouch for with a bare 404', async () => {
    const { f } = await withApp();
    const a = await request(f.port, '/', { headers: { host: `my-app--abcdef.${DOMAIN}` } });
    expect(a.status).toBe(404);
    expect(a.body).toBe('Not Found\n');
  });

  it('takes every preview-host upgrade, never a terminal, status or agent socket', async () => {
    const { f } = await withApp();
    for (const path of ['/termag/ws/terminal?session=x', '/termag/ws/status', '/termag/ws/agent', '/termag/ws/agent-tunnel?id=x', '/termag/api/cli/v1/ws/status']) {
      const raw = await rawRequest(f.port, `GET ${path} HTTP/1.1\r\nHost: my-app--abcdef.${DOMAIN}\r\nX-Termag-Preview-Host: 1\r\nX-Termag-Preview-Name: my-app--abcdef\r\n`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'); // gitleaks:allow (RFC 6455's sample key)
      expect(raw.startsWith('HTTP/1.1 401'), path).toBe(true);
    }
    const raw = await rawRequest(f.port, `GET /termag/ws/status HTTP/1.1\r\nHost: my-app--abcdef.${DOMAIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    expect(raw.startsWith('HTTP/1.1 404')).toBe(true);
    expect(f.sentinel.upgrade).toBe(0);
  });

  it('refuses an absolute-form or * target with 400, before anything else (SR8)', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const h = `Host: my-app--abcdef.${DOMAIN}\r\nX-Termag-Preview-Host: 1\r\nX-Termag-Preview-Name: my-app--abcdef\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`;
    for (const line of ['GET http://169.254.169.254/latest/meta-data/ HTTP/1.1', 'OPTIONS * HTTP/1.1']) {
      const raw = await rawRequest(f.port, `${line}\r\n${h}`);
      expect(raw.startsWith('HTTP/1.1 400'), line).toBe(true);
    }
    expect(app.connections()).toBe(0);
  });
});

describe('the code exchange (SR10, SR12)', () => {
  it('turns a landing code into a __Host- session cookie and a 302 to next, once', async () => {
    const { f } = await withApp();
    const code = await landingCode(f, 'my-app', 'viewer', 'collaborator', { next: '/dashboard?x=1' });
    f.mem.share('proj-1', 'viewer');
    const a = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(a.status).toBe(302);
    // A browser's first session on the link: the clean step first (SR19), then where it was headed.
    expect(cleanNext(a.headers.location)).toBe('/dashboard?x=1');
    expect(a.headers.location).toMatch(/&exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    const set = ([] as string[]).concat(a.headers['set-cookie'] ?? []);
    // The session alone: the clear's marker comes with the clear.
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(new RegExp(`^${PREVIEW_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    const [session] = [...f.mem.sessions.values()];
    expect(session).toMatchObject({ linkId: 'link-my-app', userId: 'viewer', basis: 'collaborator', revokedAt: null });
    expect(session.expiresAt.getTime() - f.now.t).toBe(8 * 3600_000);
    // Used once: the same code again makes no session (its rebound, below, is a ticket back through the landing).
    const again = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(again.status).toBe(302);
    expect(again.headers.location).toMatch(new RegExp(`^${SITE}/previews/my-app/reverify\\?ticket=`));
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(f.mem.sessions.size).toBe(1);
  });

  it('a HEAD of the exchange never uses the code up: the viewer\'s GET still signs in', async () => {
    const { f } = await withApp();
    const code = await landingCode(f, 'my-app', 'owner');
    const head = await request(f.port, `/__termag/auth?code=${code}`, { method: 'HEAD', headers: previewHeaders() });
    expect(head.status).toBe(204);
    expect(head.headers['set-cookie']).toBeUndefined();
    const get = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(get.status).toBe(302);
    expect(([] as string[]).concat(get.headers['set-cookie'] ?? [])[0]).toMatch(/^__Host-termag-preview=/);
  });

  it('sends a missing, expired or malformed code back to the landing page, keeping where it was headed', async () => {
    const { f } = await withApp();
    const code = await landingCode(f, 'my-app', 'owner');
    f.now.t += 61_000;
    for (const q of [`code=${code}`, 'code=nope', '', `code=${newSecret()}&next=%2Fdeep%3Fa%3D1`]) {
      const a = await request(f.port, `/__termag/auth?${q}`, { headers: previewHeaders() });
      expect(a.status, q).toBe(302);
      expect(a.headers.location!.startsWith(`${SITE}/previews/my-app`), q).toBe(true);
    }
    expect((await request(f.port, `/__termag/auth?code=${newSecret()}&next=%2Fdeep%3Fa%3D1`, { headers: previewHeaders() })).headers.location)
      .toBe(`${SITE}/previews/my-app?next=${encodeURIComponent('/deep?a=1')}`);
    expect((await request(f.port, `/__termag/auth?next=${encodeURIComponent('//evil.example')}`, { headers: previewHeaders() })).headers.location).toBe(`${SITE}/previews/my-app`);
    expect(f.mem.sessions.size).toBe(0);
  });

  it('a used code from a browser that already holds the session goes on to next, not round the landing page again (bug cmwe2jg59)', async () => {
    const { f } = await withApp();
    const code = await landingCode(f, 'my-app', 'owner', 'owner', { next: '/deep?a=1' });
    const first = await request(f.port, `/__termag/auth?code=${code}&next=${encodeURIComponent('/deep?a=1')}`, { headers: previewHeaders() });
    expect(first.status).toBe(302);
    const cookie = ([] as string[]).concat(first.headers['set-cookie'] ?? [])[0].split(';')[0];
    // Continue clicked while the app's first answer was still on its way: the same URL again, now with the cookie.
    // Where the code itself was headed, through the clean step (no marker yet), whatever the URL's `next` says:
    // any site can send a browser with a session here (Cursor Security, #1745).
    const again = await request(f.port, `/__termag/auth?code=${code}&next=${encodeURIComponent('/admin/delete')}`, { headers: previewHeaders('my-app', { cookie }) });
    expect(again.status).toBe(302);
    expect(cleanNext(again.headers.location)).toBe('/deep?a=1');
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(f.mem.sessions.size).toBe(1);
    // Its rebound used, or a code nobody minted: the app's root, never the URL's `next`, safe or not.
    for (const c of [code, newSecret()]) {
      const evil = await request(f.port, `/__termag/auth?code=${c}&next=${encodeURIComponent('//evil.example')}`, { headers: previewHeaders('my-app', { cookie }) });
      expect(cleanNext(evil.headers.location)).toBe('/');
    }
    // A session for another link's host, or a forged one, is no session here: back through sign-in.
    f.mem.addLink({ name: 'other-app', port: 1 });
    const other = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders('other-app', { cookie }) });
    expect(other.headers.location).toBe(`${SITE}/previews/other-app`);
    const forged = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders('my-app', { cookie: cookieFor('my-app', newSecret()) }) });
    expect(forged.headers.location).toBe(`${SITE}/previews/my-app`);
  });

  it('never redeems a reverify ticket as a code: the ticket has to go back through the main host', async () => {
    const { f } = await withApp();
    const ticket = newSecret();
    await f.mem.store.createCode({ codeHash: codeHash('ticket', ticket)!, linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, sessionIdHash: 'x', next: '/', expiresAt: new Date(f.now.t + 60_000) });
    const a = await request(f.port, `/__termag/auth?code=${ticket}`, { headers: previewHeaders() });
    expect(a.status).toBe(302);
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(f.mem.codes.size).toBe(1);
  });

  it('refuses a code for another name\'s link, and one whose basis stopped holding in its 60 s', async () => {
    const { f } = await withApp();
    f.mem.addLink({ name: 'other-app', port: 1 });
    const other = await landingCode(f, 'other-app', 'owner');
    const a = await request(f.port, `/__termag/auth?code=${other}`, { headers: previewHeaders() });
    expect(a.status).toBe(404);
    expect(a.headers['content-security-policy']).toContain("default-src 'none'");
    f.mem.share('proj-1', 'viewer');
    const code = await landingCode(f, 'my-app', 'viewer', 'collaborator');
    f.mem.unshare('proj-1', 'viewer');
    expect((await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() })).status).toBe(404);
    // A token code after the token rotated.
    Object.assign(f.mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: 'h'.repeat(64) });
    f.mem.links.get('link-my-app')!.link.linkTokenHash = linkTokenHash('A'.repeat(22));
    const tokenCode = await landingCode(f, 'my-app', 'viewer', 'token', { tokenHash: linkTokenHash('B'.repeat(22)) });
    expect((await request(f.port, `/__termag/auth?code=${tokenCode}`, { headers: previewHeaders() })).status).toBe(404);
    expect(f.mem.sessions.size).toBe(0);
  });

  it('refuses a viewer ALLOWED_USERS no longer has (A2)', async () => {
    const { f } = await withApp();
    f.allowed.delete('owner@example.com');
    const code = await landingCode(f, 'my-app', 'owner');
    expect((await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() })).status).toBe(404);
  });
});

describe('without a session', () => {
  it('a request goes to the landing page with next set to its path; an upgrade gets 401', async () => {
    const { f, app } = await withApp();
    const a = await request(f.port, '/settings?tab=2', { headers: previewHeaders() });
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe(`${SITE}/previews/my-app?next=${encodeURIComponent('/settings?tab=2')}`);
    expect(app.connections()).toBe(0);
  });

  it('never reads an Okta header: a valid-looking one with no cookie is still sent to the landing page (SR17)', async () => {
    const { f, app } = await withApp();
    const jwt = `${Buffer.from('{"alg":"ES256","kid":"k","signer":"arn:aws:elasticloadbalancing:x"}').toString('base64url')}.${Buffer.from('{"email":"owner@example.com","exp":9999999999}').toString('base64url')}.sig`;
    const a = await request(f.port, '/', { headers: previewHeaders('my-app', { 'x-amzn-oidc-data': jwt, 'x-amzn-oidc-identity': 'owner', 'x-amzn-oidc-accesstoken': 'tok' }) });
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe(`${SITE}/previews/my-app`);
    expect(app.connections()).toBe(0);
  });

  it('answers a name with no live link, or with previews off or killed, as a live one: no existence oracle before sign-in (A4)', async () => {
    const { f } = await withApp();
    // Everything but the name in the Location is the same; the landing page, after sign-in, gives the one not-found page.
    const shape = (a: { status: number; headers: Record<string, unknown>; body: string }, name: string) => {
      const { date: _date, location, ...rest } = a.headers;
      return { status: a.status, location: String(location).replace(`/previews/${name}`, '/previews/<name>'), rest, body: a.body };
    };
    const live = shape(await request(f.port, '/x?y=1', { headers: previewHeaders() }), 'my-app');
    expect(live.status).toBe(302);
    expect(shape(await request(f.port, '/x?y=1', { headers: previewHeaders('nope-app') }), 'nope-app')).toEqual(live);
    f.flags.enabled = false;
    expect(shape(await request(f.port, '/x?y=1', { headers: previewHeaders() }), 'my-app')).toEqual(live);
    f.flags.enabled = true;
    f.flags.killSwitch = true;
    expect(shape(await request(f.port, '/x?y=1', { headers: previewHeaders() }), 'my-app')).toEqual(live);
    f.flags.killSwitch = false;
    f.mem.links.get('link-my-app')!.link.endedAt = new Date();
    expect(shape(await request(f.port, '/x?y=1', { headers: previewHeaders() }), 'my-app')).toEqual(live);
  });

  it('is rate-limited per address before any session (SR4)', async () => {
    const { f } = await withApp();
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await request(f.port, '/', { headers: previewHeaders('my-app', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }) })).status);
    expect(statuses.filter(s => s === 302).length).toBe(60);
    expect(statuses.slice(60).every(s => s === 429)).toBe(true);
    // Another address isn't held back.
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' }) })).status).toBe(302);
  });

  it('rate-limits a WebSocket upgrade with no session, cookie or not, per address (SR4, Bugbot)', async () => {
    const { f } = await withApp();
    const ws = (extra: Record<string, string>) => rawRequest(f.port, `GET /__vite_hmr HTTP/1.1\r\nHost: my-app--abcdef.${DOMAIN}\r\nX-Termag-Preview-Host: 1\r\nX-Termag-Preview-Name: my-app--abcdef\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Forwarded-For: 198.51.100.9, 10.0.0.1\r\n${Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`); // gitleaks:allow
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push(Number((await ws(i % 2 ? { Cookie: cookieFor('my-app', newSecret()).replace(/\.[^.]+$/, '.forged') } : {})).slice(9, 12)));
    expect(statuses.filter(s => s === 401).length).toBe(60);
    expect(statuses.slice(60).every(s => s === 429)).toBe(true);
  });

  it('survives a fuzz of the pre-auth surface: no 5xx, no session, nothing reaches the app or termag (SR4)', async () => {
    const { f, app } = await withApp();
    const junk = () => randomBytes(1 + Math.floor(Math.random() * 60)).toString('base64url');
    const paths = ['/__termag/auth?code=', '/__termag/auth?code=%00%ff', '/__termag/auth?code[]=a&code=b', '/__termag/auth?next=%0d%0aSet-Cookie:x', '/__termag/auth/../x', '/__termag/AUTH'];
    for (let i = 0; i < 40; i++) {
      const path = i < paths.length ? paths[i] : (i % 2 ? `/__termag/auth?code=${junk()}&next=/${junk()}` : `/${junk()}`);
      const cookie = i % 3 === 0 ? `${PREVIEW_COOKIE}=${junk()}.${junk()}` : i % 3 === 1 ? cookieFor('my-app', newSecret()) : `${PREVIEW_COOKIE}=`;
      const a = await request(f.port, path, { headers: previewHeaders('my-app', { cookie, 'x-forwarded-for': `192.0.2.${i}, 10.0.0.1` }) });
      expect(a.status, path).toBeLessThan(500);
      expect([302, 404, 400]).toContain(a.status);
      expect(a.headers['set-cookie'], path).toBeUndefined();
    }
    expect(f.mem.sessions.size).toBe(0);
    expect(app.connections()).toBe(0);
    expect(f.sentinel.http).toBe(0);
  });
});

describe('the session check, per request', () => {
  it('relays with a valid session, and caches the check for 30 s', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const resolve = f.mem.store.resolveName;
    let reads = 0;
    f.mem.store.resolveName = async (n) => { reads++; return resolve(n); };
    for (let i = 0; i < 5; i++) expect((await request(f.port, `/r${i}`, { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    expect(reads).toBe(1);
    f.now.t += 31_000;
    await request(f.port, '/again', { headers: previewHeaders('my-app', { cookie }) });
    expect(reads).toBe(2);
  });

  it('a cookie is good for one host only', async () => {
    const { f } = await withApp();
    f.mem.addLink({ name: 'other-app', port: 1 });
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const a = await request(f.port, '/', { headers: previewHeaders('other-app', { cookie }) });
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe(`${SITE}/previews/other-app`);
  });

  it('a removed viewer gets the not-found page at once, and their session is revoked (A3)', async () => {
    const { f } = await withApp();
    f.mem.share('proj-1', 'viewer');
    const { cookie, idHash } = await signIn(f, 'my-app', 'viewer', 'collaborator');
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    f.mem.remove('link-my-app', 'viewer');
    f.host.revoked('link-my-app', []);
    f.now.t += 31_000;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(404);
    expect(f.mem.sessions.get(idHash)!.revokedAt).not.toBeNull();
    // Revoked: from now on it's no session at all, so back through the landing page (which 404s them).
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(302);
  });

  it('revoking in this process takes effect at once, without waiting for the cache', async () => {
    const { f } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    f.mem.sessions.get(idHash)!.revokedAt = new Date(f.now.t);
    f.host.revoked('link-my-app', [idHash]);
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(302);
  });

  it('a viewer who loses termag access is cut off and revoked (A2)', async () => {
    const { f } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    f.allowed.delete('owner@example.com');
    f.now.t += 31_000;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(404);
    expect(f.mem.sessions.get(idHash)!.revokedAt).not.toBeNull();
  });

  it('the kill switch refuses without ending anything, so turning it off restores the session', async () => {
    const { f } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    f.flags.killSwitch = true;
    f.now.t += 31_000;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(404);
    expect(f.mem.sessions.get(idHash)!.revokedAt).toBeNull();
    f.flags.killSwitch = false;
    f.now.t += 31_000;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
  });

  it('a session past 8 h, or past its link, is no session', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.now.t += 8 * 3600_000 + 1;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(302);
  });
});

describe('a reused name starts clean (SR19)', () => {
  const setCookies = (a: { headers: Record<string, unknown> }) => ([] as string[]).concat((a.headers['set-cookie'] as string[] | undefined) ?? []);
  const marker = (a: { headers: Record<string, unknown> }) => setCookies(a).find(c => c.startsWith('__Host-termag-preview-link='))?.split(';')[0];

  it('the exchange sets the session on a response with no Clear-Site-Data; the clean step clears and sets the marker alone', async () => {
    // Chrome holds a redirect with Clear-Site-Data until its clear is done and stores none of its cookies if the
    // navigation is dropped meanwhile (a click on the hand-off page): the session's cookie never waits on it.
    const { f } = await withApp();
    const a = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner', 'owner', { next: '/x' })}`, { headers: previewHeaders() });
    expect(a.status).toBe(302);
    expect(a.headers['clear-site-data']).toBeUndefined();
    expect(setCookies(a)).toHaveLength(1);
    expect(setCookies(a)[0]).toMatch(/^__Host-termag-preview=/);
    expect(cleanNext(a.headers.location)).toBe('/x');
    const session = setCookies(a)[0].split(';')[0];
    // Without the session the exchange just set, nobody is cleared: back through sign-in (Cursor Security, #1745).
    const anon = await request(f.port, a.headers.location!, { headers: previewHeaders() });
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe(`${SITE}/previews/my-app`);
    expect(anon.headers['clear-site-data']).toBeUndefined();
    expect(anon.headers['set-cookie']).toBeUndefined();
    const c = await request(f.port, a.headers.location!, { headers: previewHeaders('my-app', { cookie: session }) });
    expect(c.status).toBe(302);
    expect(c.headers.location).toBe('/x');
    // Storage alone (2026-11-12): a new link's origin has no HTTP cache, and Chrome's cache clear is the slow part.
    expect(c.headers['clear-site-data']).toBe('"storage"');
    expect(c.headers['clear-site-data']).not.toMatch(/cookies|\*/);
    expect(setCookies(c)).toHaveLength(1);
    expect(setCookies(c)[0]).toMatch(/^__Host-termag-preview-link=link-my-app\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
    // Nowhere but the app's own paths, on the link's own host; a HEAD clears nothing.
    expect((await request(f.port, '/__termag/clean?next=%2F%2Fevil.test', { headers: previewHeaders('my-app', { cookie: session }) })).headers.location).toBe('/');
    expect((await request(f.port, '/__termag/clean?next=%2F__termag%2Fclean', { headers: previewHeaders('my-app', { cookie: session }) })).headers.location).toBe('/');
    const bare = await request(f.port, '/__termag/clean', { headers: previewHeaders('my-app', {}, null) });
    expect(bare.headers.location).toBe(`${SITE}/previews/my-app`);
    expect(bare.headers['clear-site-data']).toBeUndefined();
    const head = await request(f.port, '/__termag/clean', { method: 'HEAD', headers: previewHeaders() });
    expect(head.status).toBe(204);
    expect(head.headers['clear-site-data']).toBeUndefined();
    // Anyone can be sent here: a browser already cleared for this link is never cleared again (Devin, #1745).
    const marker = setCookies(c)[0].split(';')[0];
    // Only a `next` termag signed for this link and session, in its minute: anything else is the root, so no other
    // site can send a viewer through this same-origin 302 to a path it chose (Cursor Security, #1745).
    const signed = new URL(a.headers.location!, 'https://x.test');
    const sig = signed.searchParams.get('sig')!;
    const exp = signed.searchParams.get('exp')!;
    for (const forged of [
      '/__termag/clean?next=%2Fadmin%2Fdelete',
      `/__termag/clean?next=%2Fadmin%2Fdelete&exp=${exp}&sig=${sig}`,
      `/__termag/clean?next=%2Fx&exp=${Number(exp) + 1}&sig=${sig}`,
      `/__termag/clean?next=%2Fx&exp=${exp}&sig=${'A'.repeat(43)}`,
    ]) {
      expect((await request(f.port, forged, { headers: previewHeaders('my-app', { cookie: session }) })).headers.location, forged).toBe('/');
    }
    // Another session's signed `next` is no use either, and a minute later neither is this one's.
    const other = setCookies(await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() }))[0].split(';')[0];
    expect((await request(f.port, a.headers.location!, { headers: previewHeaders('my-app', { cookie: other }) })).headers.location).toBe('/');
    f.now.t += 61_000;
    expect((await request(f.port, a.headers.location!, { headers: previewHeaders('my-app', { cookie: session }) })).headers.location).toBe('/');
    const crafted = await request(f.port, '/__termag/clean?next=%2Fy', { headers: previewHeaders('my-app', { cookie: `${session}; ${marker}` }) });
    expect(crafted.status).toBe(302);
    expect(crafted.headers.location).toBe('/');
    expect(crafted.headers['clear-site-data']).toBeUndefined();
    expect(crafted.headers['set-cookie']).toBeUndefined();
  });

  it('decides per browser: the same browser with its marker clears nothing more; another browser of the same viewer clears', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const m = cookie.split('; ')[1];
    expect(m).toMatch(/^__Host-termag-preview-link=/);
    const again = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie: m }) });
    expect(again.headers.location).toBe('/');
    // A code redeemed in some other browser (an old Service Worker's thief, say) never stops this one's clear.
    const elsewhere = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() });
    expect(elsewhere.headers.location).toBe('/__termag/clean');
  });

  it('a marker for another link, a forged one, or another name\'s clears again, and so does a navigation that never got one', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const session = cookie.split('; ')[0];
    for (const m of ['__Host-termag-preview-link=link-old.' + 'A'.repeat(43), '__Host-termag-preview-link=link-my-app.' + 'B'.repeat(43), '__Host-termag-preview-link=link-my-app']) {
      const a = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie: m }) });
      expect(a.headers.location, m).toBe('/__termag/clean');
    }
    // The session without its marker (the clean step's navigation was dropped): no app until the clear.
    const before = app.connections();
    // From another site (or no Sec-Fetch-Site), the clear and then the root, never the path it asked for (Cursor
    // Security). A sibling preview's (same-site) is refused before this, as always (SR13).
    for (const site of ['cross-site', null]) {
      const nav = await request(f.port, '/page?a=1', { headers: previewHeaders('my-app', { cookie: session, 'sec-fetch-mode': 'navigate', ...(site ? { 'sec-fetch-site': site } : {}) }) });
      expect(nav.status, String(site)).toBe(302);
      expect(nav.headers.location, String(site)).toBe('/__termag/clean');
    }
    // The viewer's own address bar or a page of this origin: the clear, then where it asked.
    const nav = await request(f.port, '/page?a=1', { headers: previewHeaders('my-app', { cookie: session, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }) });
    expect(cleanNext(nav.headers.location)).toBe('/page?a=1');
    expect(app.connections()).toBe(before);
    expect((await request(f.port, '/page', { headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'navigate' }) })).status).toBe(200);
    // A new link on the same name: the old marker names the old link, so it clears.
    f.mem.addLink({ name: 'my-app', id: 'link-my-app-2', audienceId: 'aud-my-app-2', port: f.mem.links.get('link-my-app')!.link.port });
    const renewed = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie }) });
    expect(renewed.headers.location).toBe('/__termag/clean');
  });
});

describe('a used code (the hand-off page\'s second navigation)', () => {
  const bounceLines = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.flat().map(String).filter(l => l.includes('handoff_bounce'));

  it('counts a bounce only when the used code comes back without a session the browser kept (pl-bounce, Devin)', async () => {
    const { f } = await withApp();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Opened again in another tab moments later: a code of its own, so no bounce.
      const one = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() });
      const kept = await landingCode(f, 'my-app', 'owner');
      await request(f.port, `/__termag/auth?code=${kept}`, { headers: previewHeaders() });
      // A code again from a browser that kept its session: on to the app, no bounce.
      const session = ([] as string[]).concat(one.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
      expect(bounceLines(log)).toEqual([]);
      await request(f.port, `/__termag/auth?code=${kept}`, { headers: previewHeaders('my-app', { cookie: session }) });
      expect(bounceLines(log)).toEqual([]);
      const code = await landingCode(f, 'my-app', 'owner');
      await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
      // The same code from a browser with no session: the exchange's session never stuck. Ids alone (SR21).
      await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
      // Again, or a stale bookmark, or a code nobody minted: no rebound left, so not a hand-off (Devin, #1745).
      await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
      await request(f.port, `/__termag/auth?code=${newSecret()}`, { headers: previewHeaders() });
      expect(bounceLines(log)).toEqual(['[PREVIEW-LINK] handoff_bounce viewer=owner@example.com link=link-my-app name=my-app box=box-1']);
    } finally { log.mockRestore(); }
  });

  it('a repeat that lands while the first exchange is still checking access already finds its rebound (Devin, #1745)', async () => {
    const { f } = await withApp();
    Object.assign(f.mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: 'h'.repeat(64) });
    const code = await landingCode(f, 'my-app', 'viewer', 'token', { tokenHash: 'h'.repeat(64) });
    // The first exchange stalls after it took the code; the repeat comes in meanwhile.
    const user = f.mem.store.user.bind(f.mem.store);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let stalled = false;
    f.mem.store.user = async (id) => { if (!stalled) { stalled = true; await gate; } return user(id); };
    const first = request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    while (!stalled) await new Promise(r => setTimeout(r, 5));
    const repeat = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    release();
    await first;
    expect(repeat.headers.location).toMatch(new RegExp(`^${SITE}/previews/my-app/reverify\\?ticket=`));
  });

  it('without that session, buys one ticket back through the landing page, in the code\'s minute, never a session', async () => {
    const { f } = await withApp();
    Object.assign(f.mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: 'h'.repeat(64) });
    const code = await landingCode(f, 'my-app', 'viewer', 'token', { tokenHash: 'h'.repeat(64), next: '/x' });
    await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    const tickets = () => [...f.mem.codes.values()].filter(c => c.sessionIdHash === null && c.basis === 'token');
    const again = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(again.status).toBe(302);
    const to = new URL(again.headers.location!);
    expect(`${to.origin}${to.pathname}`).toBe(`${SITE}/previews/my-app/reverify`);
    // The ticket is a fresh secret, never the code or the link's token, and it carries what the code was granted on.
    expect(to.searchParams.get('ticket')).not.toBe(code);
    expect(again.headers.location).not.toContain('h'.repeat(22));
    const t = f.mem.codes.get(codeHash('ticket', to.searchParams.get('ticket')!)!)!;
    expect(t).toMatchObject({ linkId: 'link-my-app', userId: 'viewer', basis: 'token', tokenHash: 'h'.repeat(64), sessionIdHash: null, next: '/x' });
    expect(tickets()).toHaveLength(1);
    expect(f.mem.sessions.size).toBe(1);
    // Once: the third time is a plain bounce.
    const third = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(third.headers.location).toBe(`${SITE}/previews/my-app`);
    // And only in the code's minute.
    const late = await landingCode(f, 'my-app', 'viewer', 'token', { tokenHash: 'h'.repeat(64) });
    await request(f.port, `/__termag/auth?code=${late}`, { headers: previewHeaders() });
    f.now.t += 61_000;
    expect((await request(f.port, `/__termag/auth?code=${late}`, { headers: previewHeaders() })).headers.location).toBe(`${SITE}/previews/my-app`);
  });
});

describe('each link its own origin (SR19, decided 2026-11-06)', () => {
  it('a session never serves the app on the bare name or another link\'s suffix: both go to the landing page', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    const before = app.connections();
    for (const suffix of [null, 'zzzzzz']) {
      const a = await request(f.port, '/x', { headers: previewHeaders('my-app', { cookie }, suffix) });
      expect(a.status, String(suffix)).toBe(302);
      expect(a.headers.location, String(suffix)).toBe(`${SITE}/previews/my-app?next=%2Fx`);
    }
    expect(app.connections()).toBe(before);
    // No socket either.
    await expect(openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: `https://my-app.${DOMAIN}` }, null))).rejects.toThrow();
  });

  it('a new link under the name moves the host: the old suffix stops serving at once', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.mem.addLink({ name: 'my-app', id: 'link-my-app-2', audienceId: 'aud-my-app-2', hostSuffix: 'ghijkl', port: app.port });
    const old = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) });
    expect(old.status).toBe(302);
    expect(old.headers.location).toBe(`${SITE}/previews/my-app`);
  });

  it('a link whose name holds `--` (published before that was refused) still opens on its own host (Devin)', async () => {
    const { f, app } = await withApp();
    f.mem.addLink({ name: 'abc--d', port: app.port });
    const { cookie } = await signIn(f, 'abc--d', 'owner');
    expect(cookie).toMatch(/^__Host-termag-preview=/);
    expect((await request(f.port, '/', { headers: previewHeaders('abc--d', { cookie }) })).status).toBe(200);
  });

  it('a code is redeemed only on its link\'s own host; elsewhere it is not used up', async () => {
    const { f } = await withApp();
    const code = await landingCode(f, 'my-app', 'owner');
    for (const suffix of [null, 'zzzzzz']) {
      const a = await request(f.port, `/__termag/auth?code=${code}&next=%2Fdeep`, { headers: previewHeaders('my-app', {}, suffix) });
      expect(a.status, String(suffix)).toBe(302);
      expect(a.headers.location, String(suffix)).toBe(`${SITE}/previews/my-app?next=%2Fdeep`);
      expect(a.headers['set-cookie'], String(suffix)).toBeUndefined();
    }
    const right = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(right.status).toBe(302);
    expect(String(right.headers['set-cookie'])).toMatch(/^__Host-termag-preview=/);
  });
});

describe('same-site siblings (SR13): only a top-level navigation is served', () => {
  const sibling = { origin: `https://evil.${DOMAIN}`, 'sec-fetch-site': 'same-site' };

  it('refuses a sibling preview\'s fetch, iframe and preflight, whatever the method, before the app sees it', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const cases: Array<[string, string, Record<string, string>]> = [
      ['a fetch', 'GET', { ...sibling, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
      ['a no-cors script load', 'GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }],
      ['an iframe', 'GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
      ['an OPTIONS preflight', 'OPTIONS', { ...sibling, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'access-control-request-method': 'PUT' }],
      ['a HEAD', 'HEAD', { ...sibling, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
      ['a form POST in a frame', 'POST', { ...sibling, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
    ];
    for (const [what, method, headers] of cases) {
      const a = await request(f.port, '/api/secret', { method, headers: previewHeaders('my-app', { cookie, ...headers }) });
      expect(a.status, what).toBe(403);
    }
    expect(app.connections()).toBe(0);
  });

  it('serves a top-level navigation from a sibling: the viewer followed a link', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const a = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }) });
    expect(a.status).toBe(200);
  });

  it('refuses a sibling\'s WebSocket even before its Origin is checked', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const raw = await rawRequest(f.port, `GET /__vite_hmr HTTP/1.1\r\nHost: my-app--abcdef.${DOMAIN}\r\nX-Termag-Preview-Host: 1\r\nX-Termag-Preview-Name: my-app--abcdef\r\nCookie: ${cookie}\r\n`
      + `Origin: https://my-app--abcdef.${DOMAIN}\r\nSec-Fetch-Site: same-site\r\nSec-Fetch-Mode: websocket\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`); // gitleaks:allow (RFC 6455's sample key)
    expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('judges a request without fetch metadata as before: safe methods served, a write only with no Origin or its own', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const h = previewHeaders('my-app', { cookie });
    expect((await request(f.port, '/api/secret', { headers: h })).status).toBe(200);
    expect((await request(f.port, '/api/secret', { method: 'OPTIONS', headers: h })).status).toBe(200);
    expect((await request(f.port, '/api/save', { method: 'POST', headers: h, body: '{}' })).status).toBe(200);
    expect((await request(f.port, '/api/save', { method: 'POST', headers: { ...h, origin: `https://evil.${DOMAIN}` }, body: '{}' })).status).toBe(403);
    // The preview's own pages, same-origin, are served as ever.
    expect((await request(f.port, '/api/secret', { headers: { ...h, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).status).toBe(200);
  });
});

describe('an archived project', () => {
  it('serves none of its links: the not-found page with a session or without, and nothing reaches the app', async () => {
    const { f, app } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    const before = app.connections();
    f.mem.links.get('link-my-app')!.project.archived = true;
    f.now.t += 31_000;
    const withSession = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) });
    expect(withSession.status).toBe(404);
    expect(withSession.body).toContain('This preview isn&#39;t available');
    // Without a session it goes to the landing page like any name (A4), which refuses it after sign-in.
    expect((await request(f.port, '/', { headers: previewHeaders() })).status).toBe(302);
    // A landing code minted just before the archive is refused at the exchange too.
    f.mem.links.get('link-my-app')!.project.archived = false;
    const code = await landingCode(f, 'my-app', 'owner');
    f.mem.links.get('link-my-app')!.project.archived = true;
    const exchanged = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(exchanged.status).toBe(404);
    expect(exchanged.headers['set-cookie']).toBeUndefined();
    expect(app.connections()).toBe(before);
    // Like an ended link it is refused, not revoked here: unarchiving is PR 1's rework to decide.
    expect(f.mem.sessions.get(idHash)!.revokedAt).toBeNull();
  });
});

describe('re-verification (A2, SR18)', () => {
  it('sends a navigation back through the main host once the check is an hour old, with a ticket bound to the session', async () => {
    const { f } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    f.now.t += 3600_000 + 1;
    const nav = previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'navigate' });
    const a = await request(f.port, '/page?q=1', { headers: nav });
    expect(a.status).toBe(302);
    const m = a.headers.location!.match(new RegExp(`^${SITE}/previews/my-app/reverify\\?ticket=([A-Za-z0-9_-]{43})$`));
    expect(m).not.toBeNull();
    const row = f.mem.codes.get(codeHash('ticket', m![1])!);
    expect(row).toMatchObject({ sessionIdHash: idHash, userId: 'owner', basis: 'owner', next: '/page?q=1' });
    // Anything but a navigation is served until two hours.
    expect((await request(f.port, '/api', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    expect((await request(f.port, '/api', { method: 'POST', headers: previewHeaders('my-app', { cookie }), body: 'x' })).status).toBe(200);
  });

  it('a HEAD navigation that is due mints no ticket', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const before = f.mem.codes.size;
    f.now.t += 3600_000 + 1;
    const a = await request(f.port, '/page', { method: 'HEAD', headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'navigate' }) });
    expect(a.status).toBe(204);
    expect(a.headers.location).toBeUndefined();
    expect(f.mem.codes.size).toBe(before);
  });

  it('past two hours, a POST is never re-sent as a GET: it gets the refresh page', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.now.t += 2 * 3600_000 + 1;
    const before = app.connections();
    const a = await request(f.port, '/submit', { method: 'POST', headers: previewHeaders('my-app', { cookie }), body: 'x=1' });
    expect(a.status).toBe(401);
    expect(a.body).toContain('needs refreshing');
    expect(app.connections()).toBe(before);
  });

  it('the exchange of a reverify code moves verifiedAt on and makes no new session', async () => {
    const { f } = await withApp();
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    f.now.t += 3600_000 + 1;
    const code = await landingCode(f, 'my-app', 'owner', 'owner', { sessionIdHash: idHash, next: '/back' });
    const a = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe('/back');
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(f.mem.sessions.size).toBe(1);
    expect(f.mem.sessions.get(idHash)!.verifiedAt.getTime()).toBe(f.now.t);
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'navigate' }) })).status).toBe(200);
  });
});

describe('refusals the relay never sends on', () => {
  it('editor launches, /@fs/ outside the checkout and termag\'s own paths are 403 or 404 pages, never relayed (SR9)', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const h = previewHeaders('my-app', { cookie });
    for (const p of ['/__open-in-editor?file=/home/owner/.aws/credentials', '/__open-stack-frame-in-editor', '/@fs/home/owner/.aws/credentials', `/@fs${CHECKOUT}/../../.ssh/id_ed25519`]) {
      const a = await request(f.port, p, { headers: h });
      expect(a.status, p).toBe(403);
      expect(a.headers['content-security-policy'], p).toContain("default-src 'none'");
    }
    expect((await request(f.port, '/__termag/anything', { headers: h })).status).toBe(404);
    expect(app.connections()).toBe(0);
    expect((await request(f.port, `/@fs${CHECKOUT}/src/main.ts`, { headers: h })).status).toBe(200);
  });

  it('a mutation from another origin is refused; one from the preview\'s own is relayed (I4)', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const post = (extra: Record<string, string>) => request(f.port, '/api/save', { method: 'POST', headers: previewHeaders('my-app', { cookie, ...extra }), body: '{}' });
    expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ origin: `https://my-app--abcdef.${DOMAIN}` })).status).toBe(200);
  });

  it('a parked box gets the asleep page; one not connected, outdated or a draining process gets try-again with Retry-After', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const h = previewHeaders('my-app', { cookie });
    f.box.status = 'stopped';
    const asleep = await request(f.port, '/', { headers: h });
    expect(asleep.status).toBe(503);
    expect(asleep.body).toContain('asleep');
    f.box.status = 'ready';
    f.box.capabilities = [];
    const outdated = await request(f.port, '/', { headers: h });
    expect(outdated.status).toBe(503);
    expect(outdated.headers['retry-after']).toBe('5');
    f.box.capabilities = ['preview-link-v1'];
    f.box.connected = false;
    expect((await request(f.port, '/', { headers: h })).status).toBe(503);
  });

  it('a termag page never carries a script, and can\'t be framed (SR22)', async () => {
    const { f } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.mem.links.get('link-my-app')!.link.endedAt = new Date();
    f.now.t += 31_000;
    const a = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) });
    expect(a.status).toBe(404);
    expect(a.body).not.toMatch(/<script/i);
    expect(a.headers['x-frame-options']).toBe('DENY');
    expect(a.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(a.headers['x-powered-by']).toBeUndefined();
  });

  it('a request body over 100 MB by its length is refused before the app (U1)', async () => {
    const { f, app } = await withApp();
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const raw = await rawRequest(f.port, `POST /upload HTTP/1.1\r\nHost: my-app--abcdef.${DOMAIN}\r\nX-Termag-Preview-Host: 1\r\nX-Termag-Preview-Name: my-app--abcdef\r\nCookie: ${cookie}\r\n`
      + `Content-Length: ${100 * 1024 * 1024 + 1}\r\nConnection: close\r\n\r\n`);
    expect(raw.startsWith('HTTP/1.1 413')).toBe(true);
    expect(app.connections()).toBe(0);
  });
});

describe('a session the cookie names but the store never made', () => {
  it('is no session', async () => {
    const { f } = await withApp();
    const id = newSecret();
    expect(f.mem.sessions.has(sessionIdHash(id))).toBe(false);
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie: cookieFor('my-app', id) }) })).status).toBe(302);
  });
});
