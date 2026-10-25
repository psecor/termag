import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The Settings API's boundaries: every route 404s while the
// flag is off, another user's connector is a 404 exactly like a missing one, a
// duplicate name is a 409, and secrets are refused with a 503 when there is no
// credential store. Connectors are an in-memory array behind a minimal prisma.

type Row = {
  id: string; userId: string; name: string; upstream: string; authType: string; headerTemplates: unknown; createdAt: Date; updatedAt: Date;
  oauthMetadata?: unknown;
};
let rows: Row[] = [];
let flagOn = true;
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
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find(r => r.id === where.id)!;
      if (data.name && duplicate(row.userId, data.name, row.id)) throw p2002();
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  },
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

const writeConnectorSecrets = vi.fn(async () => {});
vi.mock('../services/mcpConnectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpConnectorStore')>()),
  mcpBrokerEnabledForUser: async () => flagOn,
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
  consumeOAuthState: async (nonce: string) => (nonce === STATE_NONCE ? { userId: 'u1', connectorId: 'c4', codeVerifier: 'verifier' } : null),
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
}));

const exchangeCode = vi.fn(async () => ({ accessToken: 'at', expiresAt: null }));
vi.mock('../services/mcpOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpOAuth')>()),
  exchangeCode,
  discoverOAuth: async () => ({
    resource: 'https://mcp.example.test:18444/v2', scopes: [], issuer: 'https://auth.example.test',
    authorizationEndpoint: 'https://auth.example.test/authorize', tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: 'https://auth.example.test/register', revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
    issParameterSupported: true,
  }),
}));

const STATE_NONCE = 'n'.repeat(32);
const CLIENT = { clientId: 'cid', authMethod: 'none', via: 'dcr', redirectUri: 'r', issuer: 'https://auth.example.test' };
let lockStored: { client: typeof CLIENT; tokens?: unknown } | null = { client: CLIENT };
const linkWrites: Array<string | null> = [];
const lockIo = {
  read: async () => lockStored,
  write: async (v: typeof lockStored) => { lockStored = v; },
  remove: async () => { lockStored = null; },
  linked: async () => { linkWrites.push('linked'); },
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
  flagOn = true;
  storeConfigured = true;
  storedSecrets = {};
  lockStored = { client: CLIENT };
  linkWrites.length = 0;
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

  it('answers 404 on every method while mcp-broker-enabled is off, and changes nothing', async () => {
    flagOn = false;
    const before = structuredClone(rows);
    for (const [method, path, body] of [
      ['GET', '/', undefined], ['POST', '/', NEW], ['PATCH', '/c1', { name: 'renamed' }], ['DELETE', '/c1', undefined],
      ['POST', '/c4/oauth/start', undefined], ['DELETE', '/c4/oauth', undefined], ['GET', '/oauth/callback?state=s&code=c', undefined],
    ] as const) {
      expect(await call(method, path, 'u1', body), `${method} ${path}`).toEqual({ status: 404, body: { error: 'Not found' } });
    }
    expect(rows).toEqual(before);
    expect(prismaMock.mcpConnector.create).not.toHaveBeenCalled();
    expect(deliverToUserBoxes).not.toHaveBeenCalled();
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
    expect(await call('PATCH', '/c2', 'u1', { name: 'figma' })).toEqual({ status: 409, body: { error: 'You already have an MCP connector with that name' } });
    expect(rows.find(r => r.id === 'c2')?.name).toBe('jira');
    expect((await call('POST', '/', 'u1', { ...NEW, name: 'jira' })).status).toBe(409);
    // Another user's name is not a clash.
    expect((await call('PATCH', '/c2', 'u1', { name: 'linear' })).status).toBe(200);
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
