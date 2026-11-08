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
const USER_AGENT = 'tmag_user_agent';
const now = new Date('2026-10-05T00:00:00Z');

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
    return raw === USER_AGENT ? { user: alice, instanceId: null } : null;
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
const ok = (status = 200, body: unknown = { ok: true }): RouteResult => ({ status, body });

const parents: Record<string, string | null> = { 'i-child': 'i-devbox', 'i-other': null };
let sources: Record<string, { repoUrl: string } | RouteResult>;

const lifecycle: CliLifecycle = {
  async createBox(user, input, parent, createdFor) { calls.push(['createBox', user.id, input, parent, ...(createdFor ? [createdFor] : [])]); return next; },
  async boxParent(_user, id) { return parents[id]; },
  async projectRepoUrl(user, box, project) {
    calls.push(['projectRepoUrl', user.id, box, project]);
    return sources[`${box}/${project}`] ?? { status: 404, body: { error: 'no such project', code: 'not_found' } };
  },
  async powerBox(user, id, action) { calls.push(['powerBox', user.id, id, action]); return next; },
  async setBoxLifecycle(user, id, settings) { calls.push(['setBoxLifecycle', user.id, id, settings]); return next; },
  async keepBoxRunning(user, id) { calls.push(['keepBoxRunning', user.id, id]); return next; },
  async boxCosts(user) { calls.push(['boxCosts', user.id]); return next; },
  async removeBox(user, id, confirmed) { calls.push(['removeBox', user.id, id, confirmed]); return next; },
  async renameBox(user, id, name) { calls.push(['renameBox', user.id, id, name]); return next; },
  async resizeBox(user, id, input) { calls.push(['resizeBox', user.id, id, input]); return next; },
  async growBoxDisk(user, id, input) { calls.push(['growBoxDisk', user.id, id, input]); return next; },
  async resizeInfo(user, id) { calls.push(['resizeInfo', user.id, id]); return next; },
  async boxSizes(user, repo) { calls.push(['boxSizes', user.id, repo]); return next; },
  async createProject(user, input) { calls.push(['createProject', user.id, input]); return next; },
  async renameProject(user, id, name) { calls.push(['renameProject', user.id, id, name]); return next; },
  async archiveProject(user, id) { calls.push(['archiveProject', user.id, id]); return next; },
  async createWorkstream(user, id, input) { calls.push(['createWorkstream', user.id, id, input]); return next; },
  async removeWorkstream(user, id, name, opts) { calls.push(['removeWorkstream', user.id, id, name, opts]); return next; },
  async retryClone(user, id, opts) { calls.push(['retryClone', user.id, id, ...(opts && Object.keys(opts).length ? [opts] : [])]); return next; },
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
  sources = {};
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
    expect((await call('POST', '/boxes/i-devbox/hibernate', DEVICE)).status).toBe(202);
    next = ok();
    await call('PATCH', '/boxes/i-devbox/lifecycle', BOX, { idleHibernateHours: 1 });
    await call('POST', '/boxes/i-devbox/rename', DEVICE, { name: ' heavy ' });
    await call('DELETE', '/boxes/i-devbox', DEVICE, { confirmed: true });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fix', agent: 'claude' });
    await call('POST', '/projects/p1/rename', DEVICE, { name: 'fix2' });
    await call('POST', '/projects/p1/archive', DEVICE);
    await call('POST', '/projects/p1/clone/retry', BOX);

    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'devbox' }, null],
      ['powerBox', 'alice', 'i-devbox', 'stop'],
      ['powerBox', 'alice', 'i-devbox', 'start'],
      ['powerBox', 'alice', 'i-devbox', 'hibernate'],
      ['setBoxLifecycle', 'alice', 'i-devbox', { idleHibernateHours: 1 }],
      ['renameBox', 'alice', 'i-devbox', 'heavy'],
      ['removeBox', 'alice', 'i-devbox', true],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'fix', agent: 'claude' }],
      ['renameProject', 'alice', 'p1', 'fix2'],
      ['archiveProject', 'alice', 'p1'],
      ['retryClone', 'alice', 'p1'],
    ]);
  });

  it('passes the handler\'s status and body through', async () => {
    next = { status: 409, body: { error: 'Box has live projects', code: 'has_projects', projects: [] } };
    const res = await call('DELETE', '/boxes/i-devbox', DEVICE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'has_projects' });
    expect(calls).toEqual([['removeBox', 'alice', 'i-devbox', false]]);
  });

  it('forwards --minimal as the createBox option, defaulting to false', async () => {
    next = ok(201, { box: { id: 'i-lean' }, claimed: false });
    expect((await call('POST', '/boxes', DEVICE, { name: 'leanbox', flavor: 'minimal' })).status).toBe(201);
    expect((await call('POST', '/boxes', DEVICE, { name: 'fullbox' })).status).toBe(201);
    // Anything non-true reads as the default: a 1.x CLI asking a 2.x
    // orchestrator, or a fuzzed value.
    expect((await call('POST', '/boxes', DEVICE, { name: 'weird', flavor: 'yes' })).status).toBe(201);
    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'leanbox', size: undefined, flavor: 'minimal' }, null],
      ['createBox', 'alice', { name: 'fullbox', size: undefined }, null],
      ['createBox', 'alice', { name: 'weird', size: undefined, flavor: 'yes' }, null],
    ]);
  });

  it('forwards setupEnabled and useRepoSetup beside --minimal, each only when sent', async () => {
    next = ok(201, { box: { id: 'i-bare' }, claimed: false });
    expect((await call('POST', '/boxes', DEVICE, { name: 'bare', setupEnabled: false })).status).toBe(201);
    expect((await call('POST', '/boxes', DEVICE, { name: 'lean', flavor: 'minimal', setupEnabled: false })).status).toBe(201);
    expect((await call('POST', '/boxes', DEVICE, { name: 'plain', useRepoSetup: 'yes' })).status).toBe(201);
    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'bare', size: undefined, setupEnabled: false }, null],
      ['createBox', 'alice', { name: 'lean', size: undefined, flavor: 'minimal', setupEnabled: false }, null],
      ['createBox', 'alice', { name: 'plain', size: undefined }, null],
    ]);
  });

  it('forwards a Retry\'s setupEnabled when it is a boolean, and nothing otherwise (Bugbot, #983)', async () => {
    next = ok(202, { project: { id: 'p1' } });
    expect((await call('POST', '/projects/p1/clone/retry', DEVICE, { setupEnabled: true })).status).toBe(202);
    expect((await call('POST', '/projects/p1/clone/retry', DEVICE, { setupEnabled: 'yes' })).status).toBe(202);
    expect(calls).toEqual([
      ['retryClone', 'alice', 'p1', { setupEnabled: true }],
      ['retryClone', 'alice', 'p1'],
    ]);
  });

  it('refuse missing fields before calling a handler', async () => {
    for (const [method, path, body] of [
      ['POST', '/boxes', {}],
      ['POST', '/boxes', { name: '   ' }],
      ['POST', '/projects', { boxId: 'i-devbox', name: 'fix' }],
      ['POST', '/projects', { name: 'fix', agent: 'claude' }],
      ['POST', '/projects/p1/rename', { name: 7 }],
      ['POST', '/boxes/i-devbox/rename', {}],
    ] as const) {
      const res = await call(method, path, DEVICE, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  it('resolve a project\'s `from` to the repo URL, as the web form\'s "Start from" does', async () => {
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'g', agent: 'claude', from: 'termag' });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'r', agent: 'claude', from: 'https://github.com/o/r' });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'e', agent: 'claude', from: '  ' });
    expect(calls).toEqual([
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'g', agent: 'claude', repoUrl: 'https://github.com/psecor/termag.git' }],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'r', agent: 'claude', repoUrl: 'https://github.com/o/r' }],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'e', agent: 'claude' }],
    ]);
  });

  it('pass a project\'s `model` through for Claude Code, and refuse one that is not a tier or for another agent', async () => {
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'm', agent: 'claude', from: 'termag', model: 'opus' });
    expect(calls).toEqual([
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'm', agent: 'claude', repoUrl: 'https://github.com/psecor/termag.git', model: 'opus' }],
    ]);
    calls.length = 0;
    const bad = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'm', agent: 'claude', model: 'gpt-5' });
    expect(bad.status).toBe(400);
    const codex = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'm', agent: 'codex', model: 'opus' });
    expect(codex.status).toBe(400);
    expect(await codex.json()).toMatchObject({ error: 'model is a Claude model; codex is not Claude Code' });
    expect(calls).toEqual([]);
  });

  it('make a multi-repo project of a list of froms, and refuse a list longer than a project holds', async () => {
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'mr', agent: 'claude', from: ['termag', 'https://github.com/o/r'] });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'one', agent: 'claude', from: ['https://github.com/o/r'] });
    expect(calls).toEqual([
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'mr', agent: 'claude', repoUrls: ['https://github.com/psecor/termag.git', 'https://github.com/o/r'] }],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'one', agent: 'claude', repoUrl: 'https://github.com/o/r' }],
    ]);
    const many = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'x', agent: 'claude', from: Array(9).fill('termag') });
    expect(many.status).toBe(400);
  });

  it("make a project of an environment's repositories, and refuse one alongside from", async () => {
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fs', agent: 'claude', environment: 'full-stack' });
    expect(calls).toEqual([['createProject', 'alice', { boxId: 'i-devbox', name: 'fs', agent: 'claude', environment: 'full-stack' }]]);
    const both = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fs', agent: 'claude', environment: 'full-stack', from: ['webapp'] });
    expect(both.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("pass the environment's checkouts an ask was read with through to the create, which holds it to them", async () => {
    const pin = [{ repo: 'acme/api' }, { repo: 'acme/web', branch: 'next' }];
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fs', agent: 'claude', environment: 'full-stack', environmentRepos: pin, createdFor: 'ask' });
    expect(calls).toEqual([['createProject', 'alice', { boxId: 'i-devbox', name: 'fs', agent: 'claude', environment: 'full-stack', environmentRepos: pin, createdFor: 'ask' }]]);
  });

  it('refuse a `from` that is neither a template, a GitHub URL nor <box>/<project>', async () => {
    for (const from of ['termga', 'devbox/fix@ws', 'a/b/c']) {
      const res = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'x', agent: 'claude', from });
      expect(res.status, from).toBe(400);
      expect(await res.json()).toEqual({ error: expect.stringContaining('template (termag)'), code: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  it('start a project from another project\'s repository with `from: <box>/<project>`', async () => {
    sources['devbox/fix'] = { repoUrl: 'https://github.com/example-org/termag' };
    expect((await call('POST', '/projects', BOX, { boxId: 'i-child', name: 'fix', agent: 'claude', from: 'devbox/fix' })).status).toBe(200);
    expect(calls).toEqual([
      ['projectRepoUrl', 'alice', 'devbox', 'fix'],
      ['createProject', 'alice', { boxId: 'i-child', name: 'fix', agent: 'claude', repoUrl: 'https://github.com/example-org/termag' }],
    ]);
  });

  it('pass on why a <box>/<project> has no repository to start from', async () => {
    const res = await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'x', agent: 'claude', from: 'devbox/nope' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such project', code: 'not_found' });
    expect(calls).toEqual([['projectRepoUrl', 'alice', 'devbox', 'nope']]);
  });

  it('need a bearer token', async () => {
    expect((await call('POST', '/boxes', null, { name: 'devbox' })).status).toBe(401);
    expect((await call('DELETE', '/boxes/i-devbox', 'tmag_unknown')).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('workstream routes', () => {
  it('pass the name, base, agent and startFromOrigin through', async () => {
    next = ok(201, { workstream: { id: 'w1' }, warnings: [] });
    const res = await call('POST', '/projects/p1/workstreams', DEVICE, { name: ' t3-0a1b2c3d ', base: 'main', agent: 'claude-chat', startFromOrigin: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ workstream: { id: 'w1' }, warnings: [] });
    await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix' });
    await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix', agent: 'claude', startFromOrigin: false });
    expect(calls).toEqual([
      ['createWorkstream', 'alice', 'p1', { name: 't3-0a1b2c3d', base: 'main', agent: 'claude-chat', startFromOrigin: true }],
      ['createWorkstream', 'alice', 'p1', { name: 'fix' }],
      ['createWorkstream', 'alice', 'p1', { name: 'fix', agent: 'claude' }],
    ]);
  });

  it('pass New session\'s space through by name, or null for No space, and refuse anything else', async () => {
    next = ok(201, { workstream: { id: 'w1' }, warnings: [] });
    await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix', chatSpace: ' team ' });
    await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix', chatSpace: null });
    next = ok(201, { project: { id: 'p2' } });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fix', agent: 'claude-chat', chatSpace: 'team' });
    await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fix', agent: 'claude-chat', chatSpace: null });
    expect(calls).toEqual([
      ['createWorkstream', 'alice', 'p1', { name: 'fix', chatSpace: 'team' }],
      ['createWorkstream', 'alice', 'p1', { name: 'fix', chatSpace: null }],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'fix', agent: 'claude-chat', chatSpace: 'team' }],
      ['createProject', 'alice', { boxId: 'i-devbox', name: 'fix', agent: 'claude-chat', chatSpace: null }],
    ]);
    calls.length = 0;
    for (const chatSpace of [7, '', '  ', true]) {
      expect((await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix', chatSpace })).status).toBe(400);
      expect((await call('POST', '/projects', DEVICE, { boxId: 'i-devbox', name: 'fix', agent: 'claude', chatSpace })).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('refuse a missing name, an agent nobody offers, and fields of the wrong type', async () => {
    for (const body of [
      {},
      { name: '  ' },
      { name: 'fix', agent: 'codex' },
      { name: 'fix', agent: '' },
      { name: 'fix', base: 7 },
      { name: 'fix', startFromOrigin: 'yes' },
    ]) {
      const res = await call('POST', '/projects/p1/workstreams', DEVICE, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  it('remove one by name, forced and keeping its branch only when asked', async () => {
    await call('DELETE', '/projects/p1/workstreams/t3-0a1b2c3d', DEVICE);
    await call('DELETE', '/projects/p1/workstreams/fix', DEVICE, { force: true, keepBranch: true });
    await call('DELETE', '/projects/p1/workstreams/fix', DEVICE, { force: 'yes', keepBranch: 1 });
    expect(calls).toEqual([
      ['removeWorkstream', 'alice', 'p1', 't3-0a1b2c3d', { force: false, keepBranch: false }],
      ['removeWorkstream', 'alice', 'p1', 'fix', { force: true, keepBranch: true }],
      ['removeWorkstream', 'alice', 'p1', 'fix', { force: false, keepBranch: false }],
    ]);
  });

  it('pass the handler\'s refusal through', async () => {
    next = { status: 409, body: { error: 'A workstream with that name already exists', code: 'conflict' } };
    const res = await call('POST', '/projects/p1/workstreams', DEVICE, { name: 'fix' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A workstream with that name already exists', code: 'conflict' });
  });
});

describe('box create with a size and what its project starts from', () => {
  it('passes the size through, and resolves --from to the repository the box is for', async () => {
    sources = { 'devbox/web': { repoUrl: 'https://github.com/example-org/webapp' } };
    next = ok(201, { box: { id: 'i-new' }, claimed: false });
    await call('POST', '/boxes', DEVICE, { name: 'a', size: 'small' });
    await call('POST', '/boxes', DEVICE, { name: 'b', from: 'https://github.com/example-org/webapp' });
    await call('POST', '/boxes', DEVICE, { name: 'c', from: 'devbox/web', size: 'large' });
    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'a', size: 'small' }, null],
      ['createBox', 'alice', { name: 'b', repoUrls: ['https://github.com/example-org/webapp'] }, null],
      ['projectRepoUrl', 'alice', 'devbox', 'web'],
      ['createBox', 'alice', { name: 'c', size: 'large', repoUrls: ['https://github.com/example-org/webapp'] }, null],
    ]);
  });

  it('resolves a list of froms, in order, for a box made for a multi-repo project', async () => {
    sources = { 'devbox/web': { repoUrl: 'https://github.com/acme/web' } };
    next = ok(201, { box: { id: 'i-new' }, claimed: false });
    await call('POST', '/boxes', DEVICE, { name: 'mr', from: ['devbox/web', 'https://github.com/acme/api'] });
    expect(calls).toEqual([
      ['projectRepoUrl', 'alice', 'devbox', 'web'],
      ['createBox', 'alice', { name: 'mr', repoUrls: ['https://github.com/acme/web', 'https://github.com/acme/api'] }, null],
    ]);
    const bad = await call('POST', '/boxes', DEVICE, { name: 'mr', from: ['ok', 3] });
    expect(bad.status).toBe(400);
  });

  it('passes an environment on to the box, and refuses one alongside from', async () => {
    next = ok(201, { box: { id: 'i-new' }, claimed: false });
    await call('POST', '/boxes', DEVICE, { name: 'fs', environment: ' full-stack ', size: 'large' });
    expect(calls).toEqual([['createBox', 'alice', { name: 'fs', size: 'large', environment: 'full-stack' }, null]]);
    const both = await call('POST', '/boxes', DEVICE, { name: 'fs', environment: 'full-stack', from: 'webapp' });
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: expect.stringContaining('leave out from') });
    expect((await call('POST', '/boxes', DEVICE, { name: 'fs', environment: 3 })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('refuses a size that is not a string, and a from that names nothing, before creating anything', async () => {
    const bad = await call('POST', '/boxes', DEVICE, { name: 'a', size: 2 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_request' });
    const nowhere = await call('POST', '/boxes', DEVICE, { name: 'a', from: 'not a repo' });
    expect(nowhere.status).toBe(400);
    const gone = await call('POST', '/boxes', DEVICE, { name: 'a', from: 'devbox/missing' });
    expect(gone.status).toBe(404);
    expect(calls).toEqual([['projectRepoUrl', 'alice', 'devbox', 'missing']]);
  });
});

describe('box cost', () => {
  it("answers a person's own sign-in, never a box's credential", async () => {
    next = ok(200, { day: '2026-10-30', boxes: [{ id: 'i-devbox', todayUsd: 1.84 }] });
    const res = await call('GET', '/boxes/cost', DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boxes: [{ id: 'i-devbox', todayUsd: 1.84 }] });
    const refused = await call('GET', '/boxes/cost', BOX);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'box_credential' });
    expect(calls).toEqual([['boxCosts', 'alice']]);
  });
});

describe('box resize', () => {
  it('passes the size and force through for a signed-in person', async () => {
    next = ok(202, { box: { id: 'i-devbox' }, resize: { to: 'large', phase: 'stopping' } });
    const res = await call('POST', '/boxes/i-devbox/resize', DEVICE, { size: 'large', force: true });
    expect(res.status).toBe(202);
    expect(calls).toEqual([['resizeBox', 'alice', 'i-devbox', { size: 'large', force: true }]]);
  });

  it('needs a size', async () => {
    expect((await call('POST', '/boxes/i-devbox/resize', DEVICE, {})).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a box's own credential resizes only a box it created, never itself", async () => {
    next = ok(202, { box: { id: 'i-child' } });
    expect((await call('POST', '/boxes/i-child/resize', BOX, { size: 'medium' })).status).toBe(202);
    for (const id of ['i-devbox', 'i-other']) {
      const res = await call('POST', `/boxes/${id}/resize`, BOX, { size: 'medium' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(calls).toEqual([['resizeBox', 'alice', 'i-child', { size: 'medium', force: false }]]);
  });

  it('grows the disk with the GiB asked for, and only with a whole number', async () => {
    next = ok(202, { box: { id: 'i-devbox' }, grow: { fromGb: 120, toGb: 200, state: 'modifying', running: true } });
    const res = await call('POST', '/boxes/i-devbox/disk', DEVICE, { sizeGb: 200 });
    expect(res.status).toBe(202);
    expect((await call('POST', '/boxes/i-devbox/disk', DEVICE, { sizeGb: '200' })).status).toBe(400);
    expect(calls).toEqual([['growBoxDisk', 'alice', 'i-devbox', { sizeGb: 200 }]]);
  });

  it("a box's own credential grows only the disk of a box it created", async () => {
    next = ok(202, { box: { id: 'i-child' } });
    expect((await call('POST', '/boxes/i-child/disk', BOX, { sizeGb: 200 })).status).toBe(202);
    const res = await call('POST', '/boxes/i-devbox/disk', BOX, { sizeGb: 200 });
    expect(res.status).toBe(403);
    expect(calls).toEqual([['growBoxDisk', 'alice', 'i-child', { sizeGb: 200 }]]);
  });

  it('reads what Resize… shows for any credential of the owner', async () => {
    next = ok(200, { sizes: [{ size: 'large' }], blockers: [] });
    for (const credential of [DEVICE, BOX]) {
      const res = await call('GET', '/boxes/i-devbox/resize', credential);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sizes: [{ size: 'large' }], blockers: [] });
    }
    expect(calls).toEqual([['resizeInfo', 'alice', 'i-devbox'], ['resizeInfo', 'alice', 'i-devbox']]);
  });

  it('reads the New box sizes for each repository asked about', async () => {
    next = ok(200, { defaultSize: 'medium' });
    const res = await call('GET', '/boxes/sizes?repo=https://github.com/a/b&repo=https://github.com/a/c', DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultSize: 'medium' });
    expect(calls).toEqual([['boxSizes', 'alice', ['https://github.com/a/b', 'https://github.com/a/c']]]);
  });

  it("a busy box's blockers reach the CLI", () => {
    const blockers = [{ check: 'working', reason: 'an agent is working on it', forceable: true }];
    expect(cliErrorResult({ status: 409, body: { error: 'busy', code: 'box_busy', blockers, forceable: true, extra: 1 } }))
      .toEqual({ status: 409, body: { error: 'busy', code: 'box_busy', blockers, forceable: true } });
  });
});

describe('box create with a disk', () => {
  it('passes diskGiB through with the size and the repositories', async () => {
    next = ok(201, { box: { id: 'i-new' }, claimed: false });
    await call('POST', '/boxes', DEVICE, { name: 'a', diskGiB: 200 });
    await call('POST', '/boxes', DEVICE, { name: 'b', size: 'large', diskGiB: 300, from: 'https://github.com/acme/api' });
    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'a', diskGiB: 200 }, null],
      ['createBox', 'alice', { name: 'b', size: 'large', diskGiB: 300, repoUrls: ['https://github.com/acme/api'] }, null],
    ]);
  });

  it('refuses a diskGiB that is not a number before creating anything; the range is the create\'s to check', async () => {
    const bad = await call('POST', '/boxes', DEVICE, { name: 'a', diskGiB: '200' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_request' });
    expect(calls).toEqual([]);
  });
});

describe('box credentials', () => {
  it('may not keep a box running: that is a person saying they are using it', async () => {
    const res = await call('POST', '/boxes/i-devbox/keep-running', BOX);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'box_credential' });
    expect(calls).toEqual([]);
    expect((await call('POST', '/boxes/i-devbox/keep-running', DEVICE)).status).toBe(200);
    expect(calls).toEqual([['keepBoxRunning', 'alice', 'i-devbox']]);
  });

  it('may create, start, stop, rename, and manage projects and their workstreams', async () => {
    for (const [method, path, body] of [
      ['POST', '/boxes', { name: 'other' }],
      ['POST', '/boxes/i-other/rename', { name: 'renamed' }],
      ['POST', '/boxes/i-other/start', undefined],
      ['POST', '/boxes/i-other/stop', undefined],
      ['POST', '/projects', { boxId: 'i-devbox', name: 'fix', agent: 'claude' }],
      ['POST', '/projects/p1/rename', { name: 'fix2' }],
      ['POST', '/projects/p1/archive', undefined],
      ['POST', '/projects/p1/workstreams', { name: 'fix' }],
      ['DELETE', '/projects/p1/workstreams/fix', undefined],
    ] as const) {
      expect((await call(method, path, BOX, body)).status, `${method} ${path}`).toBe(200);
    }
    expect(calls).toHaveLength(9);
    expect(calls[0]).toEqual(['createBox', 'alice', { name: 'other' }, 'i-devbox']);
  });

  it('may terminate a box they created', async () => {
    expect((await call('DELETE', '/boxes/i-child', BOX, { confirmed: true })).status).toBe(200);
    expect(calls).toEqual([['removeBox', 'alice', 'i-child', true]]);
  });

  it('may not terminate any other box, their own included', async () => {
    for (const id of ['i-devbox', 'i-other', 'i-unknown']) {
      const res = await call('DELETE', `/boxes/${id}`, BOX, { confirmed: true });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', error: expect.stringContaining('termag login') });
    }
    expect(calls).toEqual([]);
  });

  it('may not terminate a parentless box with a token bound to no box', async () => {
    const res = await call('DELETE', '/boxes/i-other', USER_AGENT, { confirmed: true });
    expect(res.status).toBe(403);
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

  it('records that a box or project was made for asks, and refuses another purpose', async () => {
    next = { status: 201, body: {} };
    await call('POST', '/boxes', BOX, { name: 'askbox', createdFor: 'ask' });
    await call('POST', '/projects', BOX, { boxId: 'i-askbox', name: 'termag-3', agent: 'claude', createdFor: 'ask' });
    expect(calls).toEqual([
      ['createBox', 'alice', { name: 'askbox' }, 'i-devbox', 'ask'],
      ['createProject', 'alice', { boxId: 'i-askbox', name: 'termag-3', agent: 'claude', createdFor: 'ask' }],
    ]);
    expect((await call('POST', '/projects', BOX, { boxId: 'i-askbox', name: 'x', agent: 'claude', createdFor: 'fun' })).status).toBe(400);
  });
});
