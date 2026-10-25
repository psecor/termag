import { describe, it, expect, vi, beforeEach } from 'vitest';

// withOAuthLock's transaction is the only connection a write inside the lock
// may use: the global client here has nothing but $transaction, so a write
// that went around it would throw instead of quietly taking a second pool
// connection while this one holds the advisory lock.

type Row = { ciphertext: Buffer };
let credential: Row | null = null;
const linkWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
const lockSql: string[] = [];

const tx = {
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => { lockSql.push(strings.join('?')); return 1; }),
  userCredential: {
    findUnique: vi.fn(async () => credential),
    upsert: vi.fn(async ({ create }: { create: Row }) => { credential = { ciphertext: create.ciphertext }; }),
    deleteMany: vi.fn(async () => { credential = null; return { count: 1 }; }),
  },
  mcpConnector: {
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { linkWrites.push(args); return { count: 1 }; }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (updateFails) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      return { id: 'c1', ...data };
    }),
  },
};
let updateFails = false;
let inTransaction = false;
// Like Postgres: a transaction whose callback throws leaves nothing behind.
const prismaMock = {
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
    inTransaction = true;
    const before = credential;
    try { return await fn(tx); } catch (err) { credential = before; throw err; } finally { inTransaction = false; }
  }),
};
vi.mock('../db', () => ({ prisma: prismaMock }));

const seal = (v: unknown) => Buffer.from(JSON.stringify(v));
vi.mock('./credentialStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentialStore')>()),
  getCredentialStoreConfig: () => ({ kmsKeyId: 'k' }),
  sealCredential: async (_c: unknown, _u: string, _p: string, v: unknown) => seal(v),
  openCredential: async (_c: unknown, _u: string, _p: string, b: Uint8Array) => JSON.parse(Buffer.from(b).toString()),
  // The unlocked first read in freshAccessToken; never inside the lock.
  readCredential: async () => {
    if (inTransaction) throw new Error('read on the global client inside the lock');
    return credential ? JSON.parse(credential.ciphertext.toString()) : null;
  },
}));

const refreshTokens = vi.fn();
vi.mock('./mcpOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mcpOAuth')>()),
  refreshTokens: (...args: unknown[]) => refreshTokens(...args),
}));

const { oauthAccessToken, updateConnectorDroppingOAuth, withOAuthLock } = await import('./mcpConnectorStore');
const { OAuthGrantError } = await import('./mcpOAuth');

const CLIENT = { clientId: 'cid', issuer: 'https://as.example', registeredRedirectUri: 'https://t/cb', tokenEndpointAuthMethod: 'none' };
const CONNECTOR = { id: 'c1', userId: 'u1', oauthMetadata: { tokenEndpoint: 'https://as.example/token' } };

beforeEach(() => {
  credential = null;
  updateFails = false;
  linkWrites.length = 0;
  lockSql.length = 0;
  vi.clearAllMocks();
});

describe('withOAuthLock', () => {
  it('writes the credential row and the link status on the lock\'s own transaction', async () => {
    await withOAuthLock('u1', 'c1', async io => {
      await io.write({ client: CLIENT as never });
      await io.linked();
      await io.needsLink('the server refused the refresh');
      await io.needsLink(null);
      await io.remove();
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(lockSql).toEqual([expect.stringContaining('pg_advisory_xact_lock')]);
    expect(tx.userCredential.upsert).toHaveBeenCalledTimes(1);
    expect(tx.userCredential.deleteMany).toHaveBeenCalledTimes(1);
    expect(linkWrites).toEqual([
      { where: { id: 'c1' }, data: { linkStatus: 'linked', linkError: null } },
      { where: { id: 'c1' }, data: { linkStatus: 'needs_link', linkError: 'the server refused the refresh' } },
      { where: { id: 'c1', linkStatus: 'linked' }, data: { linkStatus: 'needs_link', linkError: null } },
    ]);
  });
});

describe('oauthAccessToken', () => {
  it('marks a connector with no tokens needs_link inside the lock, on its transaction', async () => {
    credential = { ciphertext: seal({ oauth: { client: CLIENT } }) };
    await expect(oauthAccessToken(CONNECTOR)).rejects.toThrow('not linked');
    expect(linkWrites).toEqual([{ where: { id: 'c1', linkStatus: 'linked' }, data: { linkStatus: 'needs_link', linkError: null } }]);
  });

  it('drops the tokens and records the refusal in one transaction when a refresh fails', async () => {
    credential = { ciphertext: seal({ oauth: { client: CLIENT, tokens: { accessToken: 'old', refreshToken: 'rt1', expiresAt: Date.now() - 1 } } }) };
    refreshTokens.mockRejectedValueOnce(new OAuthGrantError('invalid_grant'));
    await expect(oauthAccessToken(CONNECTOR)).rejects.toThrow(/refused the refresh/);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(JSON.parse(credential!.ciphertext.toString())).toEqual({ oauth: { client: CLIENT } });
    expect(linkWrites).toEqual([{ where: { id: 'c1' }, data: { linkStatus: 'needs_link', linkError: expect.stringContaining('refused the refresh') } }]);
  });

  it('stores a rotated token without touching the link status', async () => {
    credential = { ciphertext: seal({ oauth: { client: CLIENT, tokens: { accessToken: 'old', refreshToken: 'rt1', expiresAt: Date.now() - 1 } } }) };
    refreshTokens.mockResolvedValueOnce({ accessToken: 'new', refreshToken: 'rt2', expiresAt: Date.now() + 3600_000 });
    expect(await oauthAccessToken(CONNECTOR)).toBe('new');
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(JSON.parse(credential!.ciphertext.toString()).oauth.tokens.refreshToken).toBe('rt2');
    expect(linkWrites).toEqual([]);
  });
});

describe('updateConnectorDroppingOAuth', () => {
  const TOKENS = { accessToken: 'old-server', expiresAt: null };

  it('removes the credentials and updates the row in one locked transaction, and returns what it removed', async () => {
    credential = { ciphertext: seal({ oauth: { client: CLIENT, tokens: TOKENS } }) };
    const { row, dropped } = await updateConnectorDroppingOAuth('u1', 'c1', { upstream: 'https://new.example/mcp' });
    expect(row).toMatchObject({ upstream: 'https://new.example/mcp' });
    expect(dropped).toEqual({ client: CLIENT, tokens: TOKENS });
    expect(credential).toBeNull();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(lockSql).toEqual([expect.stringContaining('pg_advisory_xact_lock')]);
  });

  it('leaves the credentials in place when the update fails', async () => {
    const stored = { ciphertext: seal({ oauth: { client: CLIENT, tokens: TOKENS } }) };
    credential = stored;
    updateFails = true;
    await expect(updateConnectorDroppingOAuth('u1', 'c1', { name: 'taken' })).rejects.toMatchObject({ code: 'P2002' });
    expect(credential).toBe(stored);
  });
});
