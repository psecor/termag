/**
 * Pane text search under /api/cli/v1 (routes/cliSessionSearch.ts) through the real cliApiRouter
 * and its bearer check: a device sign-in searches its own sessions with the query as sent and a
 * rate-limit key of its own; the search's refusals pass through with a code; a box's own
 * credential gets 403; the flag off is 404.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliSessionSearch } from './cliSessionSearch';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = { alice: 'tmcli_' + 'a'.repeat(64), bob: 'tmcli_' + 'b'.repeat(64) };
const BOX = 'tmag_alice_a1';
const now = new Date('2026-10-29T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    const who = (Object.keys(DEVICE) as Array<keyof typeof DEVICE>).find(u => sha256Hex(DEVICE[u]) === hash);
    if (!who) return null;
    return { id: `s-${who}`, userId: who, user: cliUser(who), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    return raw === BOX ? { user: cliUser('alice'), instanceId: 'i-a1' } : null;
  },
  createSession: async () => { throw new Error('unused'); },
  findSessionById: async () => null,
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let calls: Array<[string, Record<string, unknown>, string]>;
let enabledFor: Set<string>;
let answer: { status: number; body: unknown };

const sessionSearch: CliSessionSearch = {
  enabled: async user => enabledFor.has(user.id),
  search: async (user, query, callerId) => {
    calls.push([user.id, { ...query }, callerId]);
    return answer;
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now, sessionSearch }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  calls = [];
  enabledFor = new Set(['alice', 'bob']);
  answer = { status: 200, body: { query: 'npm test', hits: [], panes: 3 } };
});

const get = (path: string, token: string | null) => fetch(`${base}/api/cli/v1${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('/api/cli/v1/sessions/search', () => {
  it("searches the signed-in person's panes with the query as sent, on their device's own budget", async () => {
    const res = await get('/sessions/search?q=npm%20test&lines=200&roles=agent', DEVICE.bob);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'npm test', hits: [], panes: 3 });
    expect(calls).toEqual([['bob', { q: 'npm test', lines: '200', roles: 'agent' }, 'cli:s-bob']]);
  });

  it("passes the search's refusals on with a code: a short query, the rate limit", async () => {
    answer = { status: 400, body: { error: 'q must be at least 2 characters' } };
    const short = await get('/sessions/search?q=a', DEVICE.alice);
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'q must be at least 2 characters', code: 'failed' });
    answer = { status: 429, body: { error: 'Rate limited (one pane search per 2s per caller)' } };
    const limited = await get('/sessions/search?q=npm', DEVICE.alice);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
  });

  it("is a device sign-in's only: a box's own token gets 403", async () => {
    const res = await get('/sessions/search?q=npm', BOX);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden' });
    expect(calls).toEqual([]);
  });

  it('answers 404 with desktop-app-enabled off for the person, and 401 without a sign-in', async () => {
    enabledFor.delete('bob');
    const off = await get('/sessions/search?q=npm', DEVICE.bob);
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ code: 'not_found' });
    expect((await get('/sessions/search?q=npm', null)).status).toBe(401);
    expect(calls).toEqual([]);
  });
});
