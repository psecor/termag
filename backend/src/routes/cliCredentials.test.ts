import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliCredentials, CliCredentialStatus } from '../services/cliCredentials';
import type { SshKeyInfo } from '../services/sshKeyRegistration';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

const { cliApiRouter } = await import('./cliApi');
const { cliCredentialsRouter } = await import('./cliCredentials');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { CredentialStoreUnavailableError } = await import('../services/cliCredentials');
const { CredentialInputError } = await import('../services/githubCredential');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');

const jwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);

const NOW = Date.parse('2026-10-05T00:00:00Z');
const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'a'.repeat(64);
const BOX = 'tmag_' + 'b'.repeat(40);
const GH = 'gho_' + 'x'.repeat(36);

function session(): CliSessionRecord {
  const at = new Date(NOW - 1000);
  return {
    id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_aaaa',
    createdAt: at, lastUsedAt: at, revokedAt: null,
  };
}

const store = {
  findSessionByHash: async (hash: string) => (hash === sha256Hex(DEVICE) ? session() : null),
  findSessionById: async (id: string) => (id === 's1' ? session() : null),
  touchSession: async () => {},
  validateAgentToken: async (raw: string) => (raw === BOX ? { user: alice, instanceId: 'i1' } : null),
} as unknown as CliStore;

const key = (fingerprint: string): SshKeyInfo => ({
  id: 'k1', type: 'ssh-ed25519', bits: 256, comment: 'zane@mbp', fingerprint, createdAt: new Date(NOW),
});

class FakeCredentials implements CliCredentials {
  keys: SshKeyInfo[] = [];
  github: CliCredentialStatus['github'] = { available: true, connected: null };
  storedTokens: string[] = [];
  async status() { return { github: this.github, claudeGateway: { available: true, enabled: true } }; }
  async listSshKeys() { return this.keys; }
  async connectGithub(_userId: string, token: unknown) {
    if (!this.github.available) throw new CredentialStoreUnavailableError();
    if (token !== GH) throw new CredentialInputError('That is not a GitHub token (paste the output of `gh auth token`).');
    this.storedTokens.push(token);
    return { label: '@zane' };
  }
}

let creds: FakeCredentials;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // As index.ts mounts them: the credential routes first, then the rest of the CLI API.
  app.use('/api/cli/v1', (req, res, next) =>
    cliCredentialsRouter({ store, jwt: Promise.resolve(jwt), now: () => new Date(NOW), credentials: creds })(req, res, next));
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: Promise.resolve(jwt), now: () => new Date(NOW) }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cli/v1`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => { creds = new FakeCredentials(); });

function call(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(`${base}${path}`, { ...init, headers });
}

describe('GET /credentials', () => {
  it('reports GitHub, Claude and the SSH keys, for a device or a box', async () => {
    creds.keys = [key('SHA256:abc')];
    creds.github = { available: true, connected: { label: '@zane', updatedAt: new Date(NOW), orgs: {} } };
    for (const token of [DEVICE, BOX]) {
      const res = await call('/credentials', token);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        github: { available: true, connected: { label: '@zane', updatedAt: new Date(NOW).toISOString(), orgs: {} } },
        claudeGateway: { available: true, enabled: true },
        sshKeys: [{ ...key('SHA256:abc'), createdAt: new Date(NOW).toISOString() }],
      });
    }
  });

  it('leaves every other path to the CLI API', async () => {
    const who = await call('/whoami', DEVICE);
    expect(who.status).toBe(200);
    const missing = await call('/nope', DEVICE);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
  });

  it('takes the access token the CLI sends through the ALB', async () => {
    const access = (await jwt.issue('alice', 's1', NOW)).token;
    expect((await call('/credentials', access)).status).toBe(200);
    expect((await call('/ssh-keys', access)).status).toBe(200);
  });

  it('needs a bearer token', async () => {
    expect((await call('/credentials', null)).status).toBe(401);
    expect((await call('/ssh-keys', 'tmag_unknown')).status).toBe(401);
  });
});

describe('POST /ssh-keys', () => {
  const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc zane@mbp';

  it('is not on the CLI API for any CLI credential: adding a key is web-only', async () => {
    const access = (await jwt.issue('alice', 's1', NOW)).token;
    for (const token of [DEVICE, access, BOX]) {
      const res = await call('/ssh-keys', token, { method: 'POST', body: JSON.stringify({ publicKey: line }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
    expect(creds.keys).toHaveLength(0);
  });
});

describe('PUT /github', () => {
  it('stores the token and answers with the label only', async () => {
    const res = await call('/github', DEVICE, { method: 'PUT', body: JSON.stringify({ token: GH }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ label: '@zane' });
    expect(text).not.toContain(GH);
    expect(creds.storedTokens).toEqual([GH]);
  });

  it('maps a bad token to 400 and a missing store to 503', async () => {
    const bad = await call('/github', DEVICE, { method: 'PUT', body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_token' });
    creds.github = { available: false, connected: null };
    const off = await call('/github', DEVICE, { method: 'PUT', body: JSON.stringify({ token: GH }) });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: 'credential_store_unavailable' });
  });

  it('refuses a box credential', async () => {
    const res = await call('/github', BOX, { method: 'PUT', body: JSON.stringify({ token: GH }) });
    expect(res.status).toBe(403);
    expect(creds.storedTokens).toEqual([]);
  });
});
