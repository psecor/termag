import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliGithubRepos } from './cliGithubRepos';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-31T00:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (hash !== sha256Hex(DEVICE)) return null;
    return {
      id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
      createdAt: now, lastUsedAt: now, revokedAt: null,
    } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    return raw === BOX ? { user: alice, instanceId: 'b1' } : null;
  },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

const LIST = { groups: [{ owner: 'alice', kind: 'user', repos: [{ fullName: 'alice/app', defaultBranch: 'main' }] }], fetchedAt: '2026-10-31T00:00:00Z' };
const state = { store: true, asked: [] as boolean[] };
const deps: CliGithubRepos = {
  storeConfigured: () => state.store,
  repos: async (_user, refresh) => { state.asked.push(refresh); return LIST; },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, githubRepos: deps }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  state.store = true;
  state.asked = [];
});

const list = (query = '', token: string | null = DEVICE) =>
  fetch(`${base}/api/cli/v1/github/repos${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /github/repos', () => {
  it("answers the web route's list for a device sign-in, cached unless refresh=1", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(LIST);
    await list('?refresh=1');
    expect(state.asked).toEqual([false, true]);
  });

  it("refuses a box's own token, and says when the store is off", async () => {
    expect((await list('', BOX)).status).toBe(403);
    expect((await list('', null)).status).toBe(401);
    state.store = false;
    const off = await list();
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: 'store_off' });
    expect(state.asked).toEqual([]);
  });
});
