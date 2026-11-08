/**
 * The briefing under /api/cli/v1 (routes/cliBriefings.ts) through the real
 * cliApiRouter and its bearer check: a device sign-in reads, marks and runs
 * its own briefing, reads its earlier ones and sets its schedule; a box's own
 * credential gets 403; the flag off is 404; a bad mark or schedule is 400 and
 * never reaches the store.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { BriefingSchedule } from '../services/briefing/types';
import type { CliBriefings } from './cliBriefings';

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

interface Calls { latest: string[]; dismiss: Array<[string, unknown]>; restore: Array<[string, string]>; run: Array<[string, unknown]>; list: Array<[string, number]>; one: Array<[string, string]>; schedule: string[]; saveSchedule: Array<[string, BriefingSchedule]> }
let calls: Calls;
let runAnswer: { status: number; body: unknown };

const briefings: CliBriefings = {
  latest: async user => { calls.latest.push(user.id); return { latest: { id: `b-${user.id}` }, pending: null, dismissals: [] }; },
  dismiss: async (user, input) => {
    calls.dismiss.push([user.id, input]);
    return { key: input.key, kind: input.action, until: '2026-10-30T12:00:00.000Z', createdAt: now.toISOString() };
  },
  restore: async (user, key) => { calls.restore.push([user.id, key]); },
  run: async (user, tz) => { calls.run.push([user.id, tz]); return runAnswer; },
  list: async (user, limit) => { calls.list.push([user.id, limit]); return { briefings: [{ id: 'b2' }, { id: 'b1' }] }; },
  one: async (user, id) => { calls.one.push([user.id, id]); return id === 'b1' ? { id: 'b1', status: 'done' } : null; },
  schedule: async user => { calls.schedule.push(user.id); return OFF; },
  saveSchedule: async (user, schedule) => { calls.saveSchedule.push([user.id, schedule]); return schedule; },
};
const OFF: BriefingSchedule = { enabled: false, time: '08:00', timezone: null, days: [1, 2, 3, 4, 5], slackDm: true };

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now, briefings }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  calls = { latest: [], dismiss: [], restore: [], run: [], list: [], one: [], schedule: [], saveSchedule: [] };
  runAnswer = { status: 202, body: { id: 'b-new', status: 'running' } };
});

const call = (method: string, path: string, token: string | null, body?: unknown) => fetch(`${base}/api/cli/v1${path}`, {
  method,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

describe('/api/cli/v1/briefings', () => {
  it('reads the signed-in person\'s latest briefing', async () => {
    const res = await call('GET', '/briefings/latest', DEVICE.bob);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest: { id: 'b-bob' }, pending: null, dismissals: [] });
    expect(calls.latest).toEqual(['bob']);
  });

  it('marks an item Done or deferred, and brings it back', async () => {
    const done = await call('PUT', '/briefings/dismissals', DEVICE.alice, { key: 'open:p1:main', action: 'done' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ key: 'open:p1:main', kind: 'done' });
    const defer = await call('PUT', '/briefings/dismissals', DEVICE.alice, { key: 'pattern:waits', action: 'defer' });
    expect(defer.status).toBe(200);
    expect(calls.dismiss).toEqual([['alice', { key: 'open:p1:main', action: 'done' }], ['alice', { key: 'pattern:waits', action: 'defer' }]]);

    const back = await call('DELETE', `/briefings/dismissals?key=${encodeURIComponent('open:p1:main')}`, DEVICE.alice);
    expect(back.status).toBe(204);
    expect(calls.restore).toEqual([['alice', 'open:p1:main']]);
  });

  it('refuses a mark that names no briefing item, or no key to bring back', async () => {
    const bad = await call('PUT', '/briefings/dismissals', DEVICE.alice, { key: 'rm -rf', action: 'done' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_request' });
    const badAction = await call('PUT', '/briefings/dismissals', DEVICE.alice, { key: 'open:p1:main', action: 'forever' });
    expect(badAction.status).toBe(400);
    const noKey = await call('DELETE', '/briefings/dismissals', DEVICE.alice);
    expect(noKey.status).toBe(400);
    expect(calls.dismiss).toEqual([]);
    expect(calls.restore).toEqual([]);
  });

  it('runs one now with the client\'s timezone, passing on the runner\'s answer', async () => {
    const res = await call('POST', '/briefings/run', DEVICE.alice, { tz: 'America/New_York' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 'b-new', status: 'running' });
    expect(calls.run).toEqual([['alice', 'America/New_York']]);

    runAnswer = { status: 409, body: { error: 'A briefing is already being created', code: 'conflict' } };
    expect((await call('POST', '/briefings/run', DEVICE.alice, {})).status).toBe(409);
    expect(calls.run[1]).toEqual(['alice', undefined]);
  });

  it('lists the person\'s earlier briefings, newest first, 20 unless asked, at most 100', async () => {
    const res = await call('GET', '/briefings?limit=5', DEVICE.alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ briefings: [{ id: 'b2' }, { id: 'b1' }] });
    for (const q of ['', '?limit=-5', '?limit=1000', '?limit=x']) await call('GET', `/briefings${q}`, DEVICE.alice);
    expect(calls.list).toEqual([['alice', 5], ['alice', 20], ['alice', 1], ['alice', 100], ['alice', 20]]);
  });

  it('reads one earlier briefing, and 404s one that isn\'t the person\'s', async () => {
    const res = await call('GET', '/briefings/b1', DEVICE.bob);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'b1', status: 'done' });
    const gone = await call('GET', '/briefings/nope', DEVICE.bob);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'not_found' });
    expect(calls.one).toEqual([['bob', 'b1'], ['bob', 'nope']]);
    // `latest` is its own route, not an id.
    await call('GET', '/briefings/latest', DEVICE.bob);
    expect(calls.latest).toEqual(['bob']);
  });

  it('reads the person\'s schedule, not as a briefing id', async () => {
    const res = await call('GET', '/briefings/schedule', DEVICE.alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OFF);
    expect(calls.schedule).toEqual(['alice']);
    expect(calls.one).toEqual([]);
  });

  it('stores a checked schedule and answers with it', async () => {
    const on = { enabled: true, time: '07:30', timezone: 'America/New_York', days: [5, 1, 1, 3], slackDm: false };
    const res = await call('PUT', '/briefings/schedule', DEVICE.bob, on);
    expect(res.status).toBe(200);
    const stored = { ...on, days: [1, 3, 5] };
    expect(await res.json()).toEqual(stored);
    expect(calls.saveSchedule).toEqual([['bob', stored]]);
  });

  it('400s a schedule it can\'t store, and stores nothing', async () => {
    for (const body of [
      { ...OFF, enabled: true },
      { ...OFF, time: '25:00' },
      { ...OFF, timezone: 'Mars/Olympus' },
      { ...OFF, enabled: true, timezone: 'Europe/London', days: [] },
      { ...OFF, days: [7] },
      [],
    ]) {
      const res = await call('PUT', '/briefings/schedule', DEVICE.bob, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request', error: expect.any(String) });
    }
    expect(calls.saveSchedule).toEqual([]);
  });

  it('is a device sign-in\'s only: a box\'s own token gets 403 on every route', async () => {
    for (const [method, path, body] of [
      ['GET', '/briefings/latest', undefined],
      ['PUT', '/briefings/dismissals', { key: 'open:p1:main', action: 'done' }],
      ['DELETE', '/briefings/dismissals?key=open%3Ap1%3Amain', undefined],
      ['POST', '/briefings/run', {}],
      ['GET', '/briefings', undefined],
      ['GET', '/briefings/b1', undefined],
      ['GET', '/briefings/schedule', undefined],
      ['PUT', '/briefings/schedule', OFF],
    ] as const) {
      const res = await call(method, path, BOX, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(calls).toEqual({ latest: [], dismiss: [], restore: [], run: [], list: [], one: [], schedule: [], saveSchedule: [] });
  });

  it('answers 401 without a sign-in', async () => {
    expect((await call('GET', '/briefings/latest', null)).status).toBe(401);
  });

});
