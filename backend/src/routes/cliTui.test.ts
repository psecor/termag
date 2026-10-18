import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { RouteResult } from './routeResult';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { tuiResult } = await import('./cliTui');
type CliTui = import('./cliTui').CliTui;
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');
const jwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-05T00:00:00Z');

const session: CliSessionRecord = {
  id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
  createdAt: now, lastUsedAt: now, revokedAt: null,
};

const store: CliStore = {
  async findSessionByHash(hash) { return hash === sha256Hex(DEVICE) ? session : null; },
  async findSessionById(id) { return id === session.id ? session : null; },
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

const tui: CliTui = {
  async lobby(user) { calls.push(['lobby', user.id]); return [{ id: 'p1', name: 'sample', role: 'owner' }]; },
  async sessions(user, boxId) { calls.push(['sessions', user.id, boxId]); return [{ projectId: 'p1', role: 'agent' }]; },
  async capture(user, id, role, query) { calls.push(['capture', user.id, id, role, query]); return next; },
  heartbeat(user, body) { calls.push(['heartbeat', user.id, body]); return { status: 200, body: { ok: true } }; },
  async prs(user) { calls.push(['prs', user.id]); return prsNext; },
  async handoff(user, id, body, boxId) { calls.push(['handoff', user.id, id, body, boxId]); return handoffNext; },
  async handoffState(user, id) { calls.push(['handoffState', user.id, id]); return { status: 200, body: { id, state: 'writing' } }; },
};
let handoffNext: RouteResult = { status: 202, body: { handoff: { id: 'h1', mode: 'clear', state: 'requested' } } };
let prsNext: RouteResult = { status: 200, body: { connected: false } };

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: Promise.resolve(jwt), now: () => now, tui }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  next = { status: 200, body: { session: 'alice-sample-agent', content: 'hello', styled: false } };
});

function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}/api/cli/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('TUI routes', () => {
  it('take the access token the TUI sends through the ALB', async () => {
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    const lobby = await call('GET', '/lobby', token);
    expect(lobby.status).toBe(200);
    expect(calls).toEqual([['lobby', 'alice']]);
  });

  it('serve the lobby and the session list to a device sign-in', async () => {
    const lobby = await call('GET', '/lobby', DEVICE);
    expect(lobby.status).toBe(200);
    expect(await lobby.json()).toEqual({ projects: [{ id: 'p1', name: 'sample', role: 'owner' }] });
    const sessions = await call('GET', '/sessions', DEVICE);
    expect(await sessions.json()).toEqual({ sessions: [{ projectId: 'p1', role: 'agent' }] });
    // A device sign-in is on no host, like a browser session: undefined, not the host's null.
    expect(calls).toEqual([['lobby', 'alice'], ['sessions', 'alice', undefined]]);
  });

  it('mark the calling box on the session list for a box credential', async () => {
    await call('GET', '/sessions', BOX);
    expect(calls).toEqual([['sessions', 'alice', 'i-devbox']]);
  });

  it('pass capture through to the shared handler', async () => {
    const cap = await call('GET', '/projects/p1/sessions/ctrl/capture?lines=40&workstream=feat&styled=1', DEVICE);
    expect(cap.status).toBe(200);
    expect(await cap.json()).toEqual(next.body);
    expect(calls).toEqual([['capture', 'alice', 'p1', 'ctrl', { lines: '40', workstream: 'feat', styled: '1' }]]);
  });

  it('post the remote-attach heartbeat through to the shared handler', async () => {
    const res = await call('POST', '/heartbeat', DEVICE, { project: 'sample', instanceId: 'i-devbox' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([['heartbeat', 'alice', { project: 'sample', instanceId: 'i-devbox' }]]);
  });

  it('serve the PR list to a device sign-in and its access token', async () => {
    prsNext = { status: 200, body: { connected: true, lanes: [] } };
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    for (const credential of [DEVICE, token]) {
      const res = await call('GET', '/prs', credential);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: true, lanes: [] });
    }
    expect(calls).toEqual([['prs', 'alice'], ['prs', 'alice']]);
  });

  it('refuse the PR list to a box credential', async () => {
    const res = await call('GET', '/prs', BOX);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'device_sign_in_required' });
    expect(calls).toEqual([]);
  });

  it('code a GitHub failure on the PR list', async () => {
    prsNext = { status: 504, body: { error: 'GitHub timed out' } };
    const res = await call('GET', '/prs', DEVICE);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'GitHub timed out', code: 'upstream_timeout' });
  });

  it('have no send-keys for any CLI credential', async () => {
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    for (const credential of [token, DEVICE, BOX]) {
      const res = await call('POST', '/projects/p1/sessions/agent/send-keys', credential, { keys: 'ls', workstream: 'main' });
      expect(res.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('give failures a CLI code and drop everything else in the body', async () => {
    next = { status: 429, body: { error: 'Rate limited (max 1 capture/sec per session)', detail: 'x' } };
    const res = await call('GET', '/projects/p1/sessions/agent/capture', DEVICE);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Rate limited (max 1 capture/sec per session)', code: 'rate_limited' });
  });

  it.each([
    ['GET', '/lobby'],
    ['GET', '/sessions'],
    ['GET', '/projects/p1/sessions/agent/capture'],
    ['POST', '/heartbeat'],
    ['GET', '/prs'],
  ])('%s %s needs a bearer token', async (method, path) => {
    for (const token of [null, 'tmag_unknown', 'tmcli_unknown']) {
      const res = await call(method, path, token);
      expect(res.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('ignore a session cookie', async () => {
    const res = await fetch(`${base}/api/cli/v1/lobby`, { headers: { cookie: 'connect.sid=s%3Aabc' } });
    expect(res.status).toBe(401);
  });
});

describe('tuiResult', () => {
  it('keeps successes and codes failures by status', () => {
    expect(tuiResult({ status: 200, body: { a: 1 } })).toEqual({ status: 200, body: { a: 1 } });
    expect(tuiResult({ status: 404, body: { error: 'Not found' } })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(tuiResult({ status: 503, body: {} })).toEqual({ status: 503, body: { error: 'Request failed', code: 'unavailable' } });
    expect(tuiResult({ status: 418, body: { error: 'teapot' } })).toEqual({ status: 418, body: { error: 'teapot', code: 'failed' } });
  });
});

describe('handoff routes', () => {
  beforeEach(() => { handoffNext = { status: 202, body: { handoff: { id: 'h1', mode: 'clear', state: 'requested' } } }; });

  it('hands the body to the shared handoff for a device sign-in or a box credential', async () => {
    for (const token of [DEVICE, BOX]) {
      const res = await call('POST', '/projects/p1/handoff', token, { mode: 'clear', workstream: 'main', surface: 'tui' });
      expect(res.status).toBe(202);
      expect((await res.json()).handoff.id).toBe('h1');
    }
    // A device sign-in reaches every project; a box credential names its box, which scopes it.
    expect(calls).toEqual([
      ['handoff', 'alice', 'p1', { mode: 'clear', workstream: 'main', surface: 'tui' }, undefined],
      ['handoff', 'alice', 'p1', { mode: 'clear', workstream: 'main', surface: 'tui' }, 'i-devbox'],
    ]);
  });

  it('keeps the handoff\'s own code and fields on a refusal, so the CLI can name them', async () => {
    handoffNext = { status: 409, body: { error: 'a handoff of this agent is already writing (h0)', code: 'handoff_open', handoffId: 'h0' } };
    const res = await call('POST', '/projects/p1/handoff', DEVICE, { mode: 'clear' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'a handoff of this agent is already writing (h0)', code: 'handoff_open', handoffId: 'h0' });
  });

  it('reads one handoff\'s state, and needs a credential for both', async () => {
    const res = await call('GET', '/handoffs/h1', DEVICE);
    expect(await res.json()).toEqual({ id: 'h1', state: 'writing' });
    expect((await call('POST', '/projects/p1/handoff', null, { mode: 'clear' })).status).toBe(401);
    expect((await call('GET', '/handoffs/h1', null)).status).toBe(401);
  });
});
