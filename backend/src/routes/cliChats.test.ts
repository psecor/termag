/**
 * The sessions under /api/cli/v1 (routes/cliChats.ts) through the real
 * cliApiRouter and its bearer check: a device sign-in lists and reads its
 * sessions; a box's own credential gets 403; the flag off is 404.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliChats } from './cliChats';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = 'tmcli_' + 'a'.repeat(64);
const BOX = 'tmag_alice_a1';
const now = new Date('2026-10-31T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (sha256Hex(DEVICE) !== hash) return null;
    return { id: 's-alice', userId: 'alice', user: cliUser('alice'), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
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

let enabled: boolean;
let asked: unknown[][];
const chats: CliChats = {
  enabled: async () => enabled,
  list: async (user, opts) => { asked.push(['list', user.id, opts]); return []; },
  history: async (user, projectId, workstream) => {
    asked.push(['history', user.id, projectId, workstream]);
    return { status: 409, body: { error: 'The box is starting', code: 'box-starting' } };
  },
  claim: async (user, projectId, body) => {
    asked.push(['claim', user.id, projectId, body]);
    return { status: 200, body: { holder: 't3', threadId: 't1', sessionId: null } };
  },
  asks: async (user, query) => {
    asked.push(['asks', user.id, { ...query }]);
    return { status: 200, body: { threads: [] } };
  },
  archive: async (user, projectId, body) => {
    asked.push(['archive', user.id, projectId, body]);
    return { status: 409, body: { code: 'box-stopped' } };
  },
  title: async (user, projectId, body) => {
    asked.push(['title', user.id, projectId, body]);
    return { status: 200, body: { title: 'T', titleAt: 'x', titleSource: 'person' } };
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now, chats }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { enabled = true; asked = []; });

const get = (path: string, token: string) => fetch(`${base}/api/cli/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('/api/cli/v1/chats', () => {
  it('lists the signed-in person\'s sessions, or their archived ones', async () => {
    const res = await get('/chats', DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chats: [] });
    await get('/chats?archived=1', DEVICE);
    expect(asked).toEqual([['list', 'alice', { archived: false }], ['list', 'alice', { archived: true }]]);
  });

  it('answers one session\'s history with the status it came with', async () => {
    const res = await get('/projects/p-app/chat?workstream=feature', DEVICE);
    expect(res.status).toBe(409);
    expect(asked).toEqual([['history', 'alice', 'p-app', 'feature']]);
  });

  it('hands a session to the desktop\'s thread with the box\'s answer', async () => {
    const res = await fetch(`${base}/api/cli/v1/projects/p-app/chat/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${DEVICE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workstream: 'main', threadId: 't1' }),
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([['claim', 'alice', 'p-app', { workstream: 'main', threadId: 't1' }]]);
    const boxClaim = await fetch(`${base}/api/cli/v1/projects/p-app/chat/claim`, { method: 'POST', headers: { authorization: `Bearer ${BOX}` } });
    expect(boxClaim.status).toBe(403);
  });

  it('lists a desktop thread\'s asks for the signed-in person', async () => {
    const res = await get('/chat/asks?claudeSession=5109190e-c0d2-4f72-9c15-3c4c57fb126c', DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [] });
    expect(asked).toEqual([['asks', 'alice', { claudeSession: '5109190e-c0d2-4f72-9c15-3c4c57fb126c' }]]);
    expect((await get('/chat/asks?threads=x', BOX)).status).toBe(403);
  });

  it("archives, reopens and renames with the box's answer, and lists all with archived=all", async () => {
    const send = (path: string, body: unknown) => fetch(`${base}/api/cli/v1${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${DEVICE}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await send('/projects/p-app/chat/archive', { archived: false })).status).toBe(409);
    expect((await send('/projects/p-app/chat/title', { title: 'T' })).status).toBe(200);
    await get('/chats?archived=all', DEVICE);
    expect(asked).toEqual([
      ['archive', 'alice', 'p-app', { archived: false }],
      ['title', 'alice', 'p-app', { title: 'T' }],
      ['list', 'alice', { archived: 'all' }],
    ]);
  });

  it('refuses a box\'s own token, and hides behind the flag', async () => {
    expect((await get('/chats', BOX)).status).toBe(403);
    expect((await get('/projects/p-app/chat', BOX)).status).toBe(403);
    enabled = false;
    expect((await get('/chats', DEVICE)).status).toBe(404);
    expect((await get('/projects/p-app/chat', DEVICE)).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
