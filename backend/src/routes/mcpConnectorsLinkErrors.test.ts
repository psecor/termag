import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// What Settings hears when a server refuses termag's redirect URI:
// oauth/start
// pre-flights the authorize URL and answers the refusal, with the URL an admin
// would allow-list, instead of the authorize URL.
// The harness is mcpConnectorsPaste.test.ts's.

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
let stateRow: { userId: string; connectorId: string; codeVerifier: string } | null = null;
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

// What the authorization server answers the pre-flight GET of the authorize URL.
let authorizeAnswer: { status: number; headers: Record<string, string>; text: string } = { status: 302, headers: { location: '/login' }, text: '' };
const preflights: string[] = [];
vi.mock('../services/mcpOAuthHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuthHttp')>()),
  safeOAuthHttp: () => async (url: string) => { preflights.push(url); return authorizeAnswer; },
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
  authorizeAnswer = { status: 302, headers: { location: '/login' }, text: '' };
  preflights.length = 0;
  vi.clearAllMocks();
});

const CALLBACK = 'https://termag.example.test/api/mcp-connectors/oauth/callback';
const META_NEWRELIC = { ...META, issuer: 'https://oauth2.service.newrelic.com' };

async function startRaw(connectorId = 'c2') {
  const res = await fetch(`${base}/${connectorId}/oauth/start`, { method: 'POST', headers: { 'x-test-user': 'u1' } });
  return { status: res.status, body: await res.json() };
}

describe('oauth/start pre-flights the authorize URL', () => {
  it('answers the server\'s refusal of the redirect URI, with the URL to allow-list, instead of sending the browser there', async () => {
    rows[1].oauthMetadata = META_NEWRELIC;
    stored = { client: { ...loopbackClient(), redirectUri: CALLBACK } };
    authorizeAnswer = {
      status: 302, text: '',
      headers: { location: 'https://oauth2.service.newrelic.com/error?error=invalid_request&error_description=The+%27redirect_uri%27+parameter+does+not+match+any+of+the+OAuth+2.0+Client%27s+pre-registered+redirect+urls.' },
    };
    const out = await startRaw();
    expect(out.status).toBe(400);
    expect(out.body.authorizeUrl).toBeUndefined();
    expect(out.body.redirectUri).toBe(CALLBACK);
    expect(out.body.error).toMatch(/^The server refused termag's redirect URI\. New Relic has no allow-list/);
    expect(out.body.error).not.toContain(CALLBACK);
    expect(new URL(preflights[0]).searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it('answers the authorize URL as before when the server goes on to its login page (it checks after login, as Datadog does)', async () => {
    stored = { client: { ...loopbackClient(), redirectUri: CALLBACK } };
    authorizeAnswer = { status: 307, headers: { location: '/account/login?next=%2Foauth2' }, text: '' };
    const out = await startRaw();
    expect(out.status).toBe(200);
    expect(new URL(out.body.authorizeUrl).searchParams.get('redirect_uri')).toBe(CALLBACK);
  });
});
