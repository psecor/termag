import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createHash } from 'node:crypto';

// Linking an OAuth connector by pasting the localhost address the server sent
// the browser to. Only for
// servers on the user's mcp-oauth-loopback-servers list; the pasted query
// goes through the same callback as a normal sign-in. Connectors are an
// in-memory array, as in mcpConnectors.test.ts.

const LOOPBACK = 'http://localhost:53682/callback';
const UPSTREAM = 'https://mcp.example.test:18444/mcp';
const META = {
  resource: UPSTREAM, scopes: [], issuer: 'https://auth.example.test',
  authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
  registrationEndpoint: 'https://auth.example.test/register', revocationEndpoint: null, cimdSupported: true, tokenAuthMethods: [],
};
type Row = { id: string; userId: string; name: string; upstream: string; authType: string; oauthMetadata: unknown; linkStatus: string; linkError: null; createdAt: Date; updatedAt: Date };
let rows: Row[] = [];
// What mcp-oauth-loopback-servers serves the user; null is its fallback.
let loopbackFlag: unknown = null;
const STATE_NONCE = 'n'.repeat(32);
let stateRow: { userId: string; connectorId: string; codeVerifier: string; returnTo?: 'welcome' | null } | null = null;
type Client = { clientId: string; authMethod: string; via: string; redirectUri: string; issuer: string };
let stored: { client: Client; tokens?: unknown } | null = null;
const linkWrites: Array<string | null> = [];

vi.mock('../db', () => ({
  prisma: { user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@example.test`, unixUsername: 'pat' }) } },
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'], unixUsername: 'pat' };
    next();
  },
}));

vi.mock('../services/credentialStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/credentialStore')>()),
  getCredentialStoreConfig: () => ({ kmsKeyId: 'k' }),
}));
vi.mock('../services/credentialDelivery', () => ({ deliverToUserBoxes: async () => {} }));
// oauth/start pre-flights the authorize URL (services/mcpOAuthRedirectHelp.ts): the server goes on to its login page.
vi.mock('../services/mcpOAuthHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuthHttp')>()),
  safeOAuthHttp: () => async () => ({ status: 302, headers: { location: '/login' }, text: '' }),
}));

const flagReads: string[] = [];
vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  jsonVariation: async (key: string, _user: unknown, fallback: unknown) => {
    flagReads.push(key);
    return key === 'mcp-oauth-loopback-servers' ? loopbackFlag : fallback;
  },
}));

const consumeOAuthState = vi.fn(async (nonce: string) => {
  const r = nonce === STATE_NONCE ? stateRow : null;
  stateRow = null;
  return r;
});
const createOAuthState = vi.fn(async () => {});
vi.mock('../services/mcpConnectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpConnectorStore')>()),
  findConnector: async (id: string) => rows.find(r => r.id === id) ?? null,
  listConnectors: async (userId: string) => rows.filter(r => r.userId === userId),
  consumeOAuthState,
  createOAuthState,
  readOAuth: async () => stored,
  withOAuthLock: async (_u: string, _c: string, fn: (io: typeof lockIo) => Promise<unknown>) => fn(lockIo),
}));

const exchangeCode = vi.fn(async () => ({ accessToken: 'at', expiresAt: null }));
const registerClient = vi.fn(async (_d: unknown, opts: { redirectUri: string }) => ({
  clientId: 'cid', authMethod: 'none', via: 'dcr', redirectUri: opts.redirectUri, issuer: META.issuer,
}));
vi.mock('../services/mcpOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuth')>()),
  exchangeCode,
  registerClient,
}));

const lockIo = {
  read: async () => stored,
  write: async (v: typeof stored) => { stored = v; },
  remove: async () => { stored = null; },
  linked: async () => { linkWrites.push('linked'); },
  needsLink: async (reason: string | null) => { linkWrites.push(reason); },
};

const { mcpConnectorsRouter } = await import('./mcpConnectors');
const { signState } = await import('../services/mcpOAuth');
const secret = () => process.env.SESSION_SECRET ?? 'dev-secret';

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.MCP_UPSTREAM_TEST_ALLOW = 'mcp.example.test:18444';
  // On, so the test shows the paste flow registers by DCR even where CIMD would be used.
  process.env.MCP_OAUTH_CIMD = 'on';
  const app = express();
  app.use(express.json());
  app.use('/api/mcp-connectors', mcpConnectorsRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp-connectors`;
});

afterAll(async () => {
  delete process.env.MCP_UPSTREAM_TEST_ALLOW;
  delete process.env.MCP_OAUTH_CIMD;
  delete process.env.FRONTEND_URL;
  await new Promise(resolve => server.close(resolve));
});

const loopbackClient = (): Client => ({ clientId: 'cid', authMethod: 'none', via: 'dcr', redirectUri: LOOPBACK, issuer: META.issuer });

beforeEach(() => {
  rows = [
    { id: 'c1', userId: 'u1', name: 'newrelic', upstream: UPSTREAM, authType: 'oauth', oauthMetadata: META, linkStatus: 'needs_link', linkError: null, createdAt: new Date(), updatedAt: new Date() },
    { id: 'c2', userId: 'u1', name: 'other', upstream: 'https://mcp.example.test:18444/other', authType: 'oauth', oauthMetadata: META, linkStatus: 'needs_link', linkError: null, createdAt: new Date(), updatedAt: new Date() },
  ];
  loopbackFlag = [`${UPSTREAM}/`];
  stateRow = { userId: 'u1', connectorId: 'c1', codeVerifier: 'verifier' };
  stored = { client: loopbackClient() };
  linkWrites.length = 0;
  flagReads.length = 0;
  process.env.FRONTEND_URL = 'https://termag.example.test';
  vi.clearAllMocks();
});

const state = (userId = 'u1', connectorId = 'c1') => signState(secret(), STATE_NONCE, userId, connectorId);
const pastedUrl = (q: Record<string, string>) => `${LOOPBACK}?${new URLSearchParams(q)}`;

/** Posts the paste form as the browser does, and answers where it is sent next. */
async function pasteTo(url: string, form: Record<string, string> = {}, connectorId = 'c1', user = 'u1') {
  const res = await fetch(`${base}/${connectorId}/oauth/paste`, {
    method: 'POST',
    headers: { 'x-test-user': user, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url, ...form }).toString(),
    redirect: 'manual',
  });
  expect(res.status).toBe(303);
  return new URL(res.headers.get('location')!, 'http://x');
}
async function paste(url: string, connectorId = 'c1', user = 'u1') {
  return (await pasteTo(url, {}, connectorId, user)).searchParams;
}

async function start(connectorId = 'c1') {
  const res = await fetch(`${base}/${connectorId}/oauth/start`, { method: 'POST', headers: { 'x-test-user': 'u1' } });
  return new URL((await res.json()).authorizeUrl as string);
}

describe('starting a link', () => {
  it('sends a listed server to the localhost redirect, registered by DCR (not CIMD) for that redirect', async () => {
    stored = null;
    const url = await start();
    expect(url.searchParams.get('redirect_uri')).toBe(LOOPBACK);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(registerClient).toHaveBeenCalledWith(META, expect.objectContaining({ redirectUri: LOOPBACK, cimdClientId: null, preregistered: null }));
    expect(flagReads).toContain('mcp-oauth-loopback-servers');
  });

  it('leaves a server off the list exactly as before: termag\'s own callback', async () => {
    loopbackFlag = ['https://mcp.example.test:18444/other'];
    stored = null;
    const url = await start();
    expect(url.searchParams.get('redirect_uri')).toBe('https://termag.example.test/api/mcp-connectors/oauth/callback');
    expect(registerClient).toHaveBeenCalledWith(META, expect.objectContaining({ redirectUri: 'https://termag.example.test/api/mcp-connectors/oauth/callback' }));
  });

  it('registers again when a server comes off the list, so its next link uses termag\'s callback', async () => {
    loopbackFlag = null;
    const url = await start();
    expect(registerClient).toHaveBeenCalledTimes(1);
    expect(url.searchParams.get('redirect_uri')).toBe('https://termag.example.test/api/mcp-connectors/oauth/callback');
  });

  it('marks a listed connector pasteLink in the Settings list, and only that one', async () => {
    const res = await fetch(base, { headers: { 'x-test-user': 'u1' } });
    const list = await res.json();
    expect(list.connectors.map((c: { name: string; pasteLink: boolean }) => [c.name, c.pasteLink])).toEqual([['newrelic', true], ['other', false]]);
  });
});

describe('pasting the redirect', () => {
  it('exchanges the code with the stored PKCE verifier and the localhost redirect, and goes back to Settings linked', async () => {
    const out = await paste(pastedUrl({ code: 'the-code', state: state() }));
    expect(out.get('linked')).toBe('1');
    expect(out.get('server')).toBe('c1');
    expect(exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ tokenEndpoint: META.tokenEndpoint }), expect.objectContaining({ redirectUri: LOOPBACK }),
      { code: 'the-code', verifier: 'verifier' }, expect.anything());
    expect(linkWrites).toEqual(['linked']);
  });

  it('is refused for a server not on the user\'s list, before the state is used', async () => {
    loopbackFlag = [];
    const out = await paste(pastedUrl({ code: 'the-code', state: state() }));
    expect(out.get('error')).toMatch(/not set up for pasting/);
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a state from another connector\'s or user\'s sign-in and keeps the pending link, so the right address can still be pasted', async () => {
    for (const s of [state('u1', 'c2'), state('u2', 'c1'), `${STATE_NONCE}.${'x'.repeat(43)}`]) {
      const out = await paste(pastedUrl({ code: 'the-code', state: s }));
      expect(out.get('error')).toMatch(/not from this server's sign-in/);
    }
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect((await paste(pastedUrl({ code: 'the-code', state: state() }))).get('linked')).toBe('1');
  });

  it('says plainly when the sign-in has expired or was already used', async () => {
    stateRow = null;
    const out = await paste(pastedUrl({ code: 'the-code', state: state() }));
    expect(out.get('error')).toMatch(/invalid or has expired/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('shows the provider\'s error from the pasted address and sends nothing to the token endpoint', async () => {
    const out = await paste(pastedUrl({ error: 'access_denied', error_description: 'The user denied access', state: state() }));
    expect(out.get('error')).toBe('The server did not grant access: The user denied access');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses an address that is not the localhost redirect, without echoing it', async () => {
    const out = await paste(`https://evil.example/callback?code=secret-code&state=${state()}`);
    expect(out.get('error')).toMatch(/http:\/\/localhost:53682\/callback/);
    expect(out.get('error')).not.toContain('secret-code');
    expect(consumeOAuthState).not.toHaveBeenCalled();
  });

  it('refuses a paste for a connector whose current sign-in does not use the localhost redirect', async () => {
    stored = { client: { ...loopbackClient(), redirectUri: 'https://termag.example.test/api/mcp-connectors/oauth/callback' } };
    const out = await paste(pastedUrl({ code: 'the-code', state: state() }));
    expect(out.get('error')).toMatch(/Link it again/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('answers a paste from the setup wizard with a redirect back to its MCP step', async () => {
    const refused = await pasteTo('http://elsewhere.example/?code=c', { returnTo: 'welcome' });
    expect(refused.pathname).toMatch(/\/welcome$/);
    expect(refused.searchParams.get('step')).toBe('mcp');
    expect(refused.searchParams.get('error')).toBeTruthy();
    stateRow = { userId: 'u1', connectorId: 'c1', codeVerifier: 'verifier', returnTo: 'welcome' };
    const linked = await pasteTo(pastedUrl({ code: 'the-code', state: state() }), { returnTo: 'welcome' });
    expect(linked.pathname).toMatch(/\/welcome$/);
    expect(linked.searchParams.get('linked')).toBe('1');
  });

  it('answers 404 for another user\'s connector', async () => {
    const res = await fetch(`${base}/c1/oauth/paste`, {
      method: 'POST', headers: { 'x-test-user': 'u2', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: pastedUrl({ code: 'c', state: state('u2') }) }).toString(), redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });

  it('never logs the pasted address or the code', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await paste(pastedUrl({ code: 'the-secret-code', state: state() }));
      await paste(pastedUrl({ code: 'the-secret-code', state: state('u1', 'c2') }));
      await paste(`http://elsewhere.example/?code=the-secret-code`);
      const logged = spies.flatMap(s => s.mock.calls.flat().map(String)).join('\n');
      expect(logged).not.toContain('the-secret-code');
      expect(logged).not.toContain(LOOPBACK);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// What a process already listening on the loopback port could collect: the
// code and the signed state, from the address the browser lands on. These
// tests pin down what that pair is worth: the code is redeemable only with
// the PKCE verifier, which stays on the orchestrator; the state is bound to
// one user and one connector, works once, and expires; and a refused paste
// leaves the user's own sign-in pending.
describe('an intercepted localhost address', () => {
  it('carries the S256 challenge but never the PKCE verifier, which goes only to the token endpoint', async () => {
    stored = null;
    const url = await start();
    const verifier = (createOAuthState.mock.calls[0] as unknown as [string, string, string, string])[3];
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.toString()).not.toContain(verifier);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(url.searchParams.get('code_challenge')).not.toBe(verifier);
  });

  it('cannot be used by another termag user, even on their own connector for the same server, and leaves the sign-in pending', async () => {
    rows.push({ id: 'c3', userId: 'u2', name: 'newrelic', upstream: UPSTREAM, authType: 'oauth', oauthMetadata: META, linkStatus: 'needs_link', linkError: null, createdAt: new Date(), updatedAt: new Date() });
    const intercepted = pastedUrl({ code: 'the-code', state: state('u1', 'c1') });
    expect((await paste(intercepted, 'c3', 'u2')).get('error')).toMatch(/not from this server's sign-in/);
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect((await paste(intercepted, 'c1', 'u1')).get('linked')).toBe('1');
  });

  it('works once: a second paste of the same address finds no pending sign-in and sends nothing to the token endpoint', async () => {
    const address = pastedUrl({ code: 'the-code', state: state() });
    expect((await paste(address)).get('linked')).toBe('1');
    expect((await paste(address)).get('error')).toMatch(/invalid or has expired/);
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });
});
