/**
 * The environments store against a real Postgres (services/environments.ts):
 * each change and its audit event land together, an edit made from an older
 * version is refused, two edits from the same version can't both win, and a
 * deleted environment's events stay.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_environments_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_environments_${process.pid}$1`); });

const FIELDS = {
  name: 'full-stack',
  kind: 'inline' as const,
  definition: { resources: { vcpu: 4, memoryGiB: 32 }, repos: [{ repo: 'example-org/webapp' }, { repo: 'example-org/web', path: 'frontend', branch: 'main' }] },
};
const POINTER = { name: 'full-stack', kind: 'pointer' as const, file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } };

describe.skipIf(!adminUrl)('the environments store against Postgres', () => {
  let store: typeof import('./environments').prismaEnvironmentStore;
  let backfill: typeof import('./environments').backfillEnvironmentVisibility;
  let prisma: typeof import('../db').prisma;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../db'));
    ({ prismaEnvironmentStore: store, backfillEnvironmentVisibility: backfill } = await import('./environments'));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('creates, edits and deletes, with one event per change and the fields before and after', async () => {
    const created = await store.create('u1', FIELDS);
    if (!created.ok) throw new Error(created.reason);
    const id = created.environment.id;
    expect(created.environment).toMatchObject({ ...FIELDS, createdByUserId: 'u1', updatedByUserId: 'u1' });
    expect(await store.byName('Full-Stack ')).toMatchObject({ id });

    const same = await store.update('u2', id, FIELDS);
    expect(same).toMatchObject({ ok: true, changed: false });

    // Postgres reorders JSONB keys: the same definition, reordered, is still no change.
    const reordered = { ...FIELDS, definition: { repos: FIELDS.definition.repos, resources: FIELDS.definition.resources } };
    expect(await store.update('u2', id, reordered)).toMatchObject({ ok: true, changed: false });

    const edited = await store.update('u2', id, POINTER, created.environment.updatedAt);
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.environment).toMatchObject({ kind: 'pointer', file: POINTER.file, updatedByUserId: 'u2' });
    expect(edited.environment).not.toHaveProperty('definition');

    expect(await store.update('u1', id, FIELDS, created.environment.updatedAt)).toEqual({ ok: false, reason: 'changed' });
    expect(await store.remove('u1', id, created.environment.updatedAt)).toEqual({ ok: false, reason: 'changed' });

    expect(await store.remove('u3', id, edited.environment.updatedAt)).toMatchObject({ ok: true });
    expect(await store.get(id)).toBeNull();

    const events = await store.events(id);
    expect(events.map(e => [e.action, e.actorUserId])).toEqual([
      ['environment.delete', 'u3'], ['environment.update', 'u2'], ['environment.create', 'u1'],
    ]);
    expect(events[2].before).toBeNull();
    // Each snapshot says whose it was, so the audit log can keep a personal environment's history to its owner.
    const mine = { visibility: 'personal', ownerUserId: 'u1' };
    expect(events[2].after).toEqual({ ...FIELDS, ...mine });
    expect(events[1].before).toEqual({ ...FIELDS, ...mine });
    expect(events[1].after).toEqual({ ...POINTER, ...mine });
    expect(events[0].after).toBeNull();
    expect(events[0].before).toEqual({ ...POINTER, ...mine });
    // The audit log reads every environment's events, newest first.
    expect((await store.events(null)).map(e => e.environmentId)).toContain(id);
  });

  it('refuses a second environment of the same name, and frees the name once it is deleted', async () => {
    const a = await store.create('u1', { ...FIELDS, name: 'dup' });
    expect(a.ok).toBe(true);
    expect(await store.create('u2', { ...FIELDS, name: 'dup' })).toEqual({ ok: false, reason: 'name_taken' });
    const b = await store.create('u2', { ...FIELDS, name: 'other' });
    if (!b.ok || !a.ok) throw new Error('create');
    expect(await store.update('u2', b.environment.id, { ...FIELDS, name: 'dup' })).toEqual({ ok: false, reason: 'name_taken' });
    await store.remove('u1', a.environment.id);
    expect((await store.create('u2', { ...FIELDS, name: 'dup' })).ok).toBe(true);
  });

  it('of two edits from the same version, exactly one wins and writes an event', async () => {
    const c = await store.create('u1', { ...FIELDS, name: 'race' });
    if (!c.ok) throw new Error(c.reason);
    const since = c.environment.updatedAt;
    const results = await Promise.all(['u2', 'u3'].map((u, i) =>
      store.update(u, c.environment.id, { ...POINTER, name: 'race', file: { ...POINTER.file, path: `e${i}.json` } }, since)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: 'changed' }]);
    expect((await store.events(c.environment.id)).map(e => e.action)).toEqual(['environment.update', 'environment.create']);
  });

  it('refuses a later save, or delete, from the version an edit has since replaced (Bugbot, #985)', async () => {
    const c = await store.create('u1', { ...FIELDS, name: 'stale' });
    if (!c.ok) throw new Error(c.reason);
    const since = c.environment.updatedAt;
    const first = await store.update('u2', c.environment.id, { ...POINTER, name: 'stale', file: { ...POINTER.file, path: 'first.json' } }, since);
    expect(first).toMatchObject({ ok: true, changed: true });
    // updateMany doesn't apply @updatedAt: the edit must move the version itself.
    expect(first.ok && first.environment.updatedAt.getTime()).not.toBe(since.getTime());
    expect(await store.update('u3', c.environment.id, { ...POINTER, name: 'stale', file: { ...POINTER.file, path: 'second.json' } }, since))
      .toEqual({ ok: false, reason: 'changed' });
    expect(await store.remove('u3', c.environment.id, since)).toEqual({ ok: false, reason: 'changed' });
    expect((await store.events(c.environment.id)).map(e => e.action)).toEqual(['environment.update', 'environment.create']);
  });
  it('reads the audit log a page at a time, newest first, from where the last page ended', async () => {
    const created = await store.create('u1', { ...POINTER, name: 'paged' });
    if (!created.ok) throw new Error(created.reason);
    let since = created.environment.updatedAt;
    for (const path of ['a.json', 'b.json', 'c.json']) {
      const w = await store.update('u1', created.environment.id, { ...POINTER, name: 'paged', file: { ...POINTER.file, path } }, since);
      if (!w.ok) throw new Error(w.reason);
      since = w.environment.updatedAt;
    }
    const all = (await store.events(created.environment.id)).map(e => e.id);
    expect(all).toHaveLength(4);
    const pages = [...await store.events(created.environment.id, 2, 0), ...await store.events(created.environment.id, 2, 2)].map(e => e.id);
    expect(pages).toEqual(all);
  });

  it('makes a new one personal to its creator, and switches it with an event and without a new version', async () => {
    const created = await store.create('u1', { ...POINTER, name: 'switchable' });
    if (!created.ok) throw new Error(created.reason);
    expect(created.environment).toMatchObject({ visibility: 'personal', ownerUserId: 'u1' });
    const shared = await store.setVisibility('u1', created.environment.id, 'shared', created.environment.updatedAt);
    expect(shared).toMatchObject({ ok: true, changed: true, environment: { visibility: 'shared', ownerUserId: 'u1' } });
    expect(await store.setVisibility('u1', created.environment.id, 'personal', created.environment.updatedAt)).toEqual({ ok: false, reason: 'changed' });
    const [event] = await store.events(created.environment.id);
    expect(event).toMatchObject({ action: 'environment.visibility', before: { visibility: 'personal' }, after: { visibility: 'shared', ownerUserId: 'u1' } });
  });

  it('decides a row written with no visibility: shared when it keeps to the shared rules, else personal, each its creator\'s', async () => {
    const insert = (name: string, kind: string, fileBranch: string | null, creator: string | null) => prisma.$executeRawUnsafe(
      `INSERT INTO "environments" ("id","name","kind","definition","fileRepo","fileBranch","filePath","createdByUserId","updatedByUserId","updatedAt")
       VALUES ($1,$1,$2,$3::jsonb,$4,$5,$6,$7,$7,now())`,
      name, kind, kind === 'inline' ? '{"repos":["acme/web"]}' : null, kind === 'pointer' ? 'acme/web' : null, fileBranch, kind === 'pointer' ? '.termag/environment.json' : null, creator);
    await insert('legacy-default', 'pointer', null, 'u1');
    await insert('legacy-main', 'pointer', 'main', 'u2');
    await insert('legacy-feature', 'pointer', 'feature', 'u1');
    await insert('legacy-inline', 'inline', null, 'u2');
    await insert('legacy-orphan', 'pointer', null, null);
    // Before the backfill, reads take the static guess.
    expect(await store.byName('legacy-default')).toMatchObject({ visibility: 'shared', ownerUserId: 'u1' });
    expect(await store.byName('legacy-main')).toMatchObject({ visibility: 'personal', ownerUserId: 'u2' });
    const before = (await store.byName('legacy-main'))!.updatedAt;
    const github = {
      defaultBranch: async () => ({ branch: 'main' }),
      text: async () => ({ text: '{"repos":["acme/web"]}' }),
    };
    expect(await backfill(github)).toEqual({ shared: 2, personal: 3 });
    expect(await store.byName('legacy-default')).toMatchObject({ visibility: 'shared', ownerUserId: 'u1' });
    expect(await store.byName('legacy-main')).toMatchObject({ visibility: 'shared', ownerUserId: 'u2', updatedAt: before });
    expect(await store.byName('legacy-feature')).toMatchObject({ visibility: 'personal', ownerUserId: 'u1' });
    expect(await store.byName('legacy-inline')).toMatchObject({ visibility: 'personal', ownerUserId: 'u2' });
    expect(await store.byName('legacy-orphan')).toMatchObject({ visibility: 'personal', ownerUserId: null });
    expect(await backfill(github)).toEqual({ shared: 0, personal: 0 });
  });
});
