import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The Settings API's boundaries: every route 404s while the
// flag is off, another user's connector is a 404 exactly like a missing one, a
// duplicate name is a 409, and secrets are refused with a 503 when there is no
// credential store. Connectors are an in-memory array behind a minimal prisma.

type Row = {
  id: string; userId: string; name: string; displayName?: string | null; upstream: string; authType: string; headerTemplates: unknown; createdAt: Date; updatedAt: Date;
  oauthMetadata?: unknown; oauthScopes?: unknown;
};
let rows: Row[] = [];
// api-broker-enabled for the user: whether Settings offers the Google connector.
let apiFlagOn = false;
// What the mcp-default-connectors flag serves: the catalog, or null while it is off.
const ACME_ENTRY = { name: 'acme', upstream: 'https://mcp.example.test:18444/acme' };
let defaultsFlag: unknown = [ACME_ENTRY];
// What the mcp-oauth-scope-labels flag serves; null while it doesn't exist.
let labelsFlag: unknown = null;
let storeConfigured = true;
let storedSecrets: Record<string, string> = {};

const duplicate = (userId: string, name: string, id?: string) => rows.some(r => r.userId === userId && r.name === name && r.id !== id);
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const prismaMock = {
  mcpConnector: {
    create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'updatedAt'> }) => {
      if (duplicate(data.userId, data.name)) throw p2002();
      const row = { ...data, id: `c${rows.length + 1}x`, createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return row;
    }),
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find(r => r.id === where.id)!;
      if (data.name && duplicate(row.userId, data.name, row.id)) throw p2002();
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  },
  // For the mcp-oauth-loopback-servers read (mcpConnectorsPaste.test.ts covers it).
  user: { findUnique: vi.fn(async () => null) },
};
vi.mock('../db', () => ({ prisma: prismaMock }));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'], unixUsername: 'pat' };
    next();
  },
}));

vi.mock('../services/credentialStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/credentialStore')>()),
  getCredentialStoreConfig: () => (storeConfigured ? { kmsKeyId: 'k' } : null),
}));

const deliverToUserBoxes = vi.fn(async () => {});
vi.mock('../services/credentialDelivery', () => ({ deliverToUserBoxes }));
// oauth/start pre-flights the authorize URL (services/mcpOAuthRedirectHelp.ts): the server goes on to its login page.
vi.mock('../services/mcpOAuthHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuthHttp')>()),
  safeOAuthHttp: () => async () => ({ status: 302, headers: { location: '/login' }, text: '' }),
}));

vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  jsonVariation: async (key: string, _user: unknown, fallback: unknown) => (
    key === 'mcp-default-connectors' ? defaultsFlag : key === 'mcp-oauth-scope-labels' ? labelsFlag : fallback),
}));

const writeConnectorSecrets = vi.fn(async () => {});
vi.mock('../services/mcpConnectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpConnectorStore')>()),
  apiBrokerEnabledForUser: async () => apiFlagOn,
  findConnector: async (id: string) => rows.find(r => r.id === id) ?? null,
  listConnectors: async (userId: string) => rows.filter(r => r.userId === userId),
  deleteConnector: async (userId: string, id: string) => {
    const before = rows.length;
    rows = rows.filter(r => !(r.id === id && r.userId === userId));
    return rows.length < before;
  },
  connectorSecretNames: async () => [],
  readConnectorSecrets: async () => storedSecrets,
  writeConnectorSecrets,
  consumeOAuthState: async (nonce: string) => (nonce === STATE_NONCE ? { userId: 'u1', connectorId: 'c4', codeVerifier: 'verifier', scopes: STATE_SCOPES, returnTo: stateReturnTo } : null),
  readOAuth: async () => ({ client: CLIENT }),
  withOAuthLock: async (_u: string, _c: string, fn: (io: typeof lockIo) => Promise<unknown>) => fn(lockIo),
  // The store's transaction: the row and the credential removal change together or not at all.
  updateConnectorDroppingOAuth: async (_u: string, id: string, data: Partial<Row>) => {
    const r = rows.find(x => x.id === id)!;
    if (data.name && duplicate(r.userId, data.name, r.id)) throw p2002();
    Object.assign(r, data);
    const dropped = lockStored;
    lockStored = null;
    return { row: r, dropped };
  },
  setLinkStatus: async () => {},
  createOAuthState,
  forgetConnectorOAuth: async () => {},
}));

const createOAuthState = vi.fn(async (..._args: unknown[]) => {});
// The Slack workspace a sign-in is pinned to (services/mcpOAuthSlackTeam.ts covers how it is chosen).
let teamPin: string | undefined;
const authorizeTeam = vi.fn(async (..._args: unknown[]) => teamPin);
vi.mock('../services/mcpOAuthSlackTeam', () => ({ authorizeTeam }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));
// What the catalog server's discovery advertises.
let discoveredScopes: string[] = [];
const exchangeCode = vi.fn(async (..._args: unknown[]): Promise<{ accessToken: string; expiresAt: null; scope?: string }> => ({ accessToken: 'at', expiresAt: null }));
vi.mock('../services/mcpOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuth')>()),
  exchangeCode,
  registerClient: async () => CLIENT,
  discoverOAuth: async () => ({
    resource: 'https://mcp.example.test:18444/v2', scopes: discoveredScopes, issuer: 'https://auth.example.test',
    authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: 'https://auth.example.test/register', revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
    issParameterSupported: true,
  }),
}));

const STATE_NONCE = 'n'.repeat(32);
const STATE_SCOPES = ['search:read.public', 'channels:history'];
// Where the pending sign-in's state row says to return: Settings (null) or the setup wizard.
let stateReturnTo: 'welcome' | null = null;
const linkedScopes: unknown[] = [];
const CLIENT = { clientId: 'cid', authMethod: 'none', via: 'dcr', redirectUri: 'r', issuer: 'https://auth.example.test' };
let lockStored: { client: typeof CLIENT; tokens?: unknown } | null = { client: CLIENT };
const linkWrites: Array<string | null> = [];
const lockIo = {
  read: async () => lockStored,
  write: async (v: typeof lockStored) => { lockStored = v; },
  remove: async () => { lockStored = null; },
  linked: async (scopes?: unknown) => { linkWrites.push('linked'); linkedScopes.push(scopes); },
  needsLink: async (reason: string | null) => { linkWrites.push(reason); },
};
const { mcpConnectorsRouter } = await import('./mcpConnectors');
const { signState, OAuthGrantError } = await import('../services/mcpOAuth');

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.MCP_UPSTREAM_TEST_ALLOW = 'mcp.example.test:18444';
  process.env.MCP_BROKER_URL = 'https://mcp-broker.example.test';
  const app = express();
  app.use(express.json());
  app.use('/api/mcp-connectors', mcpConnectorsRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp-connectors`;
});

afterAll(async () => {
  delete process.env.MCP_UPSTREAM_TEST_ALLOW;
  delete process.env.MCP_BROKER_URL;
  delete process.env.FRONTEND_URL;
  await new Promise(resolve => server.close(resolve));
});

const row = (over: Partial<Row>): Row => ({
  id: 'c1', userId: 'u1', name: 'figma', upstream: 'https://mcp.example.test/mcp', authType: 'static',
  headerTemplates: { authorization: 'Bearer {{secret.token}}' }, createdAt: new Date(), updatedAt: new Date(), ...over,
});

beforeEach(() => {
  rows = [
    row({}), row({ id: 'c2', name: 'jira' }), row({ id: 'c3', userId: 'u2', name: 'linear' }),
    row({ id: 'c4', name: 'notes', authType: 'oauth', headerTemplates: null }),
  ];
  apiFlagOn = false;
  defaultsFlag = [ACME_ENTRY];
  labelsFlag = null;
  storeConfigured = true;
  storedSecrets = {};
  lockStored = { client: CLIENT };
  linkWrites.length = 0;
  linkedScopes.length = 0;
  discoveredScopes = [];
  process.env.FRONTEND_URL = 'https://termag.example.test';
  vi.clearAllMocks();
});

async function call(method: string, path: string, user: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const NEW = { name: 'notion', upstream: 'https://mcp.example.test:18444/notion', auth: { type: 'static', headers: { authorization: 'Bearer {{secret.token}}' } } };

describe('mcp connectors routes', () => {
  it('needs a signed-in user', async () => {
    expect((await call('GET', '/', null)).status).toBe(401);
  });

  it("answers another user's connector with the same 404 as a missing one, and leaves it alone", async () => {
    const missing = { patch: await call('PATCH', '/nope', 'u2', { name: 'mine' }), del: await call('DELETE', '/nope', 'u2') };
    expect(missing.patch).toEqual({ status: 404, body: { error: 'No such MCP connector' } });
    expect(await call('PATCH', '/c1', 'u2', { name: 'mine' })).toEqual(missing.patch);
    expect(await call('PATCH', '/c1', 'u2', { secrets: { token: 'stolen' } })).toEqual(missing.patch);
    expect(await call('DELETE', '/c1', 'u2')).toEqual(missing.del);
    expect(await call('POST', '/c4/oauth/start', 'u2')).toEqual(await call('POST', '/nope/oauth/start', 'u2'));
    expect((await call('POST', '/c4/oauth/start', 'u2')).status).toBe(404);
    expect(await call('DELETE', '/c4/oauth', 'u2')).toEqual(await call('DELETE', '/nope/oauth', 'u2'));
    expect((await call('DELETE', '/c4/oauth', 'u2')).status).toBe(404);
    expect(rows.find(r => r.id === 'c1')).toMatchObject({ userId: 'u1', name: 'figma' });
    expect(writeConnectorSecrets).not.toHaveBeenCalled();
    expect(deliverToUserBoxes).not.toHaveBeenCalled();
  });

  it('lists only the caller\'s connectors', async () => {
    const res = await call('GET', '/', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.connectors.map((c: { name: string }) => c.name)).toEqual(['figma', 'jira', 'notes']);
    expect(res.body.connectors[0].brokerUrl).toBe('https://mcp-broker.example.test/c/c1');
  });

  it('answers 409 when a rename or a create takes a name the user already has', async () => {
    expect(await call('PATCH', '/c2', 'u1', { name: 'figma' })).toEqual({
      status: 409, body: { error: 'Another of your MCP servers is already named "figma". Choose a different name.' },
    });
    expect(rows.find(r => r.id === 'c2')?.name).toBe('jira');
    expect((await call('POST', '/', 'u1', { ...NEW, name: 'jira' })).status).toBe(409);
    // Another user's name is not a clash.
    expect((await call('PATCH', '/c2', 'u1', { name: 'linear' })).status).toBe(200);
  });

  it('takes any display text as the name and derives the connector name from it', async () => {
    const created = await call('POST', '/', 'u1', { ...NEW, name: 'Claude Docs' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'claude-docs', displayName: 'Claude Docs' });
    expect(rows.find(r => r.id === created.body.id)).toMatchObject({ name: 'claude-docs', displayName: 'Claude Docs' });
    const renamed = await call('PATCH', '/c2', 'u1', { name: 'Jira Cloud' });
    expect(renamed.body).toMatchObject({ name: 'jira-cloud', displayName: 'Jira Cloud' });
    // Renaming back to a plain connector name clears the display text.
    expect((await call('PATCH', '/c2', 'u1', { name: 'jira' })).body).toMatchObject({ name: 'jira', displayName: 'jira' });
    expect(rows.find(r => r.id === 'c2')?.displayName).toBeNull();
    expect((await call('POST', '/', 'u1', { ...NEW, name: '日本語' })).status).toBe(400);
  });

  it('shows an existing connector, which has no display text, under its name', async () => {
    const res = await call('GET', '/', 'u1');
    expect(res.body.connectors.map((c: { name: string; displayName: string }) => [c.name, c.displayName]))
      .toEqual([['figma', 'figma'], ['jira', 'jira'], ['notes', 'notes']]);
  });

  it('refuses a display name whose connector name another of the user\'s servers has, naming both', async () => {
    const res = await call('POST', '/', 'u1', { ...NEW, name: 'Figma' });
    expect(res).toEqual({
      status: 409,
      body: { error: 'Another of your MCP servers is already named "figma", which is what "Figma" becomes in tool names (mcp__figma__…). Choose a different name.' },
    });
    expect((await call('PATCH', '/c2', 'u1', { name: 'FIGMA' })).status).toBe(409);
    expect(rows.filter(r => r.userId === 'u1' && r.name === 'figma')).toHaveLength(1);
  });

  it('puts the old secrets back when a PATCH that changed them fails', async () => {
    storedSecrets = { token: 'old' };
    expect((await call('PATCH', '/c2', 'u1', { name: 'figma', secrets: { token: 'new' } })).status).toBe(409);
    expect(writeConnectorSecrets.mock.calls).toEqual([['u1', 'c2', { token: 'new' }], ['u1', 'c2', { token: 'old' }]]);
    expect(deliverToUserBoxes).not.toHaveBeenCalled();
  });

  it('answers 503 for secrets when the credential store is not configured, and writes nothing', async () => {
    storeConfigured = false;
    const post = await call('POST', '/', 'u1', { ...NEW, secrets: { token: 't' } });
    expect(post.status).toBe(503);
    expect(post.body.error).toContain('credential store is not configured');
    expect(rows.some(r => r.name === 'notion')).toBe(false);
    expect((await call('PATCH', '/c1', 'u1', { secrets: { token: 't' } })).status).toBe(503);
    expect(writeConnectorSecrets).not.toHaveBeenCalled();
    // Without secrets the connector is still saved.
    expect((await call('POST', '/', 'u1', NEW)).status).toBe(201);
  });

  it('refuses secrets or headers on an OAuth connector, and OAuth sign-in without a credential store', async () => {
    expect((await call('PATCH', '/c4', 'u1', { secrets: { token: 't' } })).status).toBe(400);
    expect((await call('PATCH', '/c4', 'u1', { auth: { type: 'static', headers: { a: 'b' } } })).status).toBe(400);
    expect(writeConnectorSecrets).not.toHaveBeenCalled();
    storeConfigured = false;
    expect((await call('POST', '/c4/oauth/start', 'u1')).status).toBe(503);
  });

  it('creates, then deletes, the owner\'s connector and redelivers each time', async () => {
    const created = await call('POST', '/', 'u1', { ...NEW, secrets: { token: 't' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'notion', upstream: 'https://mcp.example.test:18444/notion', authType: 'static' });
    expect(JSON.stringify(created.body)).not.toContain('"t"');
    expect(writeConnectorSecrets).toHaveBeenCalledWith('u1', created.body.id, { token: 't' });
    expect((await call('DELETE', `/${created.body.id}`, 'u1')).status).toBe(204);
    expect(rows.some(r => r.name === 'notion')).toBe(false);
    expect(deliverToUserBoxes).toHaveBeenCalledTimes(2);
  });
});

describe('oauth callback issuer (RFC 9207)', () => {
  const META = {
    resource: 'https://mcp.example.test/mcp', scopes: [], issuer: 'https://auth.example.test',
    authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: null, revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
  };

  async function callback(iss: string | undefined, meta: Record<string, unknown> = META) {
    rows.find(r => r.id === 'c4')!.oauthMetadata = meta;
    const q = new URLSearchParams({ state: signState(process.env.SESSION_SECRET ?? 'dev-secret', STATE_NONCE, 'u1', 'c4'), code: 'the-code' });
    if (iss !== undefined) q.set('iss', iss);
    const res = await fetch(`${base}/oauth/callback?${q}`, { headers: { 'x-test-user': 'u1' }, redirect: 'manual' });
    return new URL(res.headers.get('location')!, 'http://x').searchParams;
  }

  it('marks a connector needs_link when its code exchange fails, unless it still holds working tokens', async () => {
    const ISS = 'https://auth.example.test';
    exchangeCode.mockRejectedValueOnce(new OAuthGrantError('bad code'));
    expect((await callback(ISS)).get('error')).toMatch(/Linking failed: bad code/);
    expect(linkWrites).toEqual(['bad code']);

    linkWrites.length = 0;
    lockStored = { client: CLIENT, tokens: { accessToken: 'still-good', expiresAt: null } };
    exchangeCode.mockRejectedValueOnce(new OAuthGrantError('bad code'));
    expect((await callback(ISS)).get('error')).toMatch(/Linking failed/);
    expect(linkWrites).toEqual([]);
    expect(lockStored?.tokens).toEqual({ accessToken: 'still-good', expiresAt: null });
  });

  it('never sends the code or the verifier anywhere when iss names another authorization server', async () => {
    const out = await callback('https://mcp.linear.app');
    expect(out.get('error')).toMatch(/different authorization server/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a missing iss from a server that advertises sending it', async () => {
    const out = await callback(undefined, { ...META, issParameterSupported: true });
    expect(out.get('error')).toMatch(/did not say who issued/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('exchanges the code when iss matches (trailing slash aside), or when the server never sends iss', async () => {
    expect((await callback('https://auth.example.test/', { ...META, issParameterSupported: true })).get('linked')).toBe('1');
    expect((await callback(undefined)).get('linked')).toBe('1');
    expect(exchangeCode).toHaveBeenCalledTimes(2);
    expect(exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ tokenEndpoint: 'https://auth.example.test/token' }), expect.anything(),
      { code: 'the-code', verifier: 'verifier' }, expect.anything());
  });
});

describe('PATCH a new upstream on an oauth connector', () => {
  const TOKENS = { accessToken: 'old-server', expiresAt: null };

  it('puts the old tokens back when the update fails', async () => {
    lockStored = { client: CLIENT, tokens: TOKENS };
    expect((await call('PATCH', '/c4', 'u1', { name: 'figma', upstream: 'https://mcp.example.test:18444/v2' })).status).toBe(409);
    expect(lockStored).toEqual({ client: CLIENT, tokens: TOKENS });
  });

  it('takes the old tokens out when it succeeds', async () => {
    lockStored = { client: CLIENT, tokens: TOKENS };
    const res = await call('PATCH', '/c4', 'u1', { upstream: 'https://mcp.example.test:18444/v2' });
    expect(res.status).toBe(200);
    expect(lockStored).toBeNull();
  });
});

describe('the catalog of MCP servers (the mcp-default-connectors flag)', () => {
  const ACME = 'https://mcp.example.test:18444/acme';

  it('offers a catalog server until the user has a connector for its URL, then lists it as an ordinary connector', async () => {
    const before = await call('GET', '/', 'u1');
    expect(before.body.catalog).toEqual([{ name: 'acme', upstream: ACME }]);
    rows.push(row({ id: 'c9', name: 'acme', upstream: ACME, authType: 'oauth', headerTemplates: null }));
    const after = await call('GET', '/', 'u1');
    expect(after.body.catalog).toEqual([]);
    const connected = after.body.connectors.find((c: { id: string }) => c.id === 'c9');
    expect(connected).toMatchObject({ name: 'acme', authType: 'oauth', linkStatus: 'needs_link' });
    expect(connected).not.toHaveProperty('default');
    // u1 connecting it doesn't affect u2, who is still offered it.
    expect((await call('GET', '/', 'u2')).body.catalog).toHaveLength(1);
  });

  it('stops offering it once the user has any connector for that URL, even one added by hand with headers', async () => {
    rows.push(row({ id: 'c9', name: 'mine', upstream: ACME }));
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([]);
  });

  it('offers it again after the user deletes their connector for it', async () => {
    rows.push(row({ id: 'c9', name: 'acme', upstream: ACME, authType: 'oauth', headerTemplates: null }));
    expect((await call('DELETE', '/c9', 'u1')).status).toBe(204);
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([{ name: 'acme', upstream: ACME }]);
  });

  it('creates the user\'s oauth connector on connect and answers the sign-in URL', async () => {
    const res = await call('POST', '/catalog/acme/connect', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toMatch(/^https:\/\/auth\.example\.test\/authorize\?/);
    const created = rows.find(r => r.id === res.body.id);
    expect(created).toMatchObject({ userId: 'u1', name: 'acme', upstream: ACME, authType: 'oauth' });
    expect(deliverToUserBoxes).toHaveBeenCalledWith('u1');
    // Connecting again (a double click) reuses the connector instead of creating a second one.
    const again = await call('POST', '/catalog/acme/connect', 'u1');
    expect(again.body.id).toBe(res.body.id);
    expect(prismaMock.mcpConnector.create).toHaveBeenCalledTimes(1);
  });

  it('keeps a connect\'s returnTo welcome with its sign-in, for the setup wizard', async () => {
    expect((await call('POST', '/catalog/acme/connect', 'u1', { returnTo: 'welcome' })).status).toBe(200);
    expect(createOAuthState.mock.calls.at(-1)?.[5]).toBe('welcome');
  });

  it('lists a catalog entry\'s label and gives the connector it creates that display name', async () => {
    defaultsFlag = [{ ...ACME_ENTRY, label: 'Acme Cloud' }];
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([{ name: 'acme', label: 'Acme Cloud', upstream: ACME }]);
    const res = await call('POST', '/catalog/acme/connect', 'u1');
    expect(res.status).toBe(200);
    expect(rows.find(r => r.id === res.body.id)).toMatchObject({ name: 'acme', displayName: 'Acme Cloud' });
    expect(res.body.connector).toMatchObject({ name: 'acme', displayName: 'Acme Cloud' });
  });

  it('offers nothing and connects nothing while mcp-default-connectors is off (null) or serves []', async () => {
    for (const value of [null, []]) {
      defaultsFlag = value;
      expect((await call('GET', '/', 'u1')).body.catalog).toEqual([]);
      expect(await call('POST', '/catalog/acme/connect', 'u1')).toEqual({ status: 404, body: { error: 'No such MCP server in the catalog' } });
    }
    expect(prismaMock.mcpConnector.create).not.toHaveBeenCalled();
  });

  it('reuses an OAuth connector the user added by hand for that URL, whatever its name', async () => {
    const { discoverOAuth } = await import('../services/mcpOAuth');
    const oauthMetadata = await discoverOAuth(ACME, {} as never);
    rows.push(row({ id: 'c9', name: 'my-acme', upstream: ACME, authType: 'oauth', headerTemplates: null, oauthMetadata }));
    const res = await call('POST', '/catalog/acme/connect', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('c9');
    expect(prismaMock.mcpConnector.create).not.toHaveBeenCalled();
  });

  it('answers a 409 that names the remedy when the user has a connector with that name for another server', async () => {
    rows.push(row({ id: 'c9', name: 'acme', upstream: 'https://mcp.example.test/other' }));
    const res = await call('POST', '/catalog/acme/connect', 'u1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/named "acme" for another server\. Rename or delete it/);
    expect(rows.filter(r => r.userId === 'u1' && r.name === 'acme')).toHaveLength(1);
  });

  it('reuses the connector a concurrent connect created instead of answering 409', async () => {
    // The other request's row lands between this one's check and its create.
    prismaMock.mcpConnector.create.mockImplementationOnce(async ({ data }) => {
      rows.push({ ...data, id: 'c-race', createdAt: new Date(), updatedAt: new Date() });
      throw p2002();
    });
    const res = await call('POST', '/catalog/acme/connect', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('c-race');
  });

  it('answers 404 for a name not in the catalog, and 503 without a credential store, creating nothing', async () => {
    expect((await call('POST', '/catalog/figma/connect', 'u1')).status).toBe(404);
    storeConfigured = false;
    expect((await call('POST', '/catalog/acme/connect', 'u1')).status).toBe(503);
    expect(prismaMock.mcpConnector.create).not.toHaveBeenCalled();
  });
});

describe('choosing the scopes a sign-in asks for', () => {
  const SCOPES = ['search:read.public', 'channels:history', 'chat:write'];
  const META = {
    resource: 'https://mcp.slack.com', scopes: SCOPES, issuer: 'https://mcp.slack.com',
    authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize', tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
    registrationEndpoint: 'https://slack.com/register', revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
  };
  const slack = () => { rows.find(r => r.id === 'c4')!.oauthMetadata = META; };
  const scopeOf = (url: string) => new URL(url).searchParams.get('scope');

  it('asks only for the ticked scopes on the authorize URL, and keeps them with the sign-in', async () => {
    slack();
    const res = await call('POST', '/c4/oauth/start', 'u1', { scopes: ['channels:history', 'search:read.public'] });
    expect(res.status).toBe(200);
    expect(scopeOf(res.body.authorizeUrl)).toBe('search:read.public channels:history');
    expect(createOAuthState).toHaveBeenCalledWith(expect.any(String), 'u1', 'c4', expect.any(String), ['search:read.public', 'channels:history'], null);
  });

  it('pins the authorize URL to the Slack workspace the sign-in is for', async () => {
    slack();
    teamPin = 'T0TERMAG';
    try {
      const res = await call('POST', '/c4/oauth/start', 'u1');
      expect(new URL(res.body.authorizeUrl).searchParams.get('team')).toBe('T0TERMAG');
      expect(authorizeTeam).toHaveBeenCalledWith(META, CLIENT, null, expect.any(Function));
    } finally {
      teamPin = undefined;
    }
    expect(new URL((await call('POST', '/c4/oauth/start', 'u1')).body.authorizeUrl).searchParams.has('team')).toBe(false);
  });

  it('asks for every advertised scope when the request names none', async () => {
    slack();
    const res = await call('POST', '/c4/oauth/start', 'u1');
    expect(scopeOf(res.body.authorizeUrl)).toBe(SCOPES.join(' '));
  });

  it('refuses a scope the server does not offer, or none at all, before any sign-in starts', async () => {
    slack();
    expect((await call('POST', '/c4/oauth/start', 'u1', { scopes: ['admin'] })).status).toBe(400);
    expect((await call('POST', '/c4/oauth/start', 'u1', { scopes: [] })).status).toBe(400);
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it('stores what was asked for and what the token response says was granted, and shows both on the connector', async () => {
    slack();
    exchangeCode.mockResolvedValueOnce({ accessToken: 'at', expiresAt: null, scope: 'search:read.public' });
    const q = new URLSearchParams({ state: signState(process.env.SESSION_SECRET ?? 'dev-secret', STATE_NONCE, 'u1', 'c4'), code: 'c' });
    const cb = await fetch(`${base}/oauth/callback?${q}`, { headers: { 'x-test-user': 'u1' }, redirect: 'manual' });
    expect(new URL(cb.headers.get('location')!, 'http://x').searchParams.get('linked')).toBe('1');
    expect(linkedScopes).toEqual([{ requested: STATE_SCOPES, granted: ['search:read.public'] }]);

    // What the store's linked() wrote, read back through the list.
    Object.assign(rows.find(r => r.id === 'c4')!, { oauthScopes: linkedScopes[0], linkStatus: 'linked' });
    const c4 = (await call('GET', '/', 'u1')).body.connectors.find((c: { id: string }) => c.id === 'c4');
    expect(c4.oauth.requestedScopes.map((s: { name: string }) => s.name)).toEqual(STATE_SCOPES);
    expect(c4.oauth.grantedScopes).toEqual([{ name: 'search:read.public', label: 'Search messages in public channels' }]);
    expect(c4.oauth.scopeChoice.options).toContainEqual({ name: 'chat:write', label: 'Send messages' });
  });

  it("labels the checklist from the mcp-oauth-scope-labels flag for the user, and from Slack's built-in table without it", async () => {
    slack();
    const options = async () => (await call('GET', '/', 'u1')).body.connectors.find((c: { id: string }) => c.id === 'c4').oauth.scopeChoice.options;
    expect((await options()).find((o: { name: string }) => o.name === 'chat:write')).toEqual({ name: 'chat:write', label: 'Send messages' });
    labelsFlag = { 'https://mcp.slack.com': [{ scope: 'chat:write', label: 'Post messages as you' }, { scope: 'channels:history', label: 'Channel history' }] };
    expect(await options()).toEqual([
      { name: 'search:read.public', label: 'search:read.public' },
      { name: 'channels:history', label: 'Channel history' },
      { name: 'chat:write', label: 'Post messages as you' },
    ]);
  });

  it('records no granted scopes when the token response names none', async () => {
    slack();
    const q = new URLSearchParams({ state: signState(process.env.SESSION_SECRET ?? 'dev-secret', STATE_NONCE, 'u1', 'c4'), code: 'c' });
    await fetch(`${base}/oauth/callback?${q}`, { headers: { 'x-test-user': 'u1' }, redirect: 'manual' });
    expect(linkedScopes).toEqual([{ requested: STATE_SCOPES, granted: null }]);
  });

  it('offers no checklist for a server that advertises no scopes, and its sign-in sends no scope', async () => {
    rows.find(r => r.id === 'c4')!.oauthMetadata = { ...META, scopes: [] };
    const c4 = (await call('GET', '/', 'u1')).body.connectors.find((c: { id: string }) => c.id === 'c4');
    expect(c4.oauth.scopeChoice).toBeNull();
    expect(scopeOf((await call('POST', '/c4/oauth/start', 'u1')).body.authorizeUrl)).toBeNull();
  });

  it("keeps offline and offline_access off the checklist and asks for offline_access on every sign-in (New Relic's scopes)", async () => {
    rows.find(r => r.id === 'c4')!.oauthMetadata = { ...META, scopes: ['observability:read', 'offline', 'offline_access'] };
    const c4 = (await call('GET', '/', 'u1')).body.connectors.find((c: { id: string }) => c.id === 'c4');
    expect(c4.oauth.scopeChoice).toBeNull();
    expect(scopeOf((await call('POST', '/c4/oauth/start', 'u1')).body.authorizeUrl)).toBe('observability:read offline_access');

    rows.find(r => r.id === 'c4')!.oauthMetadata = { ...META, scopes: ['read', 'write', 'offline'] };
    const options = (await call('GET', '/', 'u1')).body.connectors.find((c: { id: string }) => c.id === 'c4').oauth.scopeChoice.options;
    expect(options.map((o: { name: string }) => o.name)).toEqual(['read', 'write']);
    expect(scopeOf((await call('POST', '/c4/oauth/start', 'u1', { scopes: ['write'] })).body.authorizeUrl)).toBe('write offline');
  });

  it('connects a catalog server without a sign-in URL when asked to let the person choose first', async () => {
    discoveredScopes = SCOPES;
    const res = await call('POST', '/catalog/acme/connect', 'u1', { chooseScopes: true });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toBeNull();
    expect(res.body.connector.oauth.scopeChoice.options).toHaveLength(3);
    expect(createOAuthState).not.toHaveBeenCalled();
    // Without the opt-in, connect starts the sign-in at once, asking for every scope.
    const plain = await call('POST', '/catalog/acme/connect', 'u1');
    expect(scopeOf(plain.body.authorizeUrl)).toBe(SCOPES.join(' '));
  });
});

describe('API connectors (Google)', () => {
  const GOOGLE_CLIENT = JSON.stringify([{ issuer: 'https://accounts.google.com', resource: 'https://www.googleapis.com', clientId: 'gid', clientSecretEnv: 'TEST_GOOGLE_SECRET' }]);
  beforeEach(() => {
    apiFlagOn = true;
    process.env.MCP_OAUTH_CLIENTS = GOOGLE_CLIENT;
    process.env.TEST_GOOGLE_SECRET = 's';
  });
  afterAll(() => {
    delete process.env.MCP_OAUTH_CLIENTS;
    delete process.env.TEST_GOOGLE_SECRET;
  });

  it('offers Google under Available to connect only with api-broker-enabled and a Google client', async () => {
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([ACME_ENTRY, { name: 'google', upstream: 'https://www.googleapis.com', kind: 'api' }]);
    apiFlagOn = false;
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([ACME_ENTRY]);
    apiFlagOn = true;
    delete process.env.MCP_OAUTH_CLIENTS;
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([ACME_ENTRY]);
    expect((await call('POST', '/catalog/google/connect', 'u1')).status).toBe(404);
  });

  it("connects Google with its fixed metadata, no discovery, and a sign-in that asks for a refresh token", async () => {
    const res = await call('POST', '/catalog/google/connect', 'u1');
    expect(res.status).toBe(200);
    const u = new URL(res.body.authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.has('resource')).toBe(false);
    const created = rows.find(r => r.id === res.body.id)!;
    expect(created).toMatchObject({ name: 'google', upstream: 'https://www.googleapis.com', authType: 'oauth', oauthMetadata: { api: 'google' } });
    expect(res.body.connector).toMatchObject({ kind: 'api', brokerUrl: null });
    expect((await call('GET', '/', 'u1')).body.catalog).toEqual([ACME_ENTRY]);
  });

  it("refuses to move a Google connector's upstream", async () => {
    const res = await call('POST', '/catalog/google/connect', 'u1');
    const moved = await call('PATCH', `/${res.body.id}`, 'u1', { upstream: 'https://mcp.example.test/mcp' });
    expect(moved.status).toBe(400);
    expect(rows.find(r => r.id === res.body.id)!.upstream).toBe('https://www.googleapis.com');
  });
});

describe('a sign-in started in the setup wizard', () => {
  const META = {
    resource: 'https://mcp.example.test/mcp', scopes: [], issuer: 'https://auth.example.test',
    authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: null, revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
  };
  async function callbackLocation(params: Record<string, string>) {
    rows.find(r => r.id === 'c4')!.oauthMetadata = META;
    const q = new URLSearchParams({ state: signState(process.env.SESSION_SECRET ?? 'dev-secret', STATE_NONCE, 'u1', 'c4'), ...params });
    const res = await fetch(`${base}/oauth/callback?${q}`, { headers: { 'x-test-user': 'u1' }, redirect: 'manual' });
    expect(res.status).toBe(303);
    return new URL(res.headers.get('location')!, 'http://x');
  }
  afterEach(() => { stateReturnTo = null; });

  it('keeps returnTo welcome with the sign-in, and nothing else for any other value', async () => {
    rows.find(r => r.id === 'c4')!.oauthMetadata = META;
    await call('POST', '/c4/oauth/start', 'u1', { returnTo: 'welcome' });
    expect(createOAuthState.mock.calls.at(-1)?.[5]).toBe('welcome');
    await call('POST', '/c4/oauth/start', 'u1', { returnTo: 'https://evil.example/' });
    expect(createOAuthState.mock.calls.at(-1)?.[5]).toBeNull();
    await call('POST', '/c4/oauth/start', 'u1');
    expect(createOAuthState.mock.calls.at(-1)?.[5]).toBeNull();
  });

  it('returns a finished sign-in to the wizard\'s MCP step', async () => {
    stateReturnTo = 'welcome';
    const to = await callbackLocation({ code: 'the-code', iss: 'https://auth.example.test' });
    expect(to.pathname).toMatch(/\/welcome$/);
    expect(Object.fromEntries(to.searchParams)).toEqual({ step: 'mcp', server: 'c4', linked: '1' });
  });

  it('returns a refused sign-in to the wizard with its error', async () => {
    stateReturnTo = 'welcome';
    const to = await callbackLocation({ error: 'access_denied' });
    expect(to.pathname).toMatch(/\/welcome$/);
    expect(to.searchParams.get('step')).toBe('mcp');
    expect(to.searchParams.get('error')).toMatch(/did not grant access/);
  });

  it('returns to Settings when the sign-in started there', async () => {
    const to = await callbackLocation({ code: 'the-code', iss: 'https://auth.example.test' });
    expect(to.pathname).toMatch(/\/settings\/mcp$/);
    expect(to.searchParams.get('linked')).toBe('1');
  });
});
