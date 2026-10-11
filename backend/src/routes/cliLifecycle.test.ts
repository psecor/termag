import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { RouteResult } from './routeResult';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { cliErrorResult } = await import('./cliLifecycle');
type CliLifecycle = import('./cliLifecycle').CliLifecycle;
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-05T00:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (hash !== sha256Hex(DEVICE)) return null;
    return {
      id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
      createdAt: now, lastUsedAt: now, revokedAt: null,
    } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) { return raw === BOX ? { user: alice, instanceId: 'i-devbox' } : null; },
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
const ok = (status = 200, body: unknown = { ok: true }): RouteResult => ({ status, body });

const lifecycle: CliLifecycle = {
  async createBox(user, name) { calls.push(['createBox', user.id, name]); return next; },
  async powerBox(user, id, action) { calls.push(['powerBox', user.id, id, action]); return next; },
  async removeBox(user, id, confirmed) { calls.push(['removeBox', user.id, id, confirmed]); return next; },
  async createProject(user, input) { calls.push(['createProject', user.id, input]); return next; },
  async renameProject(user, id, name) { calls.push(['renameProject', user.id, id, name]); return next; },
  async archiveProject(user, id) { calls.push(['archiveProject', user.id, id]); return next; },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, lifecycle }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  next = ok();
});

function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}/api/cli/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('lifecycle routes', () => {
  it('pass the caller and the request through to the shared handlers', async () => {
    next = ok(201, { box: { id: 'i-new' }, claimed: false });
    const res = await call('POST', '/boxes', DEVICE, { name: ' devbox ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ box: { id: 'i-new' }, claimed: false });

    next = ok(202, { box: { id: 'i-devbox' } });
    expect((await call('POST', '/boxes/i-devbox/stop', DEVICE)).status).toBe(202);
    expect((await call('POST', '/boxes/i-devbox/start', DEVICE)).status).toBe(202);
    next = ok();
    await call('DELETE', '/boxes/i-devbox', DEVICE, { confirmed: true });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fix', agent: 'claude' });
    await call('POST', '/projects/p1/rename', DEVICE, { name: 'fix2' });
    await call('POST', '/projects/p1/archive', DEVICE);

    expect(calls).toEqual([
      ['createBox', 'alice', 'devbox'],
      ['powerBox', 'alice', 'i-devbox', 'stop'],
      ['powerBox', 'alice', 'i-devbox', 'start'],
      ['removeBox', 'alice', 'i-devbox', true],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'fix', agent: 'claude' }],
      ['renameProject', 'alice', 'p1', 'fix2'],
      ['archiveProject', 'alice', 'p1'],
    ]);
  });

  it('passes the handler\'s status and body through', async () => {
    next = { status: 409, body: { error: 'Box has live projects', code: 'has_projects', projects: [] } };
    const res = await call('DELETE', '/boxes/i-devbox', DEVICE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'has_projects' });
    expect(calls).toEqual([['removeBox', 'alice', 'i-devbox', false]]);
  });

  it('refuse missing fields before calling a handler', async () => {
    for (const [method, path, body] of [
      ['POST', '/boxes', {}],
      ['POST', '/boxes', { name: '   ' }],
      ['POST', '/projects', { boxId: 'i-devbox', name: 'fix' }],
      ['POST', '/projects', { name: 'fix', agent: 'claude' }],
      ['POST', '/projects/p1/rename', { name: 7 }],
    ] as const) {
      const res = await call(method, path, DEVICE, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  it('need a bearer token', async () => {
    expect((await call('POST', '/boxes', null, { name: 'devbox' })).status).toBe(401);
    expect((await call('DELETE', '/boxes/i-devbox', 'tmag_unknown')).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('box credentials', () => {
  it('may create, start, stop, and manage projects', async () => {
    for (const [method, path, body] of [
      ['POST', '/boxes', { name: 'other' }],
      ['POST', '/boxes/i-other/start', undefined],
      ['POST', '/boxes/i-other/stop', undefined],
      ['POST', '/projects', { boxId: 'i-devbox', name: 'fix', agent: 'claude' }],
      ['POST', '/projects/p1/rename', { name: 'fix2' }],
      ['POST', '/projects/p1/archive', undefined],
    ] as const) {
      expect((await call(method, path, BOX, body)).status, `${method} ${path}`).toBe(200);
    }
    expect(calls).toHaveLength(6);
  });

  it('may not terminate a box, its own or another', async () => {
    for (const id of ['i-devbox', 'i-other']) {
      const res = await call('DELETE', `/boxes/${id}`, BOX, { confirmed: true });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', error: expect.stringContaining('termag login') });
    }
    expect(calls).toEqual([]);
  });
});

describe('cliErrorResult', () => {
  it('keeps the error and drops everything else, a token included', () => {
    expect(cliErrorResult({ status: 400, body: { error: 'name required', token: 'tmag_secret', instance: { id: 'x' } } }))
      .toEqual({ status: 400, body: { error: 'name required' } });
  });

  it('classifies a 409 with live projects, and other conflicts', () => {
    expect(cliErrorResult({
      status: 409,
      body: { error: 'Box has live projects', projects: [{ id: 'p1', name: 'fix', extra: 1 }], hint: 're-send' },
    })).toEqual({ status: 409, body: { error: 'Box has live projects', code: 'has_projects', projects: [{ id: 'p1', name: 'fix' }] } });
    expect(cliErrorResult({ status: 409, body: { error: 'A box named "x" already exists' } }).body)
      .toEqual({ error: 'A box named "x" already exists', code: 'conflict' });
  });

  it('keeps an explicit code and survives an empty body', () => {
    expect(cliErrorResult({ status: 409, body: { error: 'no', code: 'provisioning_unconfigured' } }).body)
      .toEqual({ error: 'no', code: 'provisioning_unconfigured' });
    expect(cliErrorResult({ status: 500, body: null })).toEqual({ status: 500, body: { error: 'Request failed' } });
  });
});
