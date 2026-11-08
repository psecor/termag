import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConnectorError } from './mcpConnectors';
import {
  authorizeUrl, callbackIssuerProblem, cimdClientId, clientIsStale, clientMetadataDocument, commitLink, discoverOAuth, exchangeCode, forgetOAuth, freshAccessToken,
  McpNeedsLinkError, OAuthGrantError, pkcePair, preregisteredClients, refreshTokens, registerClient, registeredRow, registrationPath, resourceCovers,
  resourceMetadataFrom, revokeToken, signState, stateNonce, verifyState, wellKnown, type DiscoveredOAuth, type OAuthClient,
  type OAuthLockIo, type OAuthTokens, type StoredOAuth,
} from './mcpOAuth';
import { checkOAuthUrl, type HttpRequest, type HttpResponse, type OAuthHttp } from './mcpOAuthHttp';

const UP = 'https://mcp.example/mcp';
type Route = (req: HttpRequest) => HttpResponse;
const ok = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, text: JSON.stringify(body) });
const status = (code: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({ status: code, headers, text: JSON.stringify(body) });

function fakeHttp(routes: Record<string, Route>) {
  const calls: Array<{ url: string; req: HttpRequest }> = [];
  const http: OAuthHttp = async (url, req = {}) => {
    calls.push({ url, req });
    const r = routes[url];
    return r ? r(req) : status(404);
  };
  return { http, calls };
}

const AS_META = {
  issuer: 'https://auth.example',
  authorization_endpoint: 'https://auth.example/authorize',
  token_endpoint: 'https://auth.example/token',
  registration_endpoint: 'https://auth.example/register',
  revocation_endpoint: 'https://auth.example/revoke',
  code_challenge_methods_supported: ['S256'],
};

function server(over: { prm?: unknown; as?: Record<string, unknown>; probe?: Route } = {}) {
  return fakeHttp({
    [UP]: over.probe ?? (() => status(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"' })),
    'https://mcp.example/.well-known/oauth-protected-resource/mcp': () => ok(over.prm ?? {
      resource: UP, authorization_servers: ['https://auth.example'], scopes_supported: ['read'],
    }),
    'https://auth.example/.well-known/oauth-authorization-server': () => ok({ ...AS_META, ...over.as }),
  });
}

const check = (url: string) => { checkOAuthUrl(url, new Set()); };

const DISCOVERED: DiscoveredOAuth = {
  resource: UP, scopes: ['read'], issuer: 'https://auth.example',
  authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token',
  registrationEndpoint: 'https://auth.example/register', revocationEndpoint: 'https://auth.example/revoke',
  cimdSupported: false, tokenAuthMethods: [], issParameterSupported: false,
};
const CLIENT: OAuthClient = { clientId: 'cid', authMethod: 'none', via: 'dcr', redirectUri: 'https://t.example/termag/api/mcp-connectors/oauth/callback', issuer: 'https://auth.example' };

describe('discovery helpers', () => {
  it('reads resource_metadata quoted or bare', () => {
    expect(resourceMetadataFrom('Bearer realm="x", resource_metadata="https://a/b"')).toBe('https://a/b');
    expect(resourceMetadataFrom('Bearer resource_metadata=https://a/b, error="x"')).toBe('https://a/b');
    expect(resourceMetadataFrom(undefined)).toBeNull();
  });

  it('inserts the well-known segment between host and path, then tries the root', () => {
    expect(wellKnown('https://h.example/v1/mcp/', 'oauth-protected-resource')).toEqual([
      'https://h.example/.well-known/oauth-protected-resource/v1/mcp',
      'https://h.example/.well-known/oauth-protected-resource',
    ]);
    expect(wellKnown('https://h.example', 'x')).toEqual(['https://h.example/.well-known/x']);
  });

  it('accepts a resource that is the upstream or a path prefix of it, same origin only', () => {
    expect(resourceCovers('https://mcp.example/mcp', UP)).toBe(true);
    expect(resourceCovers('https://mcp.example/', UP)).toBe(true);
    expect(resourceCovers('https://mcp.example/m', UP)).toBe(false);
    expect(resourceCovers('https://other.example/mcp', UP)).toBe(false);
    expect(resourceCovers('https://mcp.example/mcp?x=1', UP)).toBe(false);
    expect(resourceCovers('not a url', UP)).toBe(false);
  });
});

describe('discoverOAuth', () => {
  it("follows the 401's resource_metadata pointer and returns the AS endpoints", async () => {
    const { http } = server();
    expect(await discoverOAuth(UP, { http, check })).toEqual(DISCOVERED);
  });

  it('falls back to the well-known path when the server gives no pointer', async () => {
    const { http, calls } = server({ probe: () => status(401) });
    expect((await discoverOAuth(UP, { http, check })).issuer).toBe('https://auth.example');
    expect(calls.map(c => c.url)).toContain('https://mcp.example/.well-known/oauth-protected-resource/mcp');
  });

  it('takes the first authorization server that is usable, and says why the others were not', async () => {
    const { http } = fakeHttp({
      [UP]: () => status(401),
      'https://mcp.example/.well-known/oauth-protected-resource/mcp': () => ok({
        resource: UP, authorization_servers: ['https://a1.example', 'https://a2.example', 'https://a3.example/tenant'],
      }),
      'https://a1.example/.well-known/oauth-authorization-server': () => ok({ ...AS_META, issuer: 'https://a1.example', code_challenge_methods_supported: ['plain'] }),
      'https://a2.example/.well-known/oauth-authorization-server': () => ok({ ...AS_META, issuer: 'https://evil.example' }),
      'https://a3.example/.well-known/openid-configuration/tenant': () => ok({ ...AS_META, issuer: 'https://a3.example/tenant' }),
    });
    expect((await discoverOAuth(UP, { http, check })).issuer).toBe('https://a3.example/tenant');
  });

  it('records whether the server puts iss on its authorization response', async () => {
    const { http } = server({ as: { authorization_response_iss_parameter_supported: true } });
    expect((await discoverOAuth(UP, { http, check })).issParameterSupported).toBe(true);
  });

  it('accepts a server that does not send iss, recording that it does not', async () => {
    const { http } = server();
    expect((await discoverOAuth(UP, { http, check })).issParameterSupported).toBe(false);
  });

  it('refuses an authorization server without PKCE S256', async () => {
    const { http } = server({ as: { code_challenge_methods_supported: undefined } });
    await expect(discoverOAuth(UP, { http, check })).rejects.toThrow(/S256/);
  });

  it('refuses metadata naming a resource that is not the upstream', async () => {
    const { http } = server({ prm: { resource: 'https://other.example/mcp', authorization_servers: ['https://auth.example'] } });
    await expect(discoverOAuth(UP, { http, check })).rejects.toThrow(/not https:\/\/mcp.example\/mcp/);
  });

  it('says so when the server publishes no metadata at all', async () => {
    const { http } = fakeHttp({ [UP]: () => status(200) });
    await expect(discoverOAuth(UP, { http, check })).rejects.toThrow(/no OAuth protected-resource metadata/);
  });

  it('checks every URL a third party names before it is fetched or stored', async () => {
    const { http } = server({ probe: () => status(401, {}, { 'www-authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest"' }) });
    await expect(discoverOAuth(UP, { http, check })).rejects.toThrow(McpConnectorError);

    for (const [field, value] of [
      ['authorization_endpoint', 'https://10.0.0.1/authorize'],
      ['token_endpoint', 'http://auth.example/token'],
      ['registration_endpoint', 'https://auth.example:8443/register'],
      ['revocation_endpoint', 'https://user:pw@auth.example/revoke'],
    ]) {
      const { http: h } = server({ as: { [field]: value } });
      await expect(discoverOAuth(UP, { http: h, check }), field).rejects.toThrow(/no usable authorization server/);
    }
    const { http: h2 } = server({ prm: { resource: UP, authorization_servers: ['https://127.0.0.1'] } });
    await expect(discoverOAuth(UP, { http: h2, check })).rejects.toThrow(/IP address/);
  });
});

describe('callbackIssuerProblem', () => {
  it('rules out a code another authorization server issued, and a missing iss from a server that sends it', () => {
    expect(callbackIssuerProblem(DISCOVERED, 'https://auth.example')).toBeNull();
    expect(callbackIssuerProblem(DISCOVERED, 'https://auth.example/')).toBeNull();
    expect(callbackIssuerProblem(DISCOVERED, undefined)).toBeNull();
    expect(callbackIssuerProblem(DISCOVERED, 'https://other.example')).toMatch(/different authorization server/);
    expect(callbackIssuerProblem(DISCOVERED, ['https://auth.example'])).toMatch(/different authorization server/);
    expect(callbackIssuerProblem({ ...DISCOVERED, issParameterSupported: true }, undefined)).toMatch(/did not say/);
  });
});

describe('client registration', () => {
  it('uses a CIMD only when the server supports it and termag publishes one, else DCR, else refuses', () => {
    expect(registrationPath({ ...DISCOVERED, cimdSupported: true }, 'https://t.example/oauth/client-metadata.json')).toBe('cimd');
    expect(registrationPath({ ...DISCOVERED, cimdSupported: true }, null)).toBe('dcr');
    expect(registrationPath(DISCOVERED, 'https://t.example/oauth/client-metadata.json')).toBe('dcr');
    expect(() => registrationPath({ ...DISCOVERED, registrationEndpoint: null }, null)).toThrow(/neither/);
    expect(() => registrationPath({ ...DISCOVERED, registrationEndpoint: null, cimdSupported: true }, null)).toThrow(/MCP_OAUTH_CIMD/);
  });

  it('publishes a CIMD client id only with MCP_OAUTH_CIMD=on', () => {
    expect(cimdClientId('https://t.example/termag', {})).toBeNull();
    expect(cimdClientId('https://t.example/termag', { MCP_OAUTH_CIMD: 'on' })).toBe('https://t.example/termag/oauth/client-metadata.json');
    expect(cimdClientId(null, { MCP_OAUTH_CIMD: 'on' })).toBeNull();
    const doc = clientMetadataDocument('https://t.example/termag/oauth/client-metadata.json', CLIENT.redirectUri);
    expect(doc).toMatchObject({ client_id: 'https://t.example/termag/oauth/client-metadata.json', redirect_uris: [CLIENT.redirectUri], token_endpoint_auth_method: 'none' });
  });

  it('registers a public client by DCR', async () => {
    const { http, calls } = fakeHttp({ 'https://auth.example/register': () => status(201, { client_id: 'new-id' }) });
    const c = await registerClient(DISCOVERED, { http, cimdClientId: null, redirectUri: CLIENT.redirectUri });
    expect(c).toEqual({ clientId: 'new-id', authMethod: 'none', via: 'dcr', redirectUri: CLIENT.redirectUri, issuer: 'https://auth.example' });
    expect(JSON.parse(calls[0].req.body!)).toMatchObject({ redirect_uris: [CLIENT.redirectUri], token_endpoint_auth_method: 'none', scope: 'read' });
  });

  it('keeps a confidential client the server insists on, and refuses one without its secret', async () => {
    const { http } = fakeHttp({ 'https://auth.example/register': () => ok({ client_id: 'x', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' }) });
    expect(await registerClient(DISCOVERED, { http, cimdClientId: null, redirectUri: 'r' })).toMatchObject({ clientSecret: 's', authMethod: 'client_secret_post' });
    const { http: h2 } = fakeHttp({ 'https://auth.example/register': () => ok({ client_id: 'x', token_endpoint_auth_method: 'client_secret_basic' }) });
    await expect(registerClient(DISCOVERED, { http: h2, cimdClientId: null, redirectUri: 'r' })).rejects.toThrow(/without a client secret/);
  });

  it('makes no request for a CIMD client', async () => {
    const { http, calls } = fakeHttp({});
    const c = await registerClient({ ...DISCOVERED, cimdSupported: true }, { http, cimdClientId: 'https://t.example/m.json', redirectUri: 'r' });
    expect(c).toMatchObject({ clientId: 'https://t.example/m.json', via: 'cimd', authMethod: 'none' });
    expect(calls).toHaveLength(0);
  });
});

describe('authorization request and state', () => {
  it('builds a PKCE S256 pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('sends PKCE, state, resource and scopes on the authorize URL', () => {
    const u = new URL(authorizeUrl(DISCOVERED, CLIENT, { state: 's', challenge: 'c', scopes: ['read'] }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code', client_id: 'cid', redirect_uri: CLIENT.redirectUri, code_challenge: 'c',
      code_challenge_method: 'S256', state: 's', resource: UP, scope: 'read',
    });
  });

  it('asks only for the scopes it is given, not every scope the server advertises, and for none when given none', () => {
    const meta = { ...DISCOVERED, scopes: ['search:read.public', 'channels:history', 'chat:write'] };
    const chosen = new URL(authorizeUrl(meta, CLIENT, { state: 's', challenge: 'c', scopes: ['search:read.public', 'channels:history'] }));
    expect(chosen.searchParams.get('scope')).toBe('search:read.public channels:history');
    expect(new URL(authorizeUrl(meta, CLIENT, { state: 's', challenge: 'c', scopes: [] })).searchParams.has('scope')).toBe(false);
  });

  it('pins the Slack workspace it is given with `team`, and sends none when given none', () => {
    expect(new URL(authorizeUrl(DISCOVERED, CLIENT, { state: 's', challenge: 'c', scopes: [], team: 'T03ABC123' })).searchParams.get('team')).toBe('T03ABC123');
    expect(new URL(authorizeUrl(DISCOVERED, CLIENT, { state: 's', challenge: 'c', scopes: [] })).searchParams.has('team')).toBe(false);
  });

  it('sends no resource for a provider that takes none, and adds its own authorize parameters (Google)', () => {
    const meta = { ...DISCOVERED, sendsResource: false as const, authorizeParams: { access_type: 'offline', prompt: 'consent' } };
    const u = new URL(authorizeUrl(meta, CLIENT, { state: 's', challenge: 'c', scopes: [] }));
    expect(u.searchParams.has('resource')).toBe(false);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
  });

  it('never lets authorize parameters replace the ones the flow sets', () => {
    const meta = { ...DISCOVERED, authorizeParams: { state: 'evil', redirect_uri: 'https://evil.example', code_challenge_method: 'plain' } };
    const u = new URL(authorizeUrl(meta, CLIENT, { state: 's', challenge: 'c', scopes: [] }));
    expect(u.searchParams.get('state')).toBe('s');
    expect(u.searchParams.get('redirect_uri')).toBe(CLIENT.redirectUri);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('binds state to the user and connector, and refuses any tampering', () => {
    const nonce = 'abcdefghijklmnopqrstuvwx';
    const state = signState('secret', nonce, 'u1', 'c1');
    expect(stateNonce(state)).toBe(nonce);
    expect(verifyState('secret', state, 'u1', 'c1')).toBe(true);
    expect(verifyState('secret', state, 'u2', 'c1')).toBe(false);
    expect(verifyState('secret', state, 'u1', 'c2')).toBe(false);
    expect(verifyState('other', state, 'u1', 'c1')).toBe(false);
    expect(verifyState('secret', `${nonce.replace('a', 'b')}${state.slice(nonce.length)}`, 'u1', 'c1')).toBe(false);
    expect(verifyState('secret', `${state.slice(0, -1)}A`, 'u1', 'c1')).toBe(false);
    expect(stateNonce('x.y')).toBeNull();
    expect(stateNonce(undefined)).toBeNull();
  });
});

describe('token endpoint', () => {
  it('exchanges a code with the verifier and resource, and computes the expiry', async () => {
    const { http, calls } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }) });
    expect(await exchangeCode(DISCOVERED, CLIENT, { code: 'code', verifier: 'v' }, http, 1000)).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3600_000 });
    expect(Object.fromEntries(new URLSearchParams(calls[0].req.body))).toEqual({
      grant_type: 'authorization_code', code: 'code', code_verifier: 'v', redirect_uri: CLIENT.redirectUri, resource: UP, client_id: 'cid',
    });
  });

  it('sends no resource on a token request for a provider that takes none', async () => {
    const { http, calls } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'at', token_type: 'Bearer' }) });
    await exchangeCode({ ...DISCOVERED, sendsResource: false }, CLIENT, { code: 'code', verifier: 'v' }, http, 1000);
    expect(new URLSearchParams(calls[0].req.body).has('resource')).toBe(false);
  });

  it('authenticates a confidential client with basic auth and keeps the secret out of the form', async () => {
    const { http, calls } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'at' }) });
    await refreshTokens(DISCOVERED, { ...CLIENT, clientSecret: 's3', authMethod: 'client_secret_basic' }, 'rt', http);
    expect(calls[0].req.headers?.authorization).toBe(`Basic ${Buffer.from('cid:s3').toString('base64')}`);
    expect(calls[0].req.body).not.toContain('s3');
  });

  it('raises OAuthGrantError for invalid_grant and McpConnectorError for anything else', async () => {
    const { http } = fakeHttp({ 'https://auth.example/token': () => status(400, { error: 'invalid_grant' }) });
    await expect(refreshTokens(DISCOVERED, CLIENT, 'rt', http)).rejects.toBeInstanceOf(OAuthGrantError);
    const { http: h2 } = fakeHttp({ 'https://auth.example/token': () => status(500) });
    await expect(refreshTokens(DISCOVERED, CLIENT, 'rt', h2)).rejects.toBeInstanceOf(McpConnectorError);
  });

  it('refuses a non-bearer token, and one that cannot be a header value', async () => {
    const { http } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'at', token_type: 'DPoP' }) });
    await expect(refreshTokens(DISCOVERED, CLIENT, 'rt', http)).rejects.toThrow(/not a bearer/);
    const { http: h2 } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'a\r\nx-evil: 1' }) });
    await expect(refreshTokens(DISCOVERED, CLIENT, 'rt', h2)).rejects.toThrow(/cannot send as a header/);
  });

  it('revokes the refresh token when there is one, and never throws', async () => {
    const { http, calls } = fakeHttp({ 'https://auth.example/revoke': () => ok({}) });
    expect(await revokeToken(DISCOVERED, CLIENT, { accessToken: 'at', refreshToken: 'rt', expiresAt: null }, http)).toBe(true);
    expect(new URLSearchParams(calls[0].req.body).get('token')).toBe('rt');
    const failing: OAuthHttp = async () => { throw new Error('down'); };
    expect(await revokeToken(DISCOVERED, CLIENT, { accessToken: 'at', expiresAt: null }, failing)).toBe(false);
    expect(await revokeToken({ ...DISCOVERED, revocationEndpoint: null }, CLIENT, { accessToken: 'at', expiresAt: null }, failing)).toBe(false);
  });
});

/** An in-memory row and an async mutex standing in for the advisory lock. */
function fakeStore(initial: StoredOAuth | null) {
  let row = initial;
  let chain = Promise.resolve();
  const linkCalls: (string | null)[] = [];
  const io: OAuthLockIo = {
    read: async () => (row ? structuredClone(row) : null),
    write: async v => { row = structuredClone(v); },
    remove: async () => { row = null; },
    linked: async () => { linkCalls.push('linked'); },
    needsLink: async (why: string | null) => { linkCalls.push(why); },
  };
  const store = {
    get row() { return row; },
    linkCalls,
    io,
    read: io.read,
    withLock: <T>(fn: (lockIo: OAuthLockIo) => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn(io));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return store;
}

describe('freshAccessToken', () => {
  const NOW = 1_000_000;
  const expiring: StoredOAuth = { client: CLIENT, tokens: { accessToken: 'old', refreshToken: 'rt1', expiresAt: NOW + 10_000 } };

  it('returns a fresh token without taking the lock', async () => {
    const s = fakeStore({ client: CLIENT, tokens: { accessToken: 'at', expiresAt: NOW + 3600_000 } });
    let refreshed = 0;
    expect(await freshAccessToken({ ...s, refresh: async () => { refreshed++; throw new Error(); }, now: () => NOW })).toBe('at');
    expect(refreshed).toBe(0);
  });

  it('refreshes once for two concurrent checks, and stores the rotated refresh token first', async () => {
    const s = fakeStore(structuredClone(expiring));
    const used: string[] = [];
    const refresh = async (_c: OAuthClient, rt: string) => {
      used.push(rt);
      await new Promise(r => setTimeout(r, 5));
      return { accessToken: 'new', refreshToken: 'rt2', expiresAt: NOW + 3600_000 };
    };
    const [a, b] = await Promise.all([
      freshAccessToken({ ...s, refresh, now: () => NOW }),
      freshAccessToken({ ...s, refresh, now: () => NOW }),
    ]);
    expect([a, b]).toEqual(['new', 'new']);
    expect(used).toEqual(['rt1']);
    expect(s.row?.tokens).toEqual({ accessToken: 'new', refreshToken: 'rt2', expiresAt: NOW + 3600_000 });
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const s = fakeStore(structuredClone(expiring));
    await freshAccessToken({ ...s, refresh: async () => ({ accessToken: 'new', expiresAt: null }), now: () => NOW });
    expect(s.row?.tokens?.refreshToken).toBe('rt1');
  });

  it('drops the tokens, keeps the client and asks for a link on invalid_grant, without retrying', async () => {
    const s = fakeStore(structuredClone(expiring));
    let calls = 0;
    const refresh = async () => { calls++; throw new OAuthGrantError('invalid_grant: reused'); };
    await expect(freshAccessToken({ ...s, refresh, now: () => NOW })).rejects.toBeInstanceOf(McpNeedsLinkError);
    expect(s.row).toEqual({ client: CLIENT });
    expect(s.linkCalls[0]).toMatch(/refused the refresh/);
    await expect(freshAccessToken({ ...s, refresh, now: () => NOW })).rejects.toBeInstanceOf(McpNeedsLinkError);
    expect(calls).toBe(1);
  });

  it('also asks for a link on a transport failure, so a refresh token is never sent twice', async () => {
    const s = fakeStore(structuredClone(expiring));
    await expect(freshAccessToken({ ...s, refresh: async () => { throw new Error('socket hang up'); }, now: () => NOW })).rejects.toThrow(/refresh failed/);
    expect(s.row?.tokens).toBeUndefined();
  });

  it('asks for a link when an expired token has no refresh token', async () => {
    const s = fakeStore({ client: CLIENT, tokens: { accessToken: 'old', expiresAt: NOW } });
    await expect(freshAccessToken({ ...s, refresh: async () => { throw new Error(); }, now: () => NOW })).rejects.toThrow(/no refresh token/);
  });

  it('says not linked when there are no tokens, and marks a connector still shown as linked', async () => {
    const s = fakeStore({ client: CLIENT });
    await expect(freshAccessToken({ ...s, refresh: async () => { throw new Error(); }, now: () => NOW })).rejects.toThrow('not linked');
    expect(s.linkCalls).toEqual([null]);
  });

  it('marks the connector even when the row is gone altogether', async () => {
    const s = fakeStore(null);
    await expect(freshAccessToken({ ...s, refresh: async () => { throw new Error(); }, now: () => NOW })).rejects.toThrow('not linked');
    expect(s.linkCalls).toEqual([null]);
  });
});

describe('unlink against a refresh in flight', () => {
  const NOW = 1_000_000;
  const expiring = (): StoredOAuth => ({ client: CLIENT, tokens: { accessToken: 'old', refreshToken: 'rt1', expiresAt: NOW + 10_000 } });

  it('waits for the refresh, revokes the rotated tokens and leaves no row behind', async () => {
    const s = fakeStore(expiring());
    let finishRefresh!: (t: OAuthTokens) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(r => { refreshStarted = r; });
    const refresh = () => { refreshStarted(); return new Promise<OAuthTokens>(r => { finishRefresh = r; }); };
    const revoked: OAuthTokens[] = [];
    const request = freshAccessToken({ ...s, refresh, now: () => NOW });
    await started;
    const unlink = forgetOAuth({ withLock: s.withLock, revoke: async (_c, t) => { revoked.push(t); } });
    finishRefresh({ accessToken: 'new', refreshToken: 'rt2', expiresAt: NOW + 3600_000 });
    expect(await request).toBe('new');
    await unlink;
    expect(s.row).toBeNull();
    expect(revoked).toEqual([{ accessToken: 'new', refreshToken: 'rt2', expiresAt: NOW + 3600_000 }]);
  });

  it('a refresh queued behind an unlink finds the row gone and writes nothing', async () => {
    const s = fakeStore(expiring());
    let finishRevoke!: () => void;
    const unlink = forgetOAuth({ withLock: s.withLock, revoke: () => new Promise<void>(r => { finishRevoke = r; }) });
    let refreshed = 0;
    const request = freshAccessToken({ ...s, refresh: async () => { refreshed++; return { accessToken: 'new', expiresAt: null }; }, now: () => NOW });
    await new Promise(r => setTimeout(r, 0));
    finishRevoke();
    await unlink;
    await expect(request).rejects.toThrow('not linked');
    expect(refreshed).toBe(0);
    expect(s.row).toBeNull();
    expect(s.linkCalls).toEqual([null]);
  });

  it('a sign-in that finishes after an unlink stores nothing', async () => {
    const s = fakeStore({ client: CLIENT });
    await forgetOAuth({ withLock: s.withLock, revoke: async () => undefined });
    expect(await s.withLock(io => commitLink(io, CLIENT, { accessToken: 'at', expiresAt: null }))).toBe(false);
    expect(s.row).toBeNull();
  });
});

describe('commitLink', () => {
  const TOKENS: OAuthTokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: null };

  it('stores the tokens beside the client they were issued to', async () => {
    const s = fakeStore({ client: CLIENT });
    expect(await commitLink(s.io, CLIENT, TOKENS)).toBe(true);
    expect(s.row).toEqual({ client: CLIENT, tokens: TOKENS });
  });

  it('refuses when the connector was registered again meanwhile', async () => {
    const s = fakeStore({ client: { ...CLIENT, clientId: 'other' } });
    expect(await commitLink(s.io, CLIENT, TOKENS)).toBe(false);
    expect(s.row).toEqual({ client: { ...CLIENT, clientId: 'other' } });
  });
});

describe('registeredRow', () => {
  const TOKENS: OAuthTokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: null };

  it('drops tokens issued to another client', () => {
    expect(registeredRow({ client: CLIENT, tokens: TOKENS }, { ...CLIENT, clientId: 'new' }))
      .toEqual({ row: { client: { ...CLIENT, clientId: 'new' } }, droppedTokens: true });
    expect(registeredRow({ client: CLIENT, tokens: TOKENS }, { ...CLIENT, issuer: 'https://other.example' }).droppedTokens).toBe(true);
  });

  it('keeps tokens when the server hands back the same client for the same issuer', () => {
    const again = { ...CLIENT, redirectUri: 'https://termag.example/new/callback' };
    expect(registeredRow({ client: CLIENT, tokens: TOKENS }, again)).toEqual({ row: { client: again, tokens: TOKENS }, droppedTokens: false });
  });

  it('has nothing to drop on a first registration', () => {
    expect(registeredRow(null, CLIENT)).toEqual({ row: { client: CLIENT }, droppedTokens: false });
  });
});

describe('checkOAuthUrl', () => {
  it('refuses anything but https on a host name at port 443', () => {
    for (const bad of ['http://a.example/x', 'https://u:p@a.example/x', 'https://a.example:8443/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'nope']) {
      expect(() => checkOAuthUrl(bad, new Set()), bad).toThrow(McpConnectorError);
    }
    expect(checkOAuthUrl('https://a.example/x', new Set()).hostname).toBe('a.example');
    expect(checkOAuthUrl('https://localhost:4693/x', new Set(['localhost:4693'])).port).toBe('4693');
  });

  it('refuses IPv6 literals, public ones too: URL.hostname keeps the brackets', () => {
    for (const ip of ['https://[2606:4700:4700::1111]/x', 'https://[2001:db8::1]:443/x', 'https://[::ffff:10.0.0.1]/x', 'https://[::1]/x']) {
      expect(new URL(ip).hostname.startsWith('['), ip).toBe(true);
      expect(() => checkOAuthUrl(ip, new Set()), ip).toThrow(/names an IP address/);
    }
  });
});

describe('pre-registered clients (MCP_OAUTH_CLIENTS)', () => {
  // What https://mcp.slack.com publishes (probed 2026-10-30), scopes cut down.
  const SLACK_UP = 'https://mcp.slack.com/mcp';
  const slack = () => fakeHttp({
    [SLACK_UP]: () => status(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"' }),
    'https://mcp.slack.com/.well-known/oauth-protected-resource': () => ok({
      resource: 'https://mcp.slack.com', authorization_servers: ['https://mcp.slack.com'], scopes_supported: ['search:read.public', 'chat:write'],
    }),
    'https://mcp.slack.com/.well-known/oauth-authorization-server': () => ok({
      issuer: 'https://mcp.slack.com',
      authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
      token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    }),
    'https://slack.com/api/oauth.v2.user.access': () => ok({ ok: true, access_token: 'xoxp-user', token_type: 'user', authed_user: { id: 'U1' }, team: { id: 'T1' } }),
  });
  const SECRET = 'not-a-real-slack-secret-9f3a';
  const ENV = {
    MCP_OAUTH_CLIENTS: JSON.stringify([{ issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com', clientId: '111.222', clientSecretEnv: 'MCP_OAUTH_SLACK_CLIENT_SECRET', tokenTypes: ['user'] }]),
    MCP_OAUTH_SLACK_CLIENT_SECRET: SECRET,
  };
  const useEnv = (env: Record<string, string>) => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function discoverSlack() {
    return discoverOAuth(SLACK_UP, { http: slack().http, check });
  }

  it('reads the secret from the variable the entry names, and skips bad entries naming no value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      ...ENV,
      MCP_OAUTH_CLIENTS: JSON.stringify([
        ...JSON.parse(ENV.MCP_OAUTH_CLIENTS),
        { issuer: 'https://unset.example', resource: 'https://unset.example', clientId: 'x', clientSecretEnv: 'MCP_OAUTH_UNSET_SECRET' },
        { issuer: 'http://plain.example', clientId: 'x', clientSecretEnv: 'MCP_OAUTH_SLACK_CLIENT_SECRET' },
        { issuer: 'https://inline.example', resource: 'https://inline.example', clientId: 'x', clientSecret: SECRET },
        { issuer: 'https://mcp.slack.com', clientId: 'unpinned', clientSecretEnv: 'MCP_OAUTH_SLACK_CLIENT_SECRET' },
      ]),
    };
    expect(preregisteredClients(env)).toEqual([{ issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com', clientId: '111.222', clientSecret: SECRET, tokenTypes: ['user'] }]);
    expect(preregisteredClients({ MCP_OAUTH_CLIENTS: '{not json' })).toEqual([]);
    const pinned = JSON.parse(ENV.MCP_OAUTH_CLIENTS);
    pinned[0].scopes = ['search:read.public', ' channels:history ', 7];
    expect(preregisteredClients({ ...ENV, MCP_OAUTH_CLIENTS: JSON.stringify(pinned) })[0].scopes).toEqual(['search:read.public', 'channels:history']);
    expect(preregisteredClients({})).toEqual([]);
    // A Slack workspace pin is kept; a malformed one is dropped and the entry still used.
    expect(preregisteredClients({ ...ENV, MCP_OAUTH_CLIENTS: JSON.stringify([{ ...pinned[0], team: ' T03ABC123 ' }]) })[0].team).toBe('T03ABC123');
    const badTeam = preregisteredClients({ ...ENV, MCP_OAUTH_CLIENTS: JSON.stringify([{ ...pinned[0], team: 'example-org' }]) });
    expect(badTeam).toHaveLength(1);
    expect(badTeam[0].team).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toMatch(/ignored a team that is not a Slack workspace or org id/);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/MCP_OAUTH_UNSET_SECRET is unset/);
    expect(warn.mock.calls.flat().join('\n')).not.toContain(SECRET);
  });

  it('is chosen over DCR and CIMD when the issuer matches, and only then', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    expect(meta).toMatchObject({ issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com', registrationEndpoint: null, revocationEndpoint: null, tokenAuthMethods: ['client_secret_post'] });
    expect(registrationPath(meta, null)).toBe('preregistered');
    expect(registrationPath({ ...meta, registrationEndpoint: 'https://slack.com/register', cimdSupported: true }, 'https://t.example/m.json')).toBe('preregistered');
    expect(registrationPath(DISCOVERED, null)).toBe('dcr');
    vi.unstubAllEnvs();
    expect(() => registrationPath(meta, null)).toThrow(/no pre-registered client for https:\/\/mcp\.slack\.com \(MCP_OAUTH_CLIENTS\)/);
  });

  it('is not used for another resource that names the same issuer (review: Slack token sent to an attacker upstream)', async () => {
    useEnv(ENV);
    const EVIL = 'https://evil.example/mcp';
    const { http } = fakeHttp({
      [EVIL]: () => status(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://evil.example/.well-known/oauth-protected-resource/mcp"' }),
      'https://evil.example/.well-known/oauth-protected-resource/mcp': () => ok({
        resource: 'https://evil.example', authorization_servers: ['https://mcp.slack.com'], scopes_supported: ['search:read.private', 'im:history'],
      }),
    });
    // Slack's real authorization-server metadata, behind the attacker's resource.
    const meta = await discoverOAuth(EVIL, { http: async (u, r) => (u.startsWith('https://mcp.slack.com') ? slack().http(u, r) : http(u, r)), check });
    expect(meta.issuer).toBe('https://mcp.slack.com');
    expect(() => registrationPath(meta, null)).toThrow(/no pre-registered client/);
    await expect(registerClient(meta, { http, cimdClientId: null, redirectUri: 'r' })).rejects.toThrow(/no pre-registered client/);
  });

  it('never hands a pre-registered client\'s token to an upstream outside its pinned resource', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    expect(client.resource).toBe('https://mcp.slack.com');
    const s = fakeStore({ client, tokens: { accessToken: 'xoxp-user', expiresAt: null } });
    const deps = { read: s.read, withLock: s.withLock, refresh: async () => { throw new Error('no'); }, now: () => 0 };
    expect(await freshAccessToken({ ...deps, upstream: SLACK_UP })).toBe('xoxp-user');
    await expect(freshAccessToken({ ...deps, upstream: 'https://evil.example/mcp' })).rejects.toBeInstanceOf(McpNeedsLinkError);
    // And a token request for metadata naming another resource is refused before anything is sent.
    const { http, calls } = slack();
    await expect(exchangeCode({ ...meta, resource: 'https://evil.example' }, client, { code: 'c', verifier: 'v' }, http)).rejects.toThrow(/no longer has the pre-registered client/);
    expect(calls).toHaveLength(0);
  });

  it('uses the auth method the server advertises, and refuses a server that takes no secret', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const { http, calls } = fakeHttp({});
    const c = await registerClient(meta, { http, cimdClientId: null, redirectUri: CLIENT.redirectUri });
    expect(c).toEqual({ clientId: '111.222', authMethod: 'client_secret_post', via: 'preregistered', redirectUri: CLIENT.redirectUri, issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com' });
    expect(calls).toHaveLength(0);
    expect((await registerClient({ ...meta, tokenAuthMethods: [] }, { http, cimdClientId: null, redirectUri: 'r' })).authMethod).toBe('client_secret_basic');
    expect(() => registrationPath({ ...meta, tokenAuthMethods: ['none', 'private_key_jwt'] }, null)).toThrow(/neither client_secret_basic nor client_secret_post/);
  });

  it('sends the secret to the token endpoint only, and stores, shows and logs it nowhere', async () => {
    useEnv(ENV);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const meta = await discoverSlack();
    const { http, calls } = slack();
    const client = await registerClient(meta, { http, cimdClientId: null, redirectUri: CLIENT.redirectUri });
    const url = authorizeUrl(meta, client, { state: 's', challenge: 'c', scopes: meta.scopes });
    const tokens = await exchangeCode(meta, client, { code: 'code', verifier: 'v' }, http, 1000);

    expect(tokens).toEqual({ accessToken: 'xoxp-user', expiresAt: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/oauth.v2.user.access');
    expect(Object.fromEntries(new URLSearchParams(calls[0].req.body))).toEqual({
      grant_type: 'authorization_code', code: 'code', code_verifier: 'v', redirect_uri: CLIENT.redirectUri,
      resource: 'https://mcp.slack.com', client_id: '111.222', client_secret: SECRET,
    });
    expect(calls[0].req.headers?.authorization).toBeUndefined();
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('resource')).toBe('https://mcp.slack.com');
    expect(u.searchParams.get('client_id')).toBe('111.222');
    for (const shown of [url, JSON.stringify(client), JSON.stringify(meta), JSON.stringify({ client, tokens } satisfies StoredOAuth)]) expect(shown).not.toContain(SECRET);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  });

  it("accepts Slack's \"user\" token type only for a client configured to, and still refuses others", async () => {
    useEnv({ ...ENV, MCP_OAUTH_CLIENTS: JSON.stringify([{ ...JSON.parse(ENV.MCP_OAUTH_CLIENTS)[0], tokenTypes: undefined }]) });
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    await expect(exchangeCode(meta, client, { code: 'c', verifier: 'v' }, slack().http)).rejects.toThrow(/user token, not a bearer token/);
    const { http } = fakeHttp({ 'https://auth.example/token': () => ok({ access_token: 'at', token_type: 'user' }) });
    await expect(exchangeCode(DISCOVERED, CLIENT, { code: 'c', verifier: 'v' }, http)).rejects.toThrow(/not a bearer/);
  });

  it("reads Slack's 200 {ok:false} as a refusal, a bad code as a grant error, without echoing the secret", async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    const answer = (error: string) => fakeHttp({ 'https://slack.com/api/oauth.v2.user.access': () => ok({ ok: false, error }) }).http;
    await expect(exchangeCode(meta, client, { code: 'c', verifier: 'v' }, answer('invalid_code'))).rejects.toBeInstanceOf(OAuthGrantError);
    await expect(refreshTokens(meta, client, 'rt', answer('invalid_refresh_token'))).rejects.toBeInstanceOf(OAuthGrantError);
    const err = await exchangeCode(meta, client, { code: 'c', verifier: 'v' }, answer('bad_client_secret')).catch(e => e as Error);
    expect(err).toBeInstanceOf(McpConnectorError);
    expect(err.message).toBe('the token endpoint refused: bad_client_secret');
  });

  it('keeps a token with no refresh token and no expiry linked, with no refresh and no needs_link', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    const tokens = await exchangeCode(meta, client, { code: 'c', verifier: 'v' }, slack().http);
    const s = fakeStore({ client, tokens });
    let refreshed = 0;
    const deps = { read: s.read, withLock: s.withLock, upstream: SLACK_UP, refresh: async () => { refreshed++; return tokens; }, now: () => Date.now() + 365 * 86_400_000 };
    expect(await freshAccessToken(deps)).toBe('xoxp-user');
    expect(await freshAccessToken(deps)).toBe('xoxp-user');
    expect(refreshed).toBe(0);
    expect(s.linkCalls).toEqual([]);
    expect(s.row).toEqual({ client, tokens });
  });

  it('unlinks by deleting the row when the server advertises no revocation endpoint', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    const { http, calls } = fakeHttp({});
    const s = fakeStore({ client, tokens: { accessToken: 'xoxp-user', expiresAt: null } });
    await forgetOAuth({ withLock: s.withLock, revoke: (c, t) => revokeToken(meta, c, t, http) });
    expect(calls).toHaveLength(0);
    expect(s.row).toBeNull();
  });

  it('refuses token requests once the client is gone from the config, and unlink still works', async () => {
    useEnv(ENV);
    const meta = await discoverSlack();
    const client = await registerClient(meta, { http: fakeHttp({}).http, cimdClientId: null, redirectUri: 'r' });
    vi.unstubAllEnvs();
    const { http, calls } = slack();
    await expect(refreshTokens(meta, client, 'rt', http)).rejects.toThrow(/no longer has the pre-registered client/);
    expect(await revokeToken({ ...meta, revocationEndpoint: 'https://slack.com/revoke' }, client, { accessToken: 'a', expiresAt: null }, http)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('registers again when a pre-registered client is added, changed or removed', () => {
    const pre = { issuer: 'https://auth.example', resource: UP, clientId: 'pre-id', clientSecret: SECRET, tokenTypes: [] };
    const preClient: OAuthClient = { ...CLIENT, clientId: 'pre-id', authMethod: 'client_secret_post', via: 'preregistered', resource: UP };
    const opts = { redirectUri: CLIENT.redirectUri, cimdClientId: null };
    expect(clientIsStale(undefined, DISCOVERED, { ...opts, preregistered: null })).toBe(true);
    expect(clientIsStale(CLIENT, DISCOVERED, { ...opts, preregistered: null })).toBe(false);
    expect(clientIsStale(CLIENT, DISCOVERED, { ...opts, preregistered: pre })).toBe(true);
    expect(clientIsStale(preClient, DISCOVERED, { ...opts, preregistered: pre })).toBe(false);
    expect(clientIsStale(preClient, DISCOVERED, { ...opts, preregistered: { ...pre, clientId: 'other' } })).toBe(true);
    expect(clientIsStale(preClient, DISCOVERED, { ...opts, preregistered: null })).toBe(true);
    expect(clientIsStale(preClient, DISCOVERED, { ...opts, preregistered: { ...pre, resource: 'https://mcp.example/other' } })).toBe(true);
    expect(clientIsStale(preClient, DISCOVERED, { ...opts, redirectUri: 'https://elsewhere', preregistered: pre })).toBe(true);
    expect(clientIsStale({ ...CLIENT, via: 'cimd' }, DISCOVERED, { ...opts, preregistered: null })).toBe(true);
  });
});
