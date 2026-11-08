import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { environmentActions } from '../routes/environments';
import {
  sharedRuleError, visibleTo, resolveEnvironment, usableEnvironment, withEnvironmentRepos, fieldsOf, sameFields,
  MAX_EVENTS, type EnvironmentRecord, type EnvironmentStore, type EnvironmentEventRecord, type EnvironmentFields, type EnvironmentVisibility,
} from './environments';

// Personal and shared environments: a personal one is its owner's alone;
// a shared one is everyone's, and runs from a file on its repository's default branch, so what it can run on a box
// is what can land on that branch.

beforeAll(() => { vi.stubEnv('GITHUB_REPO_ORGS', 'example-org,example-team,acme'); });
afterAll(() => { vi.unstubAllEnvs(); });

/** GitHub as the rules read it: each repository's default branch, and the files on it. */
function github(defaults: Record<string, string>, files: Record<string, string> = {}) {
  return {
    defaultBranch: async (_u: string, repo: string) => (defaults[repo] ? { branch: defaults[repo] } : { error: `GitHub doesn't show you ${repo}` }),
    text: async (_u: string, repo: string, path: string, ref?: string | null) => {
      const t = files[`${repo}:${ref}:${path}`];
      return t !== undefined ? { text: t } : { error: `${repo} has no ${path} on ${ref}` };
    },
  };
}
const FILE = '.termag/environment.json';
const pointer = (repo: string, branch: string | null = null, path = FILE): EnvironmentFields => ({ name: 'shop', kind: 'pointer', file: { repo, branch, path } });

describe('the shared rules', () => {
  const gh = github({ 'acme/web': 'main', 'acme/api': 'trunk' }, {
    [`acme/web:main:${FILE}`]: JSON.stringify({ repos: [{ repo: 'acme/web' }, { repo: 'acme/api' }], setup: 'make' }),
    'acme/web:main:.termag/bad.json': JSON.stringify({ repos: [{ repo: 'acme/web' }, { repo: 'acme/api', branch: 'feature' }] }),
    'acme/web:main:.termag/named.json': JSON.stringify({ repos: [{ repo: 'acme/web', branch: 'main' }, { repo: 'acme/api', branch: 'trunk' }] }),
  });
  it('take a pointer on its default branch, named or not, whose repos are on theirs', async () => {
    expect(await sharedRuleError('u1', pointer('acme/web'), gh)).toBeNull();
    expect(await sharedRuleError('u1', pointer('acme/web', 'main'), gh)).toBeNull();
    expect(await sharedRuleError('u1', pointer('acme/web', null, '.termag/named.json'), gh)).toBeNull();
  });
  it('refuse inline JSON', async () => {
    expect(await sharedRuleError('u1', { name: 'shop', kind: 'inline', definition: { repos: [{ repo: 'acme/web' }] } }, gh))
      .toMatch(/a shared environment runs from a file on a repository's default branch, not inline JSON/);
  });
  it('refuse a pointer on another branch, saying the default', async () => {
    expect(await sharedRuleError('u1', pointer('acme/web', 'feature'), gh))
      .toBe("a shared environment runs from a file on acme/web's default branch; point it at .termag/environment.json on main");
  });
  it("refuse a file that checks a repository out on a branch that isn't its default", async () => {
    expect(await sharedRuleError('u1', pointer('acme/web', null, '.termag/bad.json'), gh))
      .toBe("a shared environment checks out every repository on its default branch; acme/api names feature, not trunk");
  });
  it("refuse when the file isn't on the default branch, or GitHub can't say what that is", async () => {
    expect(await sharedRuleError('u1', pointer('acme/web', null, '.termag/none.json'), gh)).toMatch(/acme\/web has no \.termag\/none\.json on main/);
    expect(await sharedRuleError('u1', pointer('acme/gone'), gh)).toMatch(/couldn't check acme\/gone's default branch/);
  });
});

const meta = { createdAt: new Date(), updatedAt: new Date(), createdByUserId: 'ada', updatedByUserId: 'ada' };
const rec = (id: string, name: string, visibility: EnvironmentVisibility, ownerUserId: string, fields?: Partial<EnvironmentFields>): EnvironmentRecord =>
  ({ id, name, kind: 'pointer', file: { repo: 'acme/web', branch: null, path: FILE }, ...fields, ...meta, visibility, ownerUserId } as EnvironmentRecord);

describe('who sees an environment', () => {
  it('a personal one: its owner only; a shared one: everyone', () => {
    expect(visibleTo(rec('e1', 'mine', 'personal', 'ada'), 'ada')).toBe(true);
    expect(visibleTo(rec('e1', 'mine', 'personal', 'ada'), 'bob')).toBe(false);
    expect(visibleTo(rec('e2', 'ours', 'shared', 'ada'), 'bob')).toBe(true);
  });
  it("resolves someone else's personal environment as no such environment", async () => {
    const store = { byName: async () => rec('e1', 'mine', 'personal', 'ada') };
    expect(await resolveEnvironment(store, 'mine', 'ada')).toMatchObject({ environment: { id: 'e1' } });
    expect(await resolveEnvironment(store, 'mine', 'bob')).toMatchObject({ status: 404, body: { code: 'environment_not_found' } });
  });
  it("uses a shared one only while it keeps to the rules (a box from it), and a personal one on any branch for its owner", async () => {
    const onFeature = { file: { repo: 'acme/web', branch: 'feature', path: FILE } } as never;
    const gh = github({ 'acme/web': 'main' }, { [`acme/web:main:${FILE}`]: '{"repos":["acme/web"]}' });
    expect(await usableEnvironment({ byName: async () => rec('e2', 'ours', 'shared', 'ada') }, 'ours', 'bob', gh)).toMatchObject({ environment: { id: 'e2' } });
    expect(await usableEnvironment({ byName: async () => rec('e2', 'ours', 'shared', 'ada', onFeature) }, 'ours', 'bob', gh))
      .toMatchObject({ status: 400, body: { code: 'environment_not_shareable', error: expect.stringMatching(/^ours: .*point it at \.termag\/environment\.json on main/) } });
    expect(await usableEnvironment({ byName: async () => rec('e1', 'mine', 'personal', 'ada', onFeature) }, 'mine', 'ada', gh)).toMatchObject({ environment: { id: 'e1' } });
  });
  it('refuses a project from a shared environment that breaks the rules when it is resolved', async () => {
    const store = { byName: async () => rec('e2', 'ours', 'shared', 'ada', { file: { repo: 'acme/web', branch: 'feature', path: FILE } } as never) };
    const resolve = async () => ({ repos: [{ repo: 'acme/web', branch: 'feature' }], sizes: null, warnings: [] });
    expect(await withEnvironmentRepos(store, 'bob', { name: 'p', environment: 'ours', environmentRepos: [{ repo: 'acme/web', branch: 'feature' }] }, resolve, github({ 'acme/web': 'main' })))
      .toMatchObject({ status: 400, body: { code: 'environment_not_shareable', error: expect.stringContaining("acme/web's default branch") } });
  });
});

/** The routes' store, in memory. */
function memoryStore(): EnvironmentStore & { rows: EnvironmentRecord[]; log: EnvironmentEventRecord[] } {
  const rows: EnvironmentRecord[] = [];
  const log: EnvironmentEventRecord[] = [];
  let n = 0;
  const snap = (r: EnvironmentRecord) => ({ ...fieldsOf(r), visibility: r.visibility, ownerUserId: r.ownerUserId });
  return {
    rows, log,
    async list() { return [...rows]; },
    async get(id) { return rows.find(r => r.id === id) ?? null; },
    async byName(name) { return rows.find(r => r.name === name) ?? null; },
    async create(actor, fields, visibility = 'personal') {
      if (rows.some(r => r.name === fields.name)) return { ok: false, reason: 'name_taken' };
      const row = { ...fieldsOf(fields), id: `env${++n}`, ...meta, createdByUserId: actor, updatedByUserId: actor, visibility, ownerUserId: actor } as EnvironmentRecord;
      rows.push(row);
      log.push({ id: `ev${log.length}`, at: new Date(), environmentId: row.id, actorUserId: actor, action: 'environment.create', before: null, after: snap(row) });
      return { ok: true, environment: row, changed: true };
    },
    async update(actor, id, fields) {
      const row = rows.find(r => r.id === id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (sameFields(row, fields)) return { ok: true, environment: row, changed: false };
      const before = snap(row);
      const r = row as Record<string, unknown>; delete r.definition; delete r.file;
      Object.assign(row, fieldsOf(fields), { updatedByUserId: actor });
      log.push({ id: `ev${log.length}`, at: new Date(), environmentId: id, actorUserId: actor, action: 'environment.update', before, after: snap(row) });
      return { ok: true, environment: row, changed: true };
    },
    async setVisibility(actor, id, visibility) {
      const row = rows.find(r => r.id === id);
      if (!row) return { ok: false, reason: 'not_found' };
      const before = snap(row);
      row.visibility = visibility;
      log.push({ id: `ev${log.length}`, at: new Date(), environmentId: id, actorUserId: actor, action: 'environment.visibility', before, after: snap(row) });
      return { ok: true, environment: row, changed: true };
    },
    async remove(actor, id) {
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) return { ok: false, reason: 'not_found' };
      const [row] = rows.splice(i, 1);
      log.push({ id: `ev${log.length}`, at: new Date(), environmentId: id, actorUserId: actor, action: 'environment.delete', before: snap(row), after: null });
      return { ok: true, environment: row, changed: true };
    },
    // As the Prisma store: newest first, a page of at most `limit` from `skip` on.
    async events(id, limit = MAX_EVENTS, skip = 0) { return [...log].reverse().filter(e => !id || e.environmentId === id).slice(skip, skip + Math.min(limit, MAX_EVENTS)); },
  };
}

describe("the audit log, with other people's personal environments in it", () => {
  const act = (store: EnvironmentStore) => environmentActions({ store, people: async () => [], github: github({}) });
  const event = (i: number, environmentId: string, actorUserId: string, after: Record<string, unknown> | null, before: Record<string, unknown> | null = null) =>
    ({ id: `ev${i}`, at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)), environmentId, actorUserId, action: after ? 'environment.update' : 'environment.delete', before, after }) as EnvironmentEventRecord;

  it("still shows the shared history under a full page of someone else's newer personal events", async () => {
    const store = memoryStore();
    store.rows.push(rec('ours', 'ours', 'shared', 'ada'), rec('mine', 'mine', 'personal', 'ada'));
    const shared = { name: 'ours', kind: 'pointer', file: { repo: 'acme/web', branch: null, path: FILE }, visibility: 'shared', ownerUserId: 'ada' };
    const personal = { ...shared, name: 'mine', visibility: 'personal' };
    store.log.push(event(0, 'ours', 'ada', shared));
    for (let i = 1; i <= MAX_EVENTS + 20; i++) store.log.push(event(i, 'mine', 'ada', personal));
    const seen = (await act(store).events('bob', null)).body as { events: Array<{ environmentId: string }> };
    expect(seen.events.map(e => e.environmentId)).toEqual(['ours']);
    expect(((await act(store).events('ada', null)).body as { events: unknown[] }).events).toHaveLength(MAX_EVENTS);
  });

  it("keeps a deleted environment's events written with no visibility to whoever its legacy reading makes it", async () => {
    const store = memoryStore();
    const inline = { name: 'old', kind: 'inline', definition: { repos: ['acme/web'], setup: 'secret-ish' } };
    const onDefault = { name: 'plain', kind: 'pointer', file: { repo: 'acme/web', branch: null, path: FILE } };
    store.log.push(event(0, 'gone1', 'ada', inline), event(1, 'gone1', 'ada', null, inline), event(2, 'gone2', 'ada', null, onDefault));
    const ids = async (who: string) => ((await act(store).events(who, null)).body as { events: Array<{ id: string }> }).events.map(e => e.id);
    expect(await ids('bob')).toEqual(['ev2']);
    expect(await ids('ada')).toEqual(['ev2', 'ev1', 'ev0']);
  });
});

describe('the environment routes, personal and shared', () => {
  const setup = () => {
    const store = memoryStore();
    const act = environmentActions({ store, people: async () => [], github: github({ 'acme/web': 'main' }, { [`acme/web:main:${FILE}`]: '{"repos":[{"repo":"acme/web"}]}' }) });
    return { store, act };
  };
  const inline = { name: 'mine', kind: 'inline', definition: { repos: [{ repo: 'acme/web' }], setup: 'make' } };
  const sharedPointer = { name: 'ours', kind: 'pointer', file: { repo: 'acme/web' }, visibility: 'shared' };

  it('makes a new environment personal to its creator by default', async () => {
    const { act } = setup();
    const r = await act.create('ada', inline);
    expect(r).toMatchObject({ status: 201, body: { environment: { visibility: 'personal', owner: null } } });
  });
  it('refuses to make an inline one shared, saying the rule, and makes a pointer on the default branch shared', async () => {
    const { act } = setup();
    expect(await act.create('ada', { ...inline, visibility: 'shared' })).toMatchObject({ status: 400, body: { code: 'environment_not_shareable', error: expect.stringContaining('not inline JSON') } });
    expect(await act.create('ada', { ...sharedPointer, file: { repo: 'acme/web', branch: 'feature' } }))
      .toMatchObject({ status: 400, body: { error: "a shared environment runs from a file on acme/web's default branch; point it at .termag/environment.json on main" } });
    expect(await act.create('ada', sharedPointer)).toMatchObject({ status: 201, body: { environment: { visibility: 'shared' } } });
  });
  it("lists the caller's personal environments first, then the shared ones, and nobody else's personal ones", async () => {
    const { act } = setup();
    await act.create('ada', sharedPointer);
    await act.create('ada', inline);
    await act.create('bob', { ...inline, name: 'bobs' });
    const names = (r: { body: unknown }) => (r.body as { environments: Array<{ name: string; visibility: string }> }).environments.map(e => `${e.visibility}:${e.name}`);
    expect(names(await act.list('ada'))).toEqual(['personal:mine', 'shared:ours']);
    expect(names(await act.list('bob'))).toEqual(['personal:bobs', 'shared:ours']);
  });
  it("hides someone else's personal environment: get, resolve, edit, delete and history all answer 404", async () => {
    const { act } = setup();
    await act.create('ada', inline);
    expect(await act.get('bob', 'mine')).toMatchObject({ status: 404 });
    expect(await act.resolved('bob', 'mine')).toMatchObject({ status: 404 });
    expect(await act.update('bob', 'mine', { ...inline, definition: { repos: [{ repo: 'acme/web' }], setup: 'evil' } })).toMatchObject({ status: 404 });
    expect(await act.remove('bob', 'mine', undefined)).toMatchObject({ status: 404 });
    expect(await act.events('bob', 'mine')).toMatchObject({ status: 200, body: { events: [] } });
    expect((await act.events('bob', null)).body).toEqual({ events: [] });
    expect((await act.events('ada', null)).body).toMatchObject({ events: [expect.objectContaining({ environmentName: 'mine' })] });
  });
  it('lets anyone edit a shared one, so long as the file pointer keeps to the rules', async () => {
    const { act } = setup();
    await act.create('ada', sharedPointer);
    expect(await act.update('bob', 'ours', { ...sharedPointer, name: 'shop' })).toMatchObject({ status: 200, body: { environment: { name: 'shop', visibility: 'shared' } } });
    expect(await act.update('bob', 'shop', { ...sharedPointer, name: 'shop', file: { repo: 'acme/web', branch: 'feature' } })).toMatchObject({ status: 400, body: { code: 'environment_not_shareable' } });
    expect(await act.update('bob', 'shop', { name: 'shop', kind: 'inline', definition: { repos: [{ repo: 'acme/web' }] } })).toMatchObject({ status: 400, body: { code: 'environment_not_shareable' } });
  });
  it('lets only the owner switch it between personal and shared, checking the rules to share', async () => {
    const { act } = setup();
    await act.create('ada', inline);
    expect(await act.setVisibility('ada', 'mine', 'shared')).toMatchObject({ status: 400, body: { code: 'environment_not_shareable' } });
    await act.create('ada', { name: 'ptr', kind: 'pointer', file: { repo: 'acme/web' } });
    expect(await act.setVisibility('ada', 'ptr', 'shared')).toMatchObject({ status: 200, body: { environment: { visibility: 'shared' } } });
    expect(await act.setVisibility('bob', 'ptr', 'personal')).toMatchObject({ status: 403, body: { code: 'environment_not_owner' } });
    expect(await act.setVisibility('ada', 'ptr', 'personal')).toMatchObject({ status: 200, body: { environment: { visibility: 'personal' } } });
    expect(await act.setVisibility('ada', 'ptr', 'public' as never)).toMatchObject({ status: 400 });
  });
});
