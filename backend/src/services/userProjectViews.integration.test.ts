/**
 * The project record's reads against a real Postgres
 * : one project for a repository's checkouts on two boxes, with
 * each box, its status and its live sessions; owner only, so a collaborator on
 * a shared checkout never sees the owner's project.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_user_project_views_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_user_project_views_${process.pid}$1`); });

describe.skipIf(!adminUrl)('the project record reads against Postgres', () => {
  let views: typeof import('./userProjectViews');
  let up: typeof import('./userProjects');
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
    views = await import('./userProjectViews');
    up = await import('./userProjects');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it("answers one sample project with a checkout on each box, and only to its owner", async () => {
    for (const id of ['own', 'pal']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    const box = (id: string, status: string) => prisma.instance.create({ data: { id, name: id, userId: 'own', status, kind: 'ec2' } });
    await box('box-1', 'ready');
    await box('box-2', 'stopped');
    const make = (name: string, instanceId: string, lastActiveAt: Date) => prisma.project.create({
      data: { name, userId: 'own', instanceId, repoUrl: 'https://github.com/e2e-org/sample', lastActiveAt },
    });
    const one = await make('sample', 'box-1', new Date('2026-01-01T00:05:00Z'));
    const two = await make('sample', 'box-2', new Date('2026-01-01T00:09:00Z'));
    await prisma.workstream.createMany({
      data: [
        { projectId: one.id, name: 'main', branch: 'main' },
        { projectId: one.id, name: 'side', branch: 'side' },
        { projectId: one.id, name: 'gone', branch: 'gone', archived: true },
        { projectId: two.id, name: 'main', branch: 'main' },
      ],
    });
    await prisma.projectShare.create({ data: { projectId: one.id, userId: 'pal' } });
    await up.ensureUserProjects('own');

    const list = await views.listUserProjectViews('own');
    expect(list).toHaveLength(1);
    const [p] = list;
    expect([p.name, p.archived, p.filesSpace, p.lastActiveAt]).toEqual(['sample', false, null, '2026-01-01T00:09:00.000Z']);
    expect(p.repos).toEqual([{ repoKey: 'e2e-org/sample', name: 'sample', url: 'https://github.com/e2e-org/sample', defaultBranch: null, iconId: null, iconSrc: null }]);
    expect(p.checkouts).toEqual([
      { projectId: two.id, instanceId: 'box-2', boxName: 'box-2', boxStatus: 'stopped', sessions: 1, archived: false },
      { projectId: one.id, instanceId: 'box-1', boxName: 'box-1', boxStatus: 'ready', sessions: 2, archived: false },
    ]);
    expect(await views.userProjectViewFor('own', p.id)).toEqual(p);

    // The collaborator on the shared checkout has no project, and can't read the owner's.
    await up.ensureUserProjects('pal');
    expect(await views.listUserProjectViews('pal')).toEqual([]);
    expect(await views.userProjectViewFor('pal', p.id)).toBeNull();
  });
});
