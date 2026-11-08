// The preview host end to end on real sockets (services/previewHost.ts):
// host dispatch, the code exchange, the per-request session check, reverify,
// and termag's own pages. Pins SR3 (the dispatch never calls next(), and a
// preview's /termag/api/* is relayed to the app), SR4 (the pre-auth
// surface, fuzzed), SR10, SR12, SR17 and A2/A3/A4.
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import {
  CHECKOUT, cookieFor, DOMAIN, landingCode, openWs, previewFixture, previewHeaders, rawRequest, request, signIn, SITE, type Fixture,
} from './previewHostFixture';
import { codeHash, newSecret, PREVIEW_COOKIE, sessionIdHash } from './previewHostRules';
import { makeClosers, startHttpEcho } from './tunnelTestHarness';
import { linkTokenHash } from './previewLinkRules';

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
    expect(a.headers.location).toBe('/dashboard?x=1');
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    const set = ([] as string[]).concat(a.headers['set-cookie'] ?? []);
    // The session, and on a browser's first session on the link its clear marker (SR19).
    expect(set).toHaveLength(2);
    expect(set[1]).toMatch(/^__Host-termag-preview-link=/);
    expect(set[0]).toMatch(new RegExp(`^${PREVIEW_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    const [session] = [...f.mem.sessions.values()];
    expect(session).toMatchObject({ linkId: 'link-my-app', userId: 'viewer', basis: 'collaborator', revokedAt: null });
    expect(session.expiresAt.getTime() - f.now.t).toBe(8 * 3600_000);
    // Used once: the same code again goes back through sign-in.
    const again = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders() });
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe(`${SITE}/previews/my-app`);
    expect(again.headers['set-cookie']).toBeUndefined();
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
    f.mem.links.get('link-my-app')!.link.audience = 'link';
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

  it('a browser\'s first session on a link clears the origin and sets an HttpOnly marker, never clearing cookies', async () => {
    const { f } = await withApp();
    const a = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() });
    expect(a.status).toBe(302);
    expect(a.headers['clear-site-data']).toBe('"storage", "cache"');
    expect(a.headers['clear-site-data']).not.toMatch(/cookies|\*/);
    expect(setCookies(a)[0]).toMatch(/^__Host-termag-preview=/);
    expect(setCookies(a)[1]).toMatch(/^__Host-termag-preview-link=link-my-app\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
  });

  it('decides per browser: the same browser with its marker clears nothing more; another browser of the same viewer clears', async () => {
    const { f } = await withApp();
    const first = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() });
    const m = marker(first)!;
    const again = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie: m }) });
    expect(again.headers['clear-site-data']).toBeUndefined();
    expect(marker(again)).toBeUndefined();
    // A code redeemed in some other browser (an old Service Worker's thief, say) never stops this one's clear.
    const elsewhere = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() });
    expect(elsewhere.headers['clear-site-data']).toBe('"storage", "cache"');
  });

  it('a marker for another link, a forged one, or another name\'s clears again; a reverify never does', async () => {
    const { f } = await withApp();
    const { idHash } = await signIn(f, 'my-app', 'owner');
    for (const cookie of ['__Host-termag-preview-link=link-old.' + 'A'.repeat(43), '__Host-termag-preview-link=link-my-app.' + 'B'.repeat(43), '__Host-termag-preview-link=link-my-app']) {
      const a = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie }) });
      expect(a.headers['clear-site-data'], cookie).toBe('"storage", "cache"');
    }
    const re = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner', 'owner', { sessionIdHash: idHash })}`, { headers: previewHeaders() });
    expect(re.status).toBe(302);
    expect(re.headers['clear-site-data']).toBeUndefined();
    // A new link on the same name: the old marker names the old link, so it clears.
    const old = marker(await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders() }))!;
    f.mem.addLink({ name: 'my-app', id: 'link-my-app-2', audienceId: 'aud-my-app-2', port: f.mem.links.get('link-my-app')!.link.port });
    const renewed = await request(f.port, `/__termag/auth?code=${await landingCode(f, 'my-app', 'owner')}`, { headers: previewHeaders('my-app', { cookie: old }) });
    expect(renewed.headers['clear-site-data']).toBe('"storage", "cache"');
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
