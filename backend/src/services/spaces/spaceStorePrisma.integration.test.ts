/**
 * Space listings (ProjectSpace) against a real Postgres: a listing names the
 * box it was made for, so a project that moves to a box the space never
 * granted doesn't make that box listed, and one that moves to a granted box
 * stays listed there once that box terminates.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_listings_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_listings_${process.pid}$1`); });

describe.skipIf(!adminUrl)('space listings against Postgres', () => {
  let store: typeof import('./spaceStorePrisma').prismaSpaceStore;
  let prisma: typeof import('../../db').prisma;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../../db'));
    ({ prismaSpaceStore: store } = await import('./spaceStorePrisma'));
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
    await prisma.space.create({ data: { id: 's1', name: 'assets', createdById: 'u1' } });
    for (const id of ['old', 'other', 'granted']) await prisma.instance.create({ data: { id, name: id, userId: 'u1', status: 'ready' } });
    await prisma.project.create({ data: { id: 'p1', name: 'chat', userId: 'u1', instanceId: 'old' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('lists a project for its box, and not for a box it moves to that the space never granted', async () => {
    await store.addGrant('s1', 'old', 'u1');
    await store.addGrant('s1', 'granted', 'u1');
    expect(await store.listedBoxes('s1')).toEqual(['old']);

    await prisma.project.update({ where: { id: 'p1' }, data: { instanceId: 'other' } });
    expect(await store.listedBoxes('s1')).toEqual([]);
    await prisma.instance.update({ where: { id: 'old' }, data: { status: 'terminated' } });
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect(await store.listedBoxes('s1')).toEqual([]);
  });

  it('moves the listing with a project that lands on a granted box, so it stays once that box terminates', async () => {
    await prisma.project.update({ where: { id: 'p1' }, data: { instanceId: 'granted' } });
    expect(await store.recordListings()).toBe(1);
    expect(await store.recordListings()).toBe(0);
    await prisma.instance.update({ where: { id: 'granted' }, data: { status: 'terminated' } });
    await store.recordListings();
    await store.pruneTerminatedGrants();
    expect(await store.listedBoxes('s1')).toEqual(['granted']);
  });

  it('unlists the projects listed for a removed box, including a listing its project has since moved off', async () => {
    await prisma.instance.create({ data: { id: 'third', name: 'third', userId: 'u1', status: 'ready' } });
    await prisma.project.create({ data: { id: 'p2', name: 'other chat', userId: 'u1', instanceId: 'third' } });
    await store.addGrant('s1', 'third', 'u1');
    await prisma.project.update({ where: { id: 'p2' }, data: { instanceId: 'other' } });
    expect(await store.removeGrant('s1', 'third')).toBe(true);
    expect(await prisma.projectSpace.findMany({ where: { projectId: 'p2' } })).toEqual([]);
    expect(await store.listedBoxes('s1')).toEqual(['granted']);
  });
});
