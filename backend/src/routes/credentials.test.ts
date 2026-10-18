import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const USER = 'cmalice0000000001';
const ARN = 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

const state = vi.hoisted(() => ({
  configured: true,
  deleted: [] as Array<{ userId: string; providers: string[] }>,
  delivered: [] as string[],
  updated: [] as unknown[],
  orgAccess: {} as Record<string, unknown> | null,
  orgReads: 0,
  recheckError: null as Error | null,
  credentialsUser: {
    claudeGatewayEnabled: false,
    credentials: [] as Array<{ provider: string; label: string; updatedAt: Date }>,
  },
}));

vi.mock('../db', () => ({
  prisma: {
    user: {
      update: async (args: unknown) => { state.updated.push(args); },
      findUniqueOrThrow: async () => state.credentialsUser,
    },
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { id: string } }).user = { id: USER };
    next();
  },
}));
vi.mock('../services/claudeGateway', () => ({ getClaudeGatewayConfig: () => null }));
vi.mock('../services/credentialDelivery', () => ({
  deliverToUserBoxes: async (userId: string) => { state.delivered.push(userId); },
}));
vi.mock('../services/credentialStore', () => ({
  getCredentialStoreConfig: () => (state.configured ? { kmsKeyArn: ARN } : null),
  githubStoreDeps: () => ({}),
  deleteCredentials: async (userId: string, providers: string[]) => { state.deleted.push({ userId, providers }); },
  readGithubOrgAccess: async () => { state.orgReads += 1; return state.orgAccess; },
}));
vi.mock('../services/githubCredential', () => ({
  CredentialInputError: class CredentialInputError extends Error { readonly status = 400; },
  connectGithub: async () => ({ label: '@alice' }),
  recheckGithub: async () => { if (state.recheckError) throw state.recheckError; },
}));
vi.mock('../services/boxCreationGate', () => ({
  readBoxCreationFacts: async () => ({ required: false, flagOn: false, hasGithubCredential: false }),
  boxGateState: () => 'off',
}));

const { credentialsRouter } = await import('./credentials');
const { CredentialInputError } = await import('../services/githubCredential');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', credentialsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/credentials`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
  state.configured = true;
  state.deleted = [];
  state.delivered = [];
  state.updated = [];
  state.orgAccess = {};
  state.orgReads = 0;
  state.recheckError = null;
  state.credentialsUser = { claudeGatewayEnabled: false, credentials: [] };
});

describe('PUT /api/credentials/claude-gateway', () => {
  const put = (enabled: unknown) => fetch(`${base}/claude-gateway`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });

  it('stores the toggle and redelivers', async () => {
    const res = await put(false);
    expect(res.status).toBe(200);
    expect(state.updated).toEqual([{ where: { id: USER }, data: { claudeGatewayEnabled: false } }]);
    expect(state.delivered).toEqual([USER]);
  });

  it('needs a boolean', async () => {
    expect((await put('no')).status).toBe(400);
  });
});

describe('POST /api/credentials/github/recheck', () => {
  it('answers 503 when the store is not configured', async () => {
    state.configured = false;
    const res = await fetch(`${base}/github/recheck`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'The credential store is not configured on this orchestrator.' });
  });

  it('answers 204 when the probe is stored', async () => {
    const res = await fetch(`${base}/github/recheck`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns the input error', async () => {
    state.recheckError = new CredentialInputError('Connect GitHub in Settings.');
    const res = await fetch(`${base}/github/recheck`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Connect GitHub in Settings.' });
  });
});

describe('DELETE /api/credentials/github', () => {
  it('deletes the row and redelivers', async () => {
    const res = await fetch(`${base}/github`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(state.deleted).toEqual([{ userId: USER, providers: ['github'] }]);
    expect(state.delivered).toEqual([USER]);
  });

  it('deletes the row with the store unconfigured', async () => {
    state.configured = false;
    const res = await fetch(`${base}/github`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(state.deleted).toEqual([{ userId: USER, providers: ['github'] }]);
  });
});

describe('PUT /api/credentials/github', () => {
  it('answers 503 when the store is not configured', async () => {
    state.configured = false;
    const res = await fetch(`${base}/github`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns org access on GET, and {} when the reader has none', async () => {
    const updatedAt = new Date('2026-10-07T00:00:00.000Z');
    state.credentialsUser = {
      claudeGatewayEnabled: true,
      credentials: [{ provider: 'github', label: '@octocat', updatedAt }],
    };
    state.orgAccess = {
      'example-org': { status: 'sso-required', ssoUrl: 'https://github.com/orgs/example-org/sso?authorization_request=1' },
    };
    const res = await fetch(base);
    expect(await res.json()).toEqual({
      claudeGateway: { available: false, enabled: true },
      github: {
        available: true,
        connected: {
          label: '@octocat',
          updatedAt: updatedAt.toISOString(),
          orgs: state.orgAccess,
        },
        boxGate: 'off',
      },
    });

    state.orgAccess = null;
    const missing = await fetch(base);
    expect((await missing.json()).github.connected.orgs).toEqual({});

    state.configured = false;
    state.orgReads = 0;
    state.orgAccess = { 'example-org': { status: 'ok' } };
    const off = await fetch(base);
    expect((await off.json()).github.connected.orgs).toEqual({});
    expect(state.orgReads).toBe(0);
  });

  it('returns the label; the store wrote it with the value', async () => {
    const res = await fetch(`${base}/github`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x' }),
    });
    expect(await res.json()).toEqual({ label: '@alice' });
    expect(state.delivered).toEqual([USER]);
  });
});
