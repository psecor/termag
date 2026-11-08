// The preview host's pure rules
// (Unit): host dispatch, next validation, the request and response header
// rules with every stripped header and cookie, Domain removal and the
// Location rewrite, the cross-origin rule, the path refusals, and the cookie
// HMAC. The security invariants each pins are named.
import { describe, expect, it } from 'vitest';
import {
  classifyHost, codeHash, cookieSecretFrom, cookiesForApp, crossSiteRefusal, framingRefusal, hostName, isNavigation, newSecret,
  PREVIEW_COOKIE, previewRequestHeaders, previewResponseHeaders, reverifyState, rewriteLocation, safeNext, sessionCookieValue, sessionExpiry,
  sameSiteRefusal, sessionSetCookie, setCookieForBrowser, signSessionCookie, targetRefusal, verifySessionCookie, viewerIp,
} from './previewHostRules';

const D = 'previews.test';
const target = { name: 'my-app', domain: D, port: 5173, hostMode: 'localhost' as const, viewerIp: '203.0.113.9' };

describe('classifyHost (SR3)', () => {
  it('is the main host without the marker and outside the preview domain', () => {
    expect(classifyHost({ host: 'app.termag.example' }, D)).toEqual({ kind: 'main' });
    expect(classifyHost({ host: 'app.termag.example' }, null)).toEqual({ kind: 'main' });
  });

  it('refuses a Host in the preview domain that nginx did not vouch for, never treating it as termag', () => {
    expect(classifyHost({ host: `my-app.${D}` }, D)).toEqual({ kind: 'refuse', reason: 'no_marker' });
    expect(classifyHost({ host: `MY-APP.${D.toUpperCase()}:443` }, D)).toEqual({ kind: 'refuse', reason: 'no_marker' });
    expect(classifyHost({ host: D }, D)).toEqual({ kind: 'refuse', reason: 'no_marker' });
  });

  it('serves a preview only for <name>.<domain> exactly, with the name checked again', () => {
    const h = (host: string, name: string) => ({ host, 'x-termag-preview-host': '1', 'x-termag-preview-name': name });
    expect(classifyHost(h(`my-app--abcdef.${D}`, 'my-app--abcdef'), D)).toEqual({ kind: 'preview', name: 'my-app', suffix: 'abcdef' });
    expect(classifyHost(h(`my-app--abcdef.${D}.`, 'my-app--abcdef'), D)).toEqual({ kind: 'preview', name: 'my-app', suffix: 'abcdef' });
    // The bare name is a preview host too, with no suffix: it is sent to the landing page, never served (SR19).
    expect(classifyHost(h(`my-app.${D}`, 'my-app'), D)).toEqual({ kind: 'preview', name: 'my-app', suffix: null });
    expect(classifyHost(h(`my-app--abcdef.${D}`, 'my-app'), D)).toEqual({ kind: 'refuse', reason: 'host_mismatch' });
    // A tail that is no suffix is a bare name, never served; a pre-2026-11-06 name with `--` keeps its own host.
    expect(classifyHost(h(`my-app--abc1ef.${D}`, 'my-app--abc1ef'), D)).toEqual({ kind: 'preview', name: 'my-app--abc1ef', suffix: null });
    expect(classifyHost(h(`abc--d--abcdef.${D}`, 'abc--d--abcdef'), D)).toEqual({ kind: 'preview', name: 'abc--d', suffix: 'abcdef' });
    expect(classifyHost(h(`--abcdef.${D}`, '--abcdef'), D)).toEqual({ kind: 'refuse', reason: 'bad_name' });
    expect(classifyHost(h(`other.${D}`, 'my-app'), D)).toEqual({ kind: 'refuse', reason: 'host_mismatch' });
    expect(classifyHost(h(`a.b.${D}`, 'a.b'), D)).toEqual({ kind: 'refuse', reason: 'bad_name' });
    expect(classifyHost(h(`-x-.${D}`, '-x-'), D)).toEqual({ kind: 'refuse', reason: 'bad_name' });
    expect(classifyHost(h('app.termag.example', 'my-app'), D)).toEqual({ kind: 'refuse', reason: 'host_mismatch' });
  });

  it('a marker with no preview domain configured is still never termag', () => {
    expect(classifyHost({ host: 'app.termag.example', 'x-termag-preview-host': '1' }, null)).toEqual({ kind: 'refuse', reason: 'no_domain' });
  });

  it('reads the Host name without its port or a trailing dot', () => {
    expect(hostName('Foo.Example:8443')).toBe('foo.example');
    expect(hostName('[::1]:80')).toBe('[::1]');
    expect(hostName('x.example.')).toBe('x.example');
  });
});

describe('codes, tickets and the session cookie (SR10, SR12)', () => {
  const secret = Buffer.alloc(32, 7);

  it('hashes a code and a ticket apart, so a ticket is never a code', () => {
    const raw = newSecret();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeHash('code', raw)).not.toBe(codeHash('ticket', raw));
    expect(codeHash('code', 'short')).toBeNull();
    expect(codeHash('code', `${raw}x`)).toBeNull();
  });

  it('signs the cookie for one host: another name, another secret or a changed byte fails', () => {
    const id = newSecret();
    const value = signSessionCookie(secret, 'my-app', id);
    expect(verifySessionCookie(secret, 'my-app', value)).toBe(id);
    expect(verifySessionCookie(secret, 'other-app', value)).toBeNull();
    expect(verifySessionCookie(Buffer.alloc(32, 8), 'my-app', value)).toBeNull();
    expect(verifySessionCookie(secret, 'my-app', `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(verifySessionCookie(secret, 'my-app', `${id}.`)).toBeNull();
    expect(verifySessionCookie(secret, 'my-app', 'garbage')).toBeNull();
  });

  it('sets a __Host- cookie: Path=/, Secure, HttpOnly, Lax, no Domain, until the session ends', () => {
    const line = sessionSetCookie('v', 3600.7);
    expect(line).toBe(`${PREVIEW_COOKIE}=v; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
    expect(line.startsWith('__Host-')).toBe(true);
    expect(line).not.toMatch(/domain=/i);
  });

  it('finds the session cookie among the app\'s', () => {
    expect(sessionCookieValue(`a=1; ${PREVIEW_COOKIE}=abc.def; b=2`)).toBe('abc.def');
    expect(sessionCookieValue('a=1')).toBeNull();
    expect(sessionCookieValue(undefined)).toBeNull();
  });

  it('takes the secret only as 32+ bytes of base64', () => {
    expect(cookieSecretFrom(Buffer.alloc(32, 1).toString('base64'))?.length).toBe(32);
    expect(cookieSecretFrom(Buffer.alloc(16, 1).toString('base64'))).toBeNull();
    expect(cookieSecretFrom('')).toBeNull();
    expect(cookieSecretFrom(undefined)).toBeNull();
  });

  it('caps a session at 8 h and at its link\'s expiry', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    expect(sessionExpiry(now, new Date('2026-11-03T10:00:00Z')).toISOString()).toBe('2026-11-02T18:00:00.000Z');
    expect(sessionExpiry(now, new Date('2026-11-02T11:00:00Z')).toISOString()).toBe('2026-11-02T11:00:00.000Z');
  });

  it('is due for the landing check after an hour, and overdue after two (SR18)', () => {
    const v = new Date('2026-11-02T10:00:00Z');
    expect(reverifyState(v, new Date('2026-11-02T10:59:59Z'))).toBe('fresh');
    expect(reverifyState(v, new Date('2026-11-02T11:00:00Z'))).toBe('due');
    expect(reverifyState(v, new Date('2026-11-02T12:00:00Z'))).toBe('overdue');
  });

  it('redirects only top-level GET and HEAD navigations', () => {
    expect(isNavigation('GET', { 'sec-fetch-mode': 'navigate' })).toBe(true);
    expect(isNavigation('HEAD', { 'sec-fetch-mode': 'navigate' })).toBe(true);
    expect(isNavigation('POST', { 'sec-fetch-mode': 'navigate' })).toBe(false);
    expect(isNavigation('GET', { 'sec-fetch-mode': 'cors' })).toBe(false);
    expect(isNavigation('GET', {})).toBe(false);
  });
});

describe('safeNext (SR16)', () => {
  it('keeps an origin-form path', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/settings?tab=a#x')).toBe('/settings?tab=a#x');
  });

  it.each([
    ['//evil.example/'], ['/\\evil.example'], ['https://evil.example/'], ['evil'], ['/a\nb'], ['/a\u0000'], ['/a\u007f'],
    [`/${'a'.repeat(2048)}`], ['/__termag/auth?code=x'], ['/__TERMAG/x'], [42], [null], [undefined],
  ])('turns %j into /', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });
});

describe('the request target and framing (SR7, SR8)', () => {
  it('refuses absolute-form, authority-form and * targets', () => {
    expect(targetRefusal('/x')).toBeNull();
    expect(targetRefusal('http://169.254.169.254/latest/meta-data/')).toBe('not_origin_form');
    expect(targetRefusal('169.254.169.254:80')).toBe('not_origin_form');
    expect(targetRefusal('*')).toBe('not_origin_form');
    expect(targetRefusal(undefined)).toBe('not_origin_form');
  });

  it('refuses both lengths, and any transfer coding but chunked', () => {
    expect(framingRefusal({ 'content-length': '3' })).toBe(false);
    expect(framingRefusal({ 'transfer-encoding': 'chunked' })).toBe(false);
    expect(framingRefusal({ 'transfer-encoding': 'chunked', 'content-length': '3' })).toBe(true);
    expect(framingRefusal({ 'transfer-encoding': 'gzip, chunked' })).toBe(true);
  });
});

describe('crossSiteRefusal (I4, SR13; from #167)', () => {
  const origin = `https://my-app.${D}`;

  it('lets safe methods through whatever their origin', () => {
    expect(crossSiteRefusal('GET', { 'sec-fetch-site': 'cross-site' }, origin)).toBe(false);
    expect(crossSiteRefusal('OPTIONS', { origin: 'https://evil.example' }, origin)).toBe(false);
  });

  it('takes a mutation only from the preview\'s own origin, or a typed URL', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      expect(crossSiteRefusal(m, { 'sec-fetch-site': 'same-origin' }, origin)).toBe(false);
      expect(crossSiteRefusal(m, { 'sec-fetch-site': 'none' }, origin)).toBe(false);
      expect(crossSiteRefusal(m, { 'sec-fetch-site': 'same-site' }, origin), `${m} from a sibling preview`).toBe(true);
      expect(crossSiteRefusal(m, { 'sec-fetch-site': 'cross-site' }, origin)).toBe(true);
      expect(crossSiteRefusal(m, { 'sec-fetch-site': 'something-new' }, origin), 'an unknown value fails closed').toBe(true);
    }
  });

  it('falls back on Origin without Sec-Fetch-Site: absent or exactly the preview\'s', () => {
    expect(crossSiteRefusal('POST', {}, origin)).toBe(false);
    expect(crossSiteRefusal('POST', { origin }, origin)).toBe(false);
    expect(crossSiteRefusal('POST', { origin: `https://other.${D}` }, origin)).toBe(true);
    expect(crossSiteRefusal('POST', { origin: 'null' }, origin)).toBe(true);
    expect(crossSiteRefusal('POST', { origin: `http://my-app.${D}` }, origin)).toBe(true);
  });
});

describe('previewRequestHeaders (I1, SR8, SR12, SR17)', () => {
  const incoming = {
    host: `my-app.${D}`,
    cookie: `theme=dark; ${PREVIEW_COOKIE}=secret.mac; AWSELBAuthSessionCookie-0=edge; session=app`,
    connection: 'keep-alive, x-hop',
    'x-hop': 'gone',
    'keep-alive': 'timeout=5',
    'proxy-authorization': 'Basic x',
    te: 'trailers',
    expect: '100-continue',
    upgrade: 'h2c',
    'x-amzn-oidc-data': 'jwt', 'x-amzn-oidc-accesstoken': 'tok', 'x-amzn-trace-id': 'Root=1',
    'x-termag-preview-host': '1', 'x-termag-preview-name': 'my-app', 'x-termag-peer-addr': '10.0.0.1',
    'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil', 'x-forwarded-port': '80',
    forwarded: 'for=6.6.6.6', 'x-real-ip': '6.6.6.6',
    authorization: 'Bearer app-own',
    accept: 'text/html',
    origin: `https://my-app.${D}`,
    'sec-websocket-key': 'k', 'sec-websocket-version': '13',
  };

  it('drops every hop-by-hop, edge, termag and forwarding header, and termag\'s and the ALB\'s cookies', () => {
    const out = previewRequestHeaders(incoming, target);
    for (const h of ['connection', 'x-hop', 'keep-alive', 'proxy-authorization', 'te', 'expect', 'upgrade', 'x-amzn-oidc-data', 'x-amzn-oidc-accesstoken',
      'x-amzn-trace-id', 'x-termag-preview-host', 'x-termag-preview-name', 'x-termag-peer-addr', 'x-forwarded-port', 'forwarded', 'x-real-ip']) {
      expect(out[h], h).toBeUndefined();
    }
    expect(out.cookie).toBe('theme=dark; session=app');
    expect(JSON.stringify(out)).not.toContain('secret.mac');
    expect(JSON.stringify(out)).not.toContain('edge');
  });

  it('keeps the app\'s own headers and sets Host and the three forwarding headers itself', () => {
    const out = previewRequestHeaders(incoming, target);
    expect(out).toMatchObject({
      host: 'localhost:5173', 'x-forwarded-host': `my-app.${D}`, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9',
      authorization: 'Bearer app-own', accept: 'text/html', origin: `https://my-app.${D}`,
    });
    expect(previewRequestHeaders(incoming, { ...target, hostMode: 'public' }).host).toBe(`my-app.${D}`);
  });

  it('on a WebSocket, leaves the handshake\'s own headers to the relay\'s client, and still strips the cookie', () => {
    const out = previewRequestHeaders(incoming, target, { websocket: true });
    expect(out['sec-websocket-key']).toBeUndefined();
    expect(out.cookie).toBe('theme=dark; session=app');
  });

  it('never passes the per-browser clear marker either (SR19)', () => {
    expect(cookiesForApp('__Host-termag-preview-link=l.x; a=1')).toBe('a=1');
    expect(setCookieForBrowser('__Host-termag-preview-link=forged; Path=/')).toBeNull();
  });

  it('never passes termag\'s own session cookie, under either name (#1106)', () => {
    expect(cookiesForApp('__Host-termag.sid=s%3Aprod; theme=dark; termag.sid=s%3Adev; TERMAG.SID=x')).toBe('theme=dark');
    expect(previewRequestHeaders({ cookie: '__Host-termag.sid=s%3Aprod; a=1' }, target).cookie).toBe('a=1');
    // A name that only ends in one is the app's.
    expect(cookiesForApp('x__Host-termag.sid=1; my-termag.sid=2')).toBe('x__Host-termag.sid=1; my-termag.sid=2');
  });

  it('drops the Cookie header when nothing of the app\'s is left', () => {
    expect(cookiesForApp(`${PREVIEW_COOKIE}=x`)).toBeNull();
    expect(previewRequestHeaders({ cookie: `${PREVIEW_COOKIE}=x` }, target).cookie).toBeUndefined();
  });

  it('names the viewer by the address the ALB saw, never what the client wrote', () => {
    expect(viewerIp({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }, '127.0.0.1')).toBe('203.0.113.9');
    expect(viewerIp({ 'x-forwarded-for': '10.0.0.7' }, '127.0.0.1')).toBe('10.0.0.7');
    expect(viewerIp({}, '127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('previewResponseHeaders (I5, I7, SR12, SR16)', () => {
  it('removes Domain from every Set-Cookie, and drops one named after termag\'s', () => {
    const out = previewResponseHeaders({
      'set-cookie': [
        'sid=1; Domain=previews.test; Path=/; HttpOnly',
        'theme=dark; domain=.previews.test',
        `${PREVIEW_COOKIE}=forged; Path=/; Secure`,
        `${PREVIEW_COOKIE.toLowerCase()}=forged`,
        'plain=1',
      ],
    }, target);
    expect(out['set-cookie']).toEqual(['sid=1; Path=/; HttpOnly', 'theme=dark', 'plain=1']);
    expect(setCookieForBrowser('a=1;Domain=x;Secure')).toBe('a=1; Secure');
  });

  it('rewrites a Location to the app\'s loopback port onto the preview host, and leaves any other', () => {
    expect(rewriteLocation('http://localhost:5173/login?x=1#h', target)).toBe(`https://my-app.${D}/login?x=1#h`);
    expect(rewriteLocation('http://127.0.0.1:5173/', target)).toBe(`https://my-app.${D}/`);
    expect(rewriteLocation('http://[::1]:5173/a', target)).toBe(`https://my-app.${D}/a`);
    expect(rewriteLocation('http://localhost:3000/a', target)).toBe('http://localhost:3000/a');
    expect(rewriteLocation('https://accounts.example/auth', target)).toBe('https://accounts.example/auth');
    expect(rewriteLocation('/relative', target)).toBe('/relative');
    expect(rewriteLocation('http://localhost:5173/a', { ...target, hostMode: 'public' })).toBe('http://localhost:5173/a');
    expect(previewResponseHeaders({ location: 'http://localhost:5173/next' }, target).location).toBe(`https://my-app.${D}/next`);
  });

  it('strips Clear-Site-Data and hop-by-hop headers, and adds noindex and no-referrer when the app sets none', () => {
    const out = previewResponseHeaders({ 'clear-site-data': '"cookies"', connection: 'close', 'transfer-encoding': 'chunked', 'content-type': 'text/html' }, target);
    expect(out).toEqual({ 'content-type': 'text/html', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
    expect(previewResponseHeaders({ 'referrer-policy': 'origin', 'x-robots-tag': 'all' }, target)).toMatchObject({ 'referrer-policy': 'origin', 'x-robots-tag': 'all' });
  });
});

describe('sameSiteRefusal (SR13)', () => {
  it('refuses same-site unless it is a top-level document navigation', () => {
    expect(sameSiteRefusal({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBe(false);
    expect(sameSiteRefusal({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sameSiteRefusal({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(true);
    expect(sameSiteRefusal({ 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(sameSiteRefusal({ 'sec-fetch-site': 'Same-Site', 'sec-fetch-mode': 'no-cors' })).toBe(true);
  });

  it('leaves same-origin, none, cross-site and no metadata to the other rules', () => {
    for (const site of ['same-origin', 'none', 'cross-site']) expect(sameSiteRefusal({ 'sec-fetch-site': site, 'sec-fetch-mode': 'cors' }), site).toBe(false);
    expect(sameSiteRefusal({})).toBe(false);
  });
});
