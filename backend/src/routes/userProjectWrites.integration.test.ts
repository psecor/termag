/**
 * PATCH /api/user-projects/:id and its archive plan against a real Postgres:
 * a rename changes the
 * project's name and no checkout's, a taken name (archived or not, any case)
 * is refused, a change of case isn't; the plan counts the other checkouts on
 * each box; archive and unarchive mark the project, owner only. The archives
 * themselves (routes/chats.ts, routes/projects.ts) are stood in for: they
 * talk to boxes, and have their own tests.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_user_project_writes_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_user_project_writes_${process.pid}$1`); });

// The archives mark the checkout archived, as theirs do once the box has let go.
const archived = vi.hoisted(() => ({ ids: [] as string[] }));
// project-files-enabled (and user-projects-enabled, which it needs) for the filesSpace cases; every other flag its fallback.
const files = vi.hoisted(() => ({ on: false }));
vi.mock('../services/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  boolVariation: vi.fn(async (key: string, _u: unknown, fallback: boolean) =>
    (key === 'project-files-enabled' || key === 'user-projects-enabled' ? files.on : fallback)),
}));
vi.mock('./chats', () => ({
  archiveChatFor: async (_u: unknown, id: string) => {
    const { prisma } = await import('../db');
    await prisma.project.update({ where: { id }, data: { archived: true } });
    archived.ids.push(id);
    return { status: 200, body: { archived: true, box: { action: null, reason: 'kept' } } };
  },
}));
vi.mock('./projects', () => ({
  archiveOwnedProject: async (_u: unknown, id: string) => {
    const { prisma } = await import('../db');
    await prisma.project.update({ where: { id }, data: { archived: true } });
    archived.ids.push(id);
    return { status: 200, body: { ok: true } };
  },
}));

describe.skipIf(!adminUrl)('PATCH /api/user-projects/:id against Postgres', () => {
  let writes: typeof import('./userProjectWrites');
  let up: typeof import('../services/userProjects');
  let prisma: typeof import('../db').prisma;
  const own = { id: 'own', unixUsername: 'own' } as Express.User;
  const pal = { id: 'pal', unixUsername: 'pal' } as Express.User;

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
    writes = await import('./userProjectWrites');
    up = await import('../services/userProjects');

    for (const id of ['own', 'pal']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    for (const id of ['box-a', 'box-b']) await prisma.instance.create({ data: { id, name: id, userId: 'own', status: 'ready', kind: 'ec2' } });
    const chat = (name: string, instanceId: string, repoUrl: string | null) => prisma.project.create({
      data: {
        name, userId: 'own', instanceId, repoUrl,
        workstreams: { create: [{ name: 'main', branch: 'main' }] },
      },
      include: { workstreams: true },
    });
    const a = await chat('sample', 'box-a', 'https://github.com/e2e-org/sample');
    const b = await chat('sample', 'box-b', 'https://github.com/e2e-org/sample');
    // Another project's checkout on box-b: it keeps running.
    await chat('docs', 'box-b', 'https://github.com/e2e-org/docs');
    for (const p of [a, b]) {
      await prisma.workflow.create({ data: { projectId: p.id, workstreamId: p.workstreams[0].id, type: 'agent', provider: 'claude-chat' } });
    }
    await up.ensureUserProjects('own');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const projectNamed = async (name: string) => (await prisma.userProject.findFirstOrThrow({ where: { userId: 'own', name } })).id;

  it("renames the project and no checkout, refuses a taken name in any case, and lets a change of case through", async () => {
    const sample = await projectNamed('sample');
    const res = await writes.patchUserProjectFor(own, sample, { name: 'Sample app' });
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe('Sample app');
    expect((await prisma.project.findMany({ where: { userProjectId: sample }, select: { name: true } })).map(p => p.name)).toEqual(['sample', 'sample']);

    const taken = await writes.patchUserProjectFor(own, sample, { name: 'DOCS' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'user_project_name_taken', projectId: await projectNamed('docs'), archived: false });
    expect((await writes.patchUserProjectFor(own, sample, { name: 'sample APP' })).status).toBe(200);
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: sample } })).nameKey).toBe('sample app');
  });

  it("is the owner's only", async () => {
    const sample = (await prisma.userProject.findFirstOrThrow({ where: { userId: 'own', nameKey: 'sample app' } })).id;
    expect((await writes.patchUserProjectFor(pal, sample, { name: 'mine now' })).status).toBe(404);
    expect((await writes.archivePlanFor(pal, sample)).status).toBe(404);
  });

  it("plans box-a stopping and box-b running for docs, then archives both checkouts and the project, and unarchives the project alone", async () => {
    const sample = (await prisma.userProject.findFirstOrThrow({ where: { userId: 'own', nameKey: 'sample app' } })).id;
    const plan = await writes.archivePlanFor(own, sample);
    expect(plan.body).toMatchObject({
      sessions: 2,
      boxes: [{ boxName: 'box-a', fate: 'stops', why: 'nothing-else' }, { boxName: 'box-b', fate: 'keeps', why: 'other-sessions' }],
    });

    const res = await writes.patchUserProjectFor(own, sample, { archived: true });
    expect(res.status).toBe(200);
    expect((res.body as { archived: boolean }).archived).toBe(true);
    expect(archived.ids).toHaveLength(2);
    expect(await prisma.project.count({ where: { userProjectId: sample, archived: false } })).toBe(0);

    const back = await writes.patchUserProjectFor(own, sample, { archived: false });
    expect((back.body as { archived: boolean }).archived).toBe(false);
    // Its checkouts reopen one by one from Archived, as today.
    expect(await prisma.project.count({ where: { userProjectId: sample, archived: false } })).toBe(0);
  });

  it('brings an archived project back when a session asked for there attaches after the archive', async () => {
    const sample = (await prisma.userProject.findFirstOrThrow({ where: { userId: 'own', nameKey: 'sample app' } })).id;
    expect((await writes.patchUserProjectFor(own, sample, { archived: true })).status).toBe(200);
    // New session here: the create checked the project before the archive marked it; its checkout attaches now.
    const late = await prisma.project.create({ data: { name: 'sample-2', userId: 'own', instanceId: 'box-a', repoUrl: 'https://github.com/e2e-org/sample' } });
    expect(await up.attachCheckout('own', late.id, sample)).toBe(sample);
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: sample } })).archivedAt).toBeNull();
  });

  it('uses one of the owner\'s spaces for the project\'s files, under project-files-enabled, and refuses one already in use', async () => {
    const docs = await projectNamed('docs');
    const space = await prisma.space.create({ data: { name: 'own-docs-old', createdById: 'own', members: { create: { userId: 'own', role: 'owner', addedById: 'own' } } } });
    const off = await writes.patchUserProjectFor(own, docs, { filesSpace: space.name });
    expect(off).toMatchObject({ status: 404, body: { code: 'project_files_disabled' } });
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: docs } })).filesSpaceId).toBeNull();
    files.on = true;
    try {
      const used = await writes.patchUserProjectFor(own, docs, { filesSpace: space.name });
      expect(used.status).toBe(200);
      expect((used.body as { filesSpace: unknown }).filesSpace).toEqual({ name: 'own-docs-old' });
      const sample = (await prisma.userProject.findFirstOrThrow({ where: { userId: 'own', nameKey: 'sample app' } })).id;
      const again = await writes.patchUserProjectFor(own, sample, { filesSpace: space.name });
      expect(again).toMatchObject({ status: 409, body: { code: 'space_in_use' } });
      expect((await writes.patchUserProjectFor(pal, docs, { filesSpace: space.name })).status).toBe(404);
    } finally {
      files.on = false;
    }
  });
});
