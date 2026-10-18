import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { RepoCache } from '../services/githubRepoCache';
import type { RepoList } from '../services/githubRepos';

const USER = 'cmalice0000000001';
const ARN = 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; refresh: boolean }>,
  body: { status: 'ok', groups: [] } as RepoList,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { id: string } }).user = { id: USER };
    next();
  },
}));

const { githubReposRouter } = await import('./githubRepos');

const cache: RepoCache = {
  getRepos: async (userId, opts) => {
    state.calls.push({ userId, refresh: opts.refresh });
    return state.body;
  },
  forget: () => undefined,
};

let server: Server;
let base: string;
let previousKey: string | undefined;

beforeAll(async () => {
  const app = express();
  app.use('/api/github', githubReposRouter(cache));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github/repos`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
  previousKey = process.env.CREDENTIAL_STORE_KMS_KEY_ID;
  process.env.CREDENTIAL_STORE_KMS_KEY_ID = ARN;
  state.calls = [];
  state.body = {
    status: 'ok',
    groups: [{ owner: 'octocat', kind: 'user', status: 'ok', repos: [] }],
  };
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.CREDENTIAL_STORE_KMS_KEY_ID;
  else process.env.CREDENTIAL_STORE_KMS_KEY_ID = previousKey;
});

describe('GET /api/github/repos', () => {
  it('answers 503 when the store is not configured', async () => {
    delete process.env.CREDENTIAL_STORE_KMS_KEY_ID;
    const res = await fetch(base);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'The credential store is not configured on this orchestrator.' });
    expect(state.calls).toEqual([]);
  });

  it('returns the cached list and does not let the browser store it', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(state.body);
    expect(state.calls).toEqual([{ userId: USER, refresh: false }]);
  });

  it('passes refresh=1 through', async () => {
    const res = await fetch(`${base}?refresh=1`);
    expect(res.status).toBe(200);
    expect(state.calls).toEqual([{ userId: USER, refresh: true }]);
  });
});
