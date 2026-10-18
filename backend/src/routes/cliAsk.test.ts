import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { RouteResult } from './routeResult';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { parseWait } = await import('./cliAsk');
type CliAsk = import('./cliAsk').CliAsk;
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const PERSONAL = 'tmag_personal';
const now = new Date('2026-10-09T00:00:00Z');
const MSG = 'cmsg0000000001';

const store: CliStore = {
  async findSessionByHash(hash) {
    if (hash !== sha256Hex(DEVICE)) return null;
    return {
      id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
      createdAt: now, lastUsedAt: now, revokedAt: null,
    } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    if (raw === BOX) return { user: alice, instanceId: 'i-devbox' };
    if (raw === PERSONAL) return { user: alice, instanceId: null };
    return null;
  },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let calls: Array<[string, ...unknown[]]>;
let next: RouteResult;

const ask: CliAsk = {
  async ask(user, senderInstanceId, req) { calls.push(['ask', user.id, senderInstanceId, req]); return next; },
  async getMessage(user, id, wait) { calls.push(['getMessage', user.id, id, wait]); return next; },
  async inbox(user) { calls.push(['inbox', user.id]); return next; },
  async cancel(user, id) { calls.push(['cancel', user.id, id]); return next; },
  async targets(user) { calls.push(['targets', user.id]); return next; },
  async recordBundle(boxId, id, data) { calls.push(['recordBundle', boxId, id, data.toString('utf8')]); return next; },
  async recordResult(boxId, id, result) { calls.push(['recordResult', boxId, id, result]); return next; },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, ask } as never));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  next = { status: 200, body: { ok: true } };
});

function call(method: string, path: string, token: string | null, body?: unknown, contentType = 'application/json') {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType;
  const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return fetch(`${base}/api/cli/v1${path}`, { method, headers, body: payload as BodyInit | undefined });
}

describe('POST /ask', () => {
  it('passes the parsed request and the sending box through', async () => {
    next = { status: 202, body: { thread: 't', message: 'm' } };
    const res = await call('POST', '/ask', BOX, { target: 'devbox/api@fix', prompt: 'why?' });
    expect(res.status).toBe(202);
    expect(calls).toEqual([['ask', 'alice', 'i-devbox', {
      ref: { box: 'devbox', project: 'api', workstream: 'fix' }, projectId: null, workstream: 'fix', prompt: 'why?', threadId: null, messageId: null,
    }]]);
  });

  it('records no sending box for a signed-in CLI', async () => {
    next = { status: 202, body: {} };
    await call('POST', '/ask', DEVICE, { projectId: 'p1', prompt: 'hi' });
    expect(calls[0][2]).toBeNull();
  });

  it('rejects a bad body before the service sees it', async () => {
    const res = await call('POST', '/ask', DEVICE, { target: 'nope', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  it('needs a credential', async () => {
    expect((await call('POST', '/ask', null, { projectId: 'p', prompt: 'x' })).status).toBe(401);
  });
});

describe('GET /ask/messages/:id, cancel and /ask/inbox', () => {
  it('clamps the wait and checks the id', async () => {
    await call('GET', `/ask/messages/${MSG}?wait=500`, DEVICE);
    expect(calls).toEqual([['getMessage', 'alice', MSG, 50]]);
    const res = await call('GET', '/ask/messages/NOT_AN_ID', DEVICE);
    expect(res.status).toBe(400);
  });

  it('cancels by id for any CLI credential', async () => {
    next = { status: 200, body: { status: 'canceled' } };
    const res = await call('POST', `/ask/messages/${MSG}/cancel`, BOX);
    expect(res.status).toBe(200);
    expect(calls).toEqual([['cancel', 'alice', MSG]]);
    expect((await call('POST', '/ask/messages/NOT_AN_ID/cancel', DEVICE)).status).toBe(400);
    expect((await call('POST', `/ask/messages/${MSG}/cancel`, null)).status).toBe(401);
  });

  it('lists the targets for any CLI credential, never without one', async () => {
    next = { status: 200, body: { agents: [] } };
    expect((await call('GET', '/ask/targets', DEVICE)).status).toBe(200);
    expect(calls).toEqual([['targets', 'alice']]);
    expect((await call('GET', '/ask/targets', null)).status).toBe(401);
  });

  it('lists the inbox', async () => {
    await call('GET', '/ask/inbox', BOX);
    expect(calls).toEqual([['inbox', 'alice']]);
  });
});

describe('box-only run routes', () => {
  it('take a bundle as octet-stream from a box token', async () => {
    next = { status: 204, body: undefined };
    const res = await call('PUT', `/ask/runs/${MSG}/bundle`, BOX, Buffer.from('BUNDLE'), 'application/octet-stream');
    expect(res.status).toBe(204);
    expect(calls).toEqual([['recordBundle', 'i-devbox', MSG, 'BUNDLE']]);
  });

  it('refuse a bundle sent as JSON', async () => {
    const res = await call('PUT', `/ask/runs/${MSG}/bundle`, BOX, { x: 1 });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuse a signed-in CLI and a token without a box', async () => {
    for (const token of [DEVICE, PERSONAL]) {
      const res = await call('POST', `/ask/runs/${MSG}/result`, token, { result: 'x' });
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('parse the result', async () => {
    next = { status: 202, body: { ok: true } };
    const res = await call('POST', `/ask/runs/${MSG}/result`, BOX, {
      result: 'done', sessionId: 'abc-123', numTurns: 3, baseSha: 'a'.repeat(40), repo: 'org/repo', bundle: true,
    });
    expect(res.status).toBe(202);
    expect(calls[0]).toEqual(['recordResult', 'i-devbox', MSG, {
      result: 'done', sessionId: 'abc-123', isError: false, numTurns: 3, exitReason: null,
      baseSha: 'a'.repeat(40), repo: 'org/repo', bundle: true,
    }]);
  });
});

describe('parseWait', () => {
  it('is 0 for junk and clamps at 50', () => {
    expect(parseWait(undefined)).toBe(0);
    expect(parseWait('abc')).toBe(0);
    expect(parseWait('-3')).toBe(0);
    expect(parseWait('12.7')).toBe(12);
    expect(parseWait('999')).toBe(50);
  });
});
