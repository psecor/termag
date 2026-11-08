/**
 * Working time under /api/cli/v1 (routes/cliWorktime.ts) through the real
 * cliApiRouter and its bearer check: a device sign-in reads its own days and
 * projects, ?days= is clamped to 1..90; a box's own credential gets 403; the
 * flag off is 404.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliWorktime } from './cliWorktime';

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

let calls: Array<[string, string, number]>;
let zones: unknown[];
let fail: boolean;

const worktime: CliWorktime = {
  days: async (user, days, tz) => {
    calls.push(['days', user.id, days]);
    zones.push(tz);
    if (fail) return { status: 500, body: { error: 'Failed to fetch worktime data' } };
    return { status: 200, body: { days: { '2026-10-29': { human: { totalMs: 3_600_000, sessions: 2 }, claude: { totalMs: 7_200_000, sessions: 3 } } } } };
  },
  projects: async (user, days, tz) => { calls.push(['projects', user.id, days]); zones.push(tz); return { status: 200, body: { days, rows: [] } }; },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now, worktime }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  calls = [];
  zones = [];
  fail = false;
});

const get = (path: string, token: string | null) => fetch(`${base}/api/cli/v1${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('/api/cli/v1/worktime', () => {
  it('reads the signed-in person\'s banked time per day and provider', async () => {
    const res = await get('/worktime?days=2', DEVICE.bob);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: { '2026-10-29': { human: { totalMs: 3_600_000, sessions: 2 }, claude: { totalMs: 7_200_000, sessions: 3 } } } });
    expect(calls).toEqual([['days', 'bob', 2]]);
  });

  it('reads the per-project rows', async () => {
    const res = await get('/worktime/projects?days=7', DEVICE.alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: 7, rows: [] });
    expect(calls).toEqual([['projects', 'alice', 7]]);
  });

  it("passes on the zone the desktop sends, so the days and today are the person's", async () => {
    await get('/worktime?days=2&tz=America%2FNew_York', DEVICE.bob);
    await get('/worktime/projects?days=7&tz=America%2FNew_York', DEVICE.bob);
    await get('/worktime?days=2', DEVICE.bob);
    expect(zones).toEqual(['America/New_York', 'America/New_York', undefined]);
  });

  it('clamps ?days= to 1..90, and reads 30 without one', async () => {
    for (const q of ['?days=0', '?days=-4', '?days=1000', '?days=x', '']) await get(`/worktime${q}`, DEVICE.alice);
    expect(calls.map(c => c[2])).toEqual([1, 1, 90, 30, 30]);
  });

  it('passes a failed read on as 500 with a code', async () => {
    fail = true;
    const res = await get('/worktime', DEVICE.alice);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch worktime data', code: 'failed' });
  });

  it('is a device sign-in\'s only: a box\'s own token gets 403', async () => {
    for (const path of ['/worktime', '/worktime/projects']) {
      const res = await get(path, BOX);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(calls).toEqual([]);
  });

  it('answers 401 without a sign-in', async () => {
    expect((await get('/worktime', null)).status).toBe(401);
  });

});
