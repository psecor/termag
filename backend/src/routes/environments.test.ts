import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type {
  EnvironmentEventRecord, EnvironmentFields, EnvironmentRecord, EnvironmentStore,
} from '../services/environments';

// Environments are personal or shared: a personal one
// is its owner's alone, a shared one anyone signed in reads, uses, edits and
// deletes, and every change leaves an event with who, when, and the stored
// fields before and after. An environment is an inline definition or a
// pointer (repo : branch : path). The store is in memory here, with the same
// contract as the Prisma one; services/environmentVisibility.test.ts has
// every personal and shared rule.

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'] };
    next();
  },
}));

const { environmentsRouter } = await import('./environments');
const { mountCliEnvironmentRoutes } = await import('./cliEnvironments');
const { fieldsOf, sameFields } = await import('../services/environments');

// These fixtures use acme/… repositories: count acme as one of our orgs here (environments.ts reposOutsideOrgs).
beforeAll(() => { vi.stubEnv('GITHUB_REPO_ORGS', 'example-org,example-team,acme,a,b'); });
afterAll(() => { vi.unstubAllEnvs(); });


function memoryStore(): EnvironmentStore & { rows: EnvironmentRecord[]; log: EnvironmentEventRecord[] } {
  const rows: EnvironmentRecord[] = [];
  const log: EnvironmentEventRecord[] = [];
  let n = 0;
  let clock = Date.parse('2026-10-29T10:00:00Z');
  const tick = () => new Date((clock += 1000));
  const snap = (r: EnvironmentRecord | null) => r && { ...fieldsOf(r), visibility: r.visibility, ownerUserId: r.ownerUserId };
  const event = (environmentId: string, actorUserId: string, action: EnvironmentEventRecord['action'], before: EnvironmentRecord | null, after: EnvironmentRecord | null) => {
    log.push({ id: `ev${log.length + 1}`, at: tick(), environmentId, actorUserId, action, before: snap(before), after: snap(after) });
  };
  return {
    rows, log,
    async list() { return [...rows].sort((a, b) => a.name.localeCompare(b.name)); },
    async get(id) { return rows.find(r => r.id === id) ?? null; },
    async byName(name) { return rows.find(r => r.name === name.trim().toLowerCase()) ?? null; },
    async create(actor, fields, visibility = 'personal') {
      if (rows.some(r => r.name === fields.name)) return { ok: false, reason: 'name_taken' };
      const at = tick();
      const row: EnvironmentRecord = { ...fieldsOf(fields), id: `env${++n}`, createdAt: at, updatedAt: at, createdByUserId: actor, updatedByUserId: actor, visibility, ownerUserId: actor };
      rows.push(row);
      event(row.id, actor, 'environment.create', null, row);
      return { ok: true, environment: row, changed: true };
    },
    async update(actor, id, fields, since) {
      const row = rows.find(r => r.id === id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (since && row.updatedAt.getTime() !== since.getTime()) return { ok: false, reason: 'changed' };
      if (sameFields(row, fields)) return { ok: true, environment: row, changed: false };
      if (rows.some(r => r.id !== id && r.name === fields.name)) return { ok: false, reason: 'name_taken' };
      const before = { ...row };
      const r = row as Record<string, unknown>;
      delete r.definition; delete r.file;
      Object.assign(row, fieldsOf(fields), { updatedAt: tick(), updatedByUserId: actor });
      event(id, actor, 'environment.update', before, row);
      return { ok: true, environment: row, changed: true };
    },
    async setVisibility(actor, id, visibility, since) {
      const row = rows.find(r => r.id === id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (since && row.updatedAt.getTime() !== since.getTime()) return { ok: false, reason: 'changed' };
      if (row.visibility === visibility) return { ok: true, environment: row, changed: false };
      const before = { ...row };
      Object.assign(row, { visibility, updatedAt: tick(), updatedByUserId: actor });
      event(id, actor, 'environment.visibility', before, row);
      return { ok: true, environment: row, changed: true };
    },
    async remove(actor, id, since) {
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) return { ok: false, reason: 'not_found' };
      if (since && rows[i].updatedAt.getTime() !== since.getTime()) return { ok: false, reason: 'changed' };
      const [row] = rows.splice(i, 1);
      event(id, actor, 'environment.delete', row, null);
      return { ok: true, environment: row, changed: true };
    },
    async events(id) { return log.filter(e => !id || e.environmentId === id).reverse(); },
  };
}

// GitHub as the shared rules read it: every repository's default branch is main, and its file lists one repository.
const GITHUB = {
  defaultBranch: async () => ({ branch: 'main' }),
  text: async (_u: string, repo: string) => ({ text: JSON.stringify({ repos: [{ repo }] }) }),
};

const PEOPLE = [
  { id: 'u1', email: 'pat@example.com', name: 'Pat' },
  { id: 'u2', email: 'sam@example.com', name: 'Sam' },
];

let server: Server;
let base: string;
let cliBase: string;
let store: ReturnType<typeof memoryStore>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/environments', (req, res, next) => environmentsRouter({
    store, people: async ids => PEOPLE.filter(p => ids.includes(p.id)), github: GITHUB,
    resolve: async (_user, env) => (env.kind === 'inline'
      ? { repos: (env.definition.repos as Array<{ repo: string }>), sizes: { size: 'large' }, warnings: [] }
      : { repos: [{ repo: env.file.repo }], sizes: null, warnings: ['not read in this test'] }),
  })(req, res, next));
  // The CLI's /api/cli/v1 routes over the same store: x-test-user is the person, x-test-box a box's own credential.
  const cli = express.Router();
  const bearer: express.RequestHandler = (req, res, next) => {
    const user = req.headers['x-test-user'];
    if (!user) { res.status(401).json({ error: 'Missing bearer token', code: 'auth_required' }); return; }
    const box = req.headers['x-test-box'];
    res.locals.cliAuth = { user: { id: user }, credential: box ? { kind: 'box', boxId: box } : { kind: 'device' } };
    next();
  };
  app.use('/api/cli/v1', (req, res, next) => {
    const r = express.Router();
    mountCliEnvironmentRoutes(r, { store, people: async ids => PEOPLE.filter(p => ids.includes(p.id)), github: GITHUB }, bearer);
    r(req, res, next);
  });
  void cli;
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/environments`;
  cliBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cli/v1/environments`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { store = memoryStore(); });

async function call(method: string, path: string, user: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const FULL_STACK = {
  name: 'full-stack',
  kind: 'inline',
  definition: {
    $schema: 'https://example.com/environment.schema.json',
    resources: { vcpu: 4, memoryGiB: 32 },
    repos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/frontend-app', path: 'frontend', branch: 'main' }],
  },
};
const POINTER = { name: 'from-file', kind: 'pointer', file: { repo: 'https://github.com/Example-Org/Webapp', branch: 'main', path: '.termag/full-stack/environment.json' } };
// A pointer the shared rules allow, shared at creation.
const SHARED = { ...POINTER, name: 'shared-stack', visibility: 'shared' };

describe('environments routes', () => {
  it('needs a signed-in user', async () => {
    expect((await call('GET', '/', null)).status).toBe(401);
    expect((await call('POST', '/', null, FULL_STACK)).status).toBe(401);
    expect((await call('GET', '/events', null)).status).toBe(401);
  });

  it('creates an inline environment, storing its definition as sent, and records who created it', async () => {
    const r = await call('POST', '/', 'u1', FULL_STACK);
    expect(r.status).toBe(201);
    expect(r.body.environment).toMatchObject({ name: 'full-stack', kind: 'inline', definition: FULL_STACK.definition, createdBy: { email: 'pat@example.com' } });
    expect(r.body.environment).not.toHaveProperty('repos');
    expect(store.log).toEqual([expect.objectContaining({ actorUserId: 'u1', action: 'environment.create', before: null, after: expect.objectContaining({ name: 'full-stack', kind: 'inline' }) })]);
  });

  it('creates a pointer: repo : branch : path, the repository as owner/name, an empty branch the default, the path defaulted', async () => {
    const r = await call('POST', '/', 'u1', POINTER);
    expect(r.body.environment).toMatchObject({ kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } });
    const d = await call('POST', '/', 'u1', { name: 'plain', kind: 'pointer', file: { repo: 'acme/app', branch: '' } });
    expect(d.body.environment.file).toEqual({ repo: 'acme/app', branch: null, path: '.termag/environment.json' });
  });

  it('lets its owner list, read, edit and delete a personal environment, and switch its form; nobody else sees it', async () => {
    const created = (await call('POST', '/', 'u1', FULL_STACK)).body.environment;
    expect(created).toMatchObject({ visibility: 'personal', owner: PEOPLE[0] });
    expect((await call('GET', '/', 'u1')).body.environments.map((e: { name: string }) => e.name)).toEqual(['full-stack']);
    expect((await call('GET', '/', 'u2')).body.environments).toEqual([]);
    expect((await call('GET', `/${created.id}`, 'u2')).status).toBe(404);
    const edited = await call('PUT', `/${created.id}`, 'u1', { ...POINTER, name: 'full-stack' });
    expect(edited.status).toBe(200);
    expect(edited.body.environment).toMatchObject({ kind: 'pointer', updatedBy: PEOPLE[0], createdBy: PEOPLE[0] });
    expect(edited.body.environment).not.toHaveProperty('definition');
    expect((await call('DELETE', `/${created.id}`, 'u2')).status).toBe(404);
    expect((await call('DELETE', `/${created.id}`, 'u1')).status).toBe(200);
    expect((await call('GET', '/', 'u1')).body.environments).toEqual([]);
  });

  it('lets anyone list, read, edit and delete a shared environment, and only its owner make it personal', async () => {
    const created = (await call('POST', '/', 'u1', SHARED)).body.environment;
    expect(created).toMatchObject({ visibility: 'shared', owner: PEOPLE[0] });
    expect((await call('GET', '/', 'u2')).body.environments.map((e: { name: string }) => e.name)).toEqual(['shared-stack']);
    const edited = await call('PUT', `/${created.id}`, 'u2', { ...POINTER, name: 'shared-stack', file: { ...POINTER.file, path: 'other.json' } });
    expect(edited.body.environment).toMatchObject({ visibility: 'shared', updatedBy: PEOPLE[1], createdBy: PEOPLE[0], owner: PEOPLE[0] });
    expect(await call('POST', `/${created.id}/visibility`, 'u2', { visibility: 'personal' })).toMatchObject({ status: 403, body: { code: 'environment_not_owner' } });
    expect(await call('PUT', `/${created.id}`, 'u2', { ...FULL_STACK, name: 'shared-stack' })).toMatchObject({ status: 400, body: { code: 'environment_not_shareable' } });
    const personal = await call('POST', `/${created.id}/visibility`, 'u1', { visibility: 'personal' });
    expect(personal.body.environment.visibility).toBe('personal');
    expect((await call('GET', `/${created.id}`, 'u2')).status).toBe(404);
    expect((await call('POST', `/${created.id}/visibility`, 'u1', { visibility: 'shared' })).body.environment.visibility).toBe('shared');
    expect((await call('DELETE', `/${created.id}`, 'u2')).status).toBe(200);
    expect(store.log.map(e => e.action)).toEqual(['environment.create', 'environment.update', 'environment.visibility', 'environment.visibility', 'environment.delete']);
  });

  it('keeps an audit log of every change across environments, newest first, with who and the stored fields before and after', async () => {
    const a = (await call('POST', '/', 'u1', SHARED)).body.environment;
    await call('POST', '/', 'u2', { ...POINTER, visibility: 'shared' });
    await call('POST', '/', 'u2', { ...FULL_STACK, name: 'sams-own' });
    await call('PUT', `/${a.id}`, 'u2', { ...SHARED, file: { ...POINTER.file, path: 'moved.json' } });
    const all = await call('GET', '/events', 'u1');
    expect(all.body.events.map((e: { action: string; environmentName: string }) => [e.action, e.environmentName])).toEqual([
      ['environment.update', 'shared-stack'], ['environment.create', 'from-file'], ['environment.create', 'shared-stack'],
    ]);
    const [update] = all.body.events;
    expect(update.actor).toEqual(PEOPLE[1]);
    expect(update.before.file.path).toBe('.termag/full-stack/environment.json');
    expect(update.after.file.path).toBe('moved.json');
    expect((await call('GET', '/events', 'u2')).body.events).toHaveLength(4);
    const one = await call('GET', `/events?environment=${a.id}`, 'u1');
    expect(one.body.events.map((e: { action: string }) => e.action)).toEqual(['environment.update', 'environment.create']);
    expect((await call('GET', `/${a.id}`, 'u1')).body).not.toHaveProperty('events');
  });

  it('keeps the history of a deleted environment', async () => {
    const created = (await call('POST', '/', 'u1', SHARED)).body.environment;
    await call('DELETE', `/${created.id}`, 'u2');
    expect((await call('GET', `/${created.id}`, 'u1')).status).toBe(404);
    expect((await call('GET', `/events?environment=${created.id}`, 'u1')).body.events.map((e: { action: string; environmentName: string }) => [e.action, e.environmentName]))
      .toEqual([['environment.delete', 'shared-stack'], ['environment.create', 'shared-stack']]);
    const mine = (await call('POST', '/', 'u1', FULL_STACK)).body.environment;
    await call('DELETE', `/${mine.id}`, 'u1');
    expect((await call('GET', `/events?environment=${mine.id}`, 'u1')).body.events).toHaveLength(2);
    expect((await call('GET', `/events?environment=${mine.id}`, 'u2')).body.events).toEqual([]);
  });

  it('writes no event for an edit that changes nothing', async () => {
    const created = (await call('POST', '/', 'u1', FULL_STACK)).body.environment;
    const same = await call('PUT', `/${created.id}`, 'u1', FULL_STACK);
    expect(same.status).toBe(200);
    expect(same.body.changed).toBe(false);
    expect(store.log).toHaveLength(1);
  });

  it('answers what an environment resolves to for the caller', async () => {
    const created = (await call('POST', '/', 'u1', SHARED)).body.environment;
    expect((await call('GET', `/${created.id}/resolved`, 'u2')).body).toEqual({ repos: [{ repo: 'example-org/webapp' }], size: null, warnings: ['not read in this test'] });
    const mine = (await call('POST', '/', 'u1', POINTER)).body.environment;
    expect((await call('GET', `/${mine.id}/resolved`, 'u2')).status).toBe(404);
  });

  it('refuses an edit made from an older version (409 environment_changed), and takes one made from the current', async () => {
    const created = (await call('POST', '/', 'u1', SHARED)).body.environment;
    const first = await call('PUT', `/${created.id}`, 'u2', { ...SHARED, name: 'stack', updatedAt: created.updatedAt });
    expect(first.status).toBe(200);
    const stale = await call('PUT', `/${created.id}`, 'u1', { ...SHARED, name: 'other', updatedAt: created.updatedAt });
    expect(stale).toMatchObject({ status: 409, body: { code: 'environment_changed' } });
    const staleDelete = await call('DELETE', `/${created.id}`, 'u1', { updatedAt: created.updatedAt });
    expect(staleDelete.body.code).toBe('environment_changed');
    const staleByQuery = await call('DELETE', `/${created.id}?updatedAt=${encodeURIComponent(created.updatedAt)}`, 'u1');
    expect(staleByQuery.body.code).toBe('environment_changed');
    const staleShare = await call('POST', `/${created.id}/visibility`, 'u1', { visibility: 'personal', updatedAt: created.updatedAt });
    expect(staleShare.body.code).toBe('environment_changed');
    expect((await call('PUT', `/${created.id}`, 'u1', { ...SHARED, name: 'other', updatedAt: first.body.environment.updatedAt })).status).toBe(200);
  });

  it('refuses a taken name (409) and an unknown id (404)', async () => {
    await call('POST', '/', 'u1', FULL_STACK);
    expect(await call('POST', '/', 'u2', FULL_STACK)).toMatchObject({ status: 409, body: { code: 'environment_name_taken' } });
    expect((await call('PUT', '/nope', 'u1', FULL_STACK)).status).toBe(404);
    expect((await call('DELETE', '/nope', 'u1')).status).toBe(404);
  });

  const def = (d: unknown) => ({ name: 'x', kind: 'inline', definition: d });
  it.each([
    [{ ...FULL_STACK, name: 'Full Stack' }, /lowercase/],
    [{ name: 'x', kind: 'yaml' }, /inline .* or pointer/],
    [def('{ not json'), /not valid JSON/],
    [def([1]), /a JSON object/],
    [def({ resources: 'small' }), /at least one repository/],
    [def({ repos: [] }), /at least one repository/],
    [def({ repos: [{ repo: 'not a repo' }] }), /not a GitHub repository/],
    [def({ repos: [{ repo: 'a/x' }, { repo: 'A/X' }] }), /listed twice/],
    [def({ repos: [{ repo: 'a/web' }, { repo: 'b/web' }] }), /both be checked out as web/],
    [def({ repos: [{ repo: 'a/x', branch: '-evil' }] }), /not a branch name/],
    [def({ repos: [{ repo: 'a/x', path: '../up' }] }), /directory name/],
    [def({ repos: [{ repo: 'a/x' }], resources: 'huge' }), /"resources" is "huge"/],
    [def({ repos: [{ repo: 'a/x' }], setup: 3 }), /setup must be/],
    [def({ repos: [{ repo: 'a/x' }], ports: [{ name: 'web', port: 70000 }] }), /ports.0.port/],
    [def({ repos: [{ repo: 'a/x' }], resources: { vcpu: 4, memoryGiB: 16, diskGiB: 10 } }), /diskGiB/],
    [{ ...POINTER, file: { repo: 'someone' } }, /not a GitHub repository/],
    [{ ...POINTER, file: { repo: 'a/b', branch: '..x' } }, /not a branch name/],
    [{ ...POINTER, file: { repo: 'a/b', path: '../etc/passwd' } }, /relative/],
    [{ ...POINTER, file: { repo: 'a/b', path: '/abs.json' } }, /relative/],
  ])('refuses a bad environment (%#)', async (body, why) => {
    const r = await call('POST', '/', 'u1', body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(why);
    expect(store.log).toEqual([]);
  });

  it('checks a definition without saving it, for the editor on blur', async () => {
    expect((await call('POST', '/validate', 'u1', { definition: '{"repos":["acme/app"]}' })).body).toEqual({ errors: [] });
    const bad = await call('POST', '/validate', 'u1', { definition: { repos: ['acme/app'], resources: { vcpu: 16, memoryGiB: 32 } } });
    expect(bad.status).toBe(200);
    expect(bad.body.errors).toEqual([expect.stringContaining('16 vCPU is over the 8 vCPU limit')]);
    expect((await call('POST', '/validate', 'u1', { definition: '{ nope' })).body.errors).toEqual(['the definition is not valid JSON']);
    expect((await call('POST', '/validate', null, { definition: '{}' })).status).toBe(401);
    expect(store.log).toEqual([]);
  });

  it('takes an inline definition as JSON text too', async () => {
    const r = await call('POST', '/', 'u1', def(JSON.stringify({ repos: ['acme/app'] })));
    expect(r.status).toBe(201);
    expect(r.body.environment.definition).toEqual({ repos: ['acme/app'] });
  });
});

describe('the CLI routes (termag environment, routes/cliEnvironments.ts)', () => {
  async function cliCall(method: string, path: string, headers: Record<string, string>, body?: unknown) {
    const res = await fetch(`${cliBase}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }
  const AS_BOX = { 'x-test-user': 'u1', 'x-test-box': 'box-1' };
  const AS_ADA = { 'x-test-user': 'u1' };
  const AS_SAM = { 'x-test-user': 'u2' };

  it('needs a CLI credential', async () => {
    expect((await cliCall('GET', '', {})).status).toBe(401);
  });

  it('creates from a device sign-in as its person, and addresses an environment by name', async () => {
    const created = await cliCall('POST', '', AS_ADA, FULL_STACK);
    expect(created.status).toBe(201);
    expect(created.body.environment).toMatchObject({ createdBy: PEOPLE[0], owner: PEOPLE[0], visibility: 'personal' });
    expect(store.log[0]).toMatchObject({ actorUserId: 'u1', action: 'environment.create' });
    expect((await cliCall('GET', '/full-stack', AS_ADA)).body.environment).toMatchObject({ name: 'full-stack', kind: 'inline' });
    expect((await cliCall('GET', '/full-stack', AS_SAM)).status).toBe(404);
    await cliCall('POST', '', AS_SAM, SHARED);
    expect((await cliCall('GET', '', AS_ADA)).body.environments.map((e: { name: string; visibility: string }) => [e.name, e.visibility]))
      .toEqual([['full-stack', 'personal'], ['shared-stack', 'shared']]);
  });

  it('edits, reads the history of and deletes by name, each change an event as in the UI', async () => {
    await cliCall('POST', '', AS_ADA, { ...SHARED, name: 'full-stack' });
    const edited = await cliCall('PUT', '/full-stack', AS_SAM, { ...POINTER_AS('full-stack'), file: { ...POINTER.file, path: 'moved.json' } });
    expect(edited.body.environment).toMatchObject({ kind: 'pointer', updatedBy: PEOPLE[1] });
    expect((await cliCall('GET', '/full-stack/events', AS_SAM)).body.events.map((e: { action: string }) => e.action)).toEqual(['environment.update', 'environment.create']);
    expect((await cliCall('DELETE', '/full-stack', AS_SAM)).status).toBe(200);
    expect((await cliCall('GET', '/full-stack', AS_SAM)).body.code).toBe('environment_not_found');
    expect(store.log.map(e => [e.action, e.actorUserId])).toEqual([['environment.create', 'u1'], ['environment.update', 'u2'], ['environment.delete', 'u2']]);
  });

  it("refuses an invalid definition with the schema's path and message, and validates without saving", async () => {
    const bad = await cliCall('POST', '', AS_ADA, { name: 'x', kind: 'inline', definition: { repos: ['a/b'], ports: [{ name: 'web', port: 70000 }] } });
    expect(bad).toMatchObject({ status: 400, body: { code: 'invalid_environment' } });
    expect(bad.body.error).toMatch(/ports\.0\.port/);
    expect((await cliCall('POST', '/validate', AS_BOX, { definition: { repos: ['a/b'] } })).body).toEqual({ errors: [] });
    expect(store.log).toEqual([]);
  });

  it("refuses every write from a box's own credential with 403, and writes nothing", async () => {
    await cliCall('POST', '', AS_ADA, FULL_STACK);
    const { updatedAt } = (await cliCall('GET', '/full-stack', AS_ADA)).body.environment;
    for (const [method, path, body] of [
      ['POST', '', { ...FULL_STACK, name: 'from-box' }], ['PUT', '/full-stack', POINTER_AS('full-stack')],
      ['DELETE', '/full-stack', { updatedAt }], ['POST', '/full-stack/visibility', { visibility: 'shared' }],
    ] as const) {
      const r = await cliCall(method, path, AS_BOX, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ code: 'environment_box_read_only' });
      expect(r.body.error).toContain('termag login');
    }
    expect(store.log.map(e => e.action)).toEqual(['environment.create']);
    expect((await cliCall('GET', '/full-stack', AS_ADA)).body.environment).toMatchObject({ kind: 'inline', updatedAt });
  });

  it("lets a box's own credential read: list, one, its history, what it resolves to, and validate", async () => {
    await cliCall('POST', '', AS_ADA, FULL_STACK);
    expect((await cliCall('GET', '', AS_BOX)).status).toBe(200);
    expect((await cliCall('GET', '/full-stack', AS_BOX)).status).toBe(200);
    expect((await cliCall('GET', '/full-stack/events', AS_BOX)).status).toBe(200);
    expect((await cliCall('GET', '/full-stack/resolved', AS_BOX)).status).toBe(200);
    expect((await cliCall('POST', '/validate', AS_BOX, { definition: { repos: ['a/b'] } })).body).toEqual({ errors: [] });
  });

  it('answers 404 for an environment there is none of', async () => {
    expect((await cliCall('PUT', '/nope', AS_SAM, FULL_STACK)).status).toBe(404);
    expect((await cliCall('DELETE', '/nope', AS_SAM)).status).toBe(404);
  });
});

function POINTER_AS(name: string) {
  return { ...POINTER, name };
}
