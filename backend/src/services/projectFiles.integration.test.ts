/**
 * Project files and My files against a real Postgres:
 * ensureProjectFiles and
 * ensureMyFiles make one space under concurrent calls, named as specified,
 * clashes included; a capable box gets its projects' files and My files, an
 * older one nothing; a hello grants every project with a live checkout there;
 * the opt-out removes My files' grants and no later grant adds it back; "Use
 * an existing space" refuses a space already in a role (409 space_in_use),
 * and keeps the space it replaces; a box gets nothing while a box below it
 * (which inherits its grants) can't address the new spaces.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_project_files_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_project_files_${process.pid}$1`); });

const flags = vi.hoisted(() => ({ on: true }));
vi.mock('./featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./featureFlags')>()),
  boolVariation: vi.fn(async (key: string, _u: unknown, fallback: boolean) =>
    (key === 'user-projects-enabled' || key === 'project-files-enabled' ? flags.on : fallback)),
}));
// The boxes whose agents are connected now, for grantMyFilesEverywhere.
const connected = vi.hoisted(() => ({
  boxes: [] as Array<{ instance: { id: string; name: string; kind: string; userId: string }; user: { id: string }; agentCommit: null; capabilities: string[] }>,
  /** What each box's agent announced, for heirsCanAddress; absent is not connected. */
  agents: new Map<string, string[]>(),
}));
vi.mock('./agentRegistry', () => ({
  connectedOwnedBoxes: () => connected.boxes,
  connectedInstanceIds: () => connected.boxes.map(b => b.instance.id),
  instanceAgentTransport: (id: string) => (connected.agents.has(id) ? { capabilities: connected.agents.get(id), helloReceived: true } : null),
  onBoxAgentHello: () => () => {},
}));

const CAPABLE = ['chat-runner-v1', 'project-files-v1'];

describe.skipIf(!adminUrl)('Project files and My files against Postgres', () => {
  let pf: typeof import('./projectFiles');
  let prisma: typeof import('../db').prisma;
  let seq = 0;

  async function person(unix: string) {
    return prisma.user.create({
      data: { id: unix, googleId: `g-${unix}`, googleEmail: `${unix}@example.com`, unixUsername: unix, displayName: unix },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
  }
  async function project(userId: string, name: string) {
    return prisma.userProject.create({ data: { userId, name, nameKey: name.toLowerCase(), repoSetKey: `set-${++seq}` } });
  }
  async function box(userId: string, parentInstanceId: string | null = null, status = 'ready') {
    const id = `box-${++seq}`;
    await prisma.instance.create({ data: { id, name: id, userId, status, kind: 'ec2', parentInstanceId } });
    return { id, name: id, kind: 'ec2', userId };
  }
  async function checkoutOn(userId: string, boxId: string, userProjectId: string, archived = false) {
    return prisma.project.create({ data: { userId, name: `c${++seq}`, kind: 'normal', instanceId: boxId, userProjectId, archived } });
  }
  const grantsOf = async (boxId: string) => (await prisma.spaceBox.findMany({ where: { instanceId: boxId }, select: { space: { select: { name: true } } } }))
    .map(g => g.space.name).sort();

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
    pf = await import('./projectFiles');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('makes one Project files under concurrent calls, owned by the person, and the same one after', async () => {
    const ana = await person('ana');
    const termag = await project(ana.id, 'termag');
    const made = await Promise.all([1, 2, 3, 4].map(() => pf.ensureProjectFiles(termag.id, ana.id)));
    expect(new Set(made.map(s => s?.id)).size).toBe(1);
    expect(made[0]!.name).toBe('ana-termag');
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: termag.id } })).filesSpaceId).toBe(made[0]!.id);
    expect(await prisma.spaceMember.findMany({ where: { spaceId: made[0]!.id }, select: { userId: true, role: true } })).toEqual([{ userId: 'ana', role: 'owner' }]);
    expect(await pf.ensureProjectFiles(termag.id, ana.id)).toEqual(made[0]);
    // Not hers: nothing made.
    const bo = await person('bo');
    expect(await pf.ensureProjectFiles(termag.id, bo.id)).toBeNull();
  });

  it('takes the next name on a clash across termag, and a new space once the old one is deleted', async () => {
    const cy = await person('cy');
    await prisma.space.create({ data: { name: 'cy-docs', createdById: 'someone-else' } });
    const docs = await project(cy.id, 'Docs');
    expect((await pf.ensureProjectFiles(docs.id, cy.id))!.name).toBe('cy-docs-2');
    const other = await project(cy.id, 'docs!');
    expect((await pf.ensureProjectFiles(other.id, cy.id))!.name).toBe('cy-docs-3');
    const first = (await prisma.userProject.findUniqueOrThrow({ where: { id: docs.id } })).filesSpaceId!;
    await prisma.space.update({ where: { id: first }, data: { deletedAt: new Date(), name: `deleted:${first}` } });
    const again = await pf.ensureProjectFiles(docs.id, cy.id);
    expect(again!.id).not.toBe(first);
    expect(again!.name).toBe('cy-docs-2');
  });

  it('makes one My files under concurrent calls, and says only the first made it', async () => {
    const di = await person('di');
    const made = await Promise.all([1, 2, 3].map(() => pf.ensureMyFiles(di.id)));
    expect(new Set(made.map(m => m!.space.id)).size).toBe(1);
    expect(made.filter(m => m!.made)).toHaveLength(1);
    expect(made[0]!.space.name).toBe('di-my-files');
    expect(await pf.myFilesSpaceName(di.id)).toBe('di-my-files');
  });

  it('grants a capable box its project\'s files and My files at session start, and an older box nothing', async () => {
    const ed = await person('ed');
    const app = await project(ed.id, 'app');
    const capable = await box(ed.id);
    const older = await box(ed.id);
    const granted = await pf.grantFilesToBox(ed, capable, CAPABLE, [app.id]);
    expect(granted.projects.get(app.id)?.name).toBe('ed-app');
    expect(granted.mine?.name).toBe('ed-my-files');
    expect(await grantsOf(capable.id)).toEqual(['ed-app', 'ed-my-files']);
    // Idempotent: again changes nothing.
    await pf.grantFilesToBox(ed, capable, CAPABLE, [app.id]);
    expect(await grantsOf(capable.id)).toEqual(['ed-app', 'ed-my-files']);
    // No capability, the flag off, or someone else's box: nothing.
    expect((await pf.grantFilesToBox(ed, older, ['chat-runner-v1'], [app.id])).projects.size).toBe(0);
    flags.on = false;
    expect((await pf.grantFilesToBox(ed, older, CAPABLE, [app.id])).projects.size).toBe(0);
    flags.on = true;
    const fay = await person('fay');
    expect((await pf.grantFilesToBox(fay, older, CAPABLE, [app.id])).projects.size).toBe(0);
    expect(await grantsOf(older.id)).toEqual([]);
  });

  it('grants every project with a live checkout on a capable hello, and My files', async () => {
    const gus = await person('gus');
    const web = await project(gus.id, 'web');
    const api = await project(gus.id, 'api');
    const gone = await project(gus.id, 'gone');
    const b = await box(gus.id);
    await checkoutOn(gus.id, b.id, web.id);
    await checkoutOn(gus.id, b.id, api.id);
    await checkoutOn(gus.id, b.id, gone.id, true);
    await pf.grantOnHello(gus, b, CAPABLE);
    expect(await grantsOf(b.id)).toEqual(['gus-api', 'gus-my-files', 'gus-web']);
    // A hello without the capability grants nothing.
    const old = await box(gus.id);
    await checkoutOn(gus.id, old.id, web.id);
    await pf.grantOnHello(gus, old, ['chat-runner-v1']);
    expect(await grantsOf(old.id)).toEqual([]);
  });

  it('turning My files off removes its grants and keeps the space; no later grant adds it back; on grants it again', async () => {
    const hal = await person('hal');
    const p = await project(hal.id, 'p');
    const b1 = await box(hal.id);
    const b2 = await box(hal.id);
    await pf.grantFilesToBox(hal, b1, CAPABLE, [p.id]);
    await pf.grantFilesToBox(hal, b2, CAPABLE, [p.id]);
    connected.boxes = [b1, b2].map(b => ({ instance: b, user: { id: hal.id }, agentCommit: null, capabilities: CAPABLE }));
    await pf.setMyFilesOnBoxes(hal, false);
    expect(await grantsOf(b1.id)).toEqual(['hal-p']);
    expect(await grantsOf(b2.id)).toEqual(['hal-p']);
    expect(await pf.myFilesSpaceName(hal.id)).toBe('hal-my-files');
    // A session start while it's off: Project files only.
    const granted = await pf.grantFilesToBox(hal, b1, CAPABLE, [p.id]);
    expect(granted.mine).toBeNull();
    expect(await grantsOf(b1.id)).toEqual(['hal-p']);
    await pf.setMyFilesOnBoxes(hal, true);
    expect(await grantsOf(b1.id)).toEqual(['hal-my-files', 'hal-p']);
    expect(await grantsOf(b2.id)).toEqual(['hal-my-files', 'hal-p']);
    connected.boxes = [];
  });

  it('uses an existing space for a project or as My files, once per role (409 space_in_use), and only one you own', async () => {
    const ivy = await person('ivy');
    const jo = await person('jo');
    const owned = await prisma.space.create({ data: { name: 'ivy-shared', createdById: ivy.id, members: { create: [{ userId: ivy.id, role: 'owner', addedById: ivy.id }, { userId: jo.id, role: 'owner', addedById: ivy.id }] } } });
    const viewerOnly = await prisma.space.create({ data: { name: 'jo-team', createdById: jo.id, members: { create: [{ userId: jo.id, role: 'owner', addedById: jo.id }, { userId: ivy.id, role: 'viewer', addedById: jo.id }] } } });
    const one = await project(ivy.id, 'one');
    const two = await project(ivy.id, 'two');
    expect(await pf.useExistingSpace(ivy, { kind: 'project', userProjectId: one.id }, 'nope')).toMatchObject({ ok: false, status: 404 });
    expect(await pf.useExistingSpace(ivy, { kind: 'project', userProjectId: one.id }, viewerOnly.name)).toMatchObject({ ok: false, status: 403, code: 'space_not_owned' });
    expect(await pf.useExistingSpace(ivy, { kind: 'project', userProjectId: one.id }, owned.name)).toMatchObject({ ok: true, space: { id: owned.id } });
    // The second assignment of the same space: another project, or anyone's My files.
    expect(await pf.useExistingSpace(ivy, { kind: 'project', userProjectId: two.id }, owned.name)).toMatchObject({ ok: false, status: 409, code: 'space_in_use' });
    expect(await pf.useExistingSpace(ivy, { kind: 'mine' }, owned.name)).toMatchObject({ ok: false, status: 409, code: 'space_in_use' });
    expect(await pf.useExistingSpace(jo, { kind: 'mine' }, owned.name)).toMatchObject({ ok: false, status: 409, code: 'space_in_use' });
    // Again for the same project: nothing to do.
    expect(await pf.useExistingSpace(ivy, { kind: 'project', userProjectId: one.id }, owned.name)).toMatchObject({ ok: true, previous: null });
    // Both at once for two projects: one wins.
    const spare = await prisma.space.create({ data: { name: 'ivy-spare', createdById: ivy.id, members: { create: { userId: ivy.id, role: 'owner', addedById: ivy.id } } } });
    const three = await project(ivy.id, 'three');
    const raced = await Promise.all([two, three].map(p => pf.useExistingSpace(ivy, { kind: 'project', userProjectId: p.id }, spare.name)));
    expect(raced.filter(r => r.ok)).toHaveLength(1);
    expect(raced.filter(r => !r.ok && r.code === 'space_in_use')).toHaveLength(1);
  });

  it('keeps the space it replaces, with its sessions, whether termag made it or not', async () => {
    const kim = await person('kim');
    const p = await project(kim.id, 'site');
    const made = (await pf.ensureProjectFiles(p.id, kim.id))!;
    const c = await prisma.project.create({ data: { userId: kim.id, name: 'site-co', kind: 'normal', userProjectId: p.id } });
    const ws = await prisma.workstream.create({ data: { projectId: c.id, name: 'main', branch: 'main', spaceId: made.id, spaceFixedAt: new Date() } });
    const old = await prisma.space.create({ data: { name: 'kim-site-old', createdById: kim.id, members: { create: { userId: kim.id, role: 'owner', addedById: kim.id } } } });
    expect(await pf.useExistingSpace(kim, { kind: 'project', userProjectId: p.id }, old.name)).toMatchObject({ ok: true, previous: made.id });
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: p.id } })).filesSpaceId).toBe(old.id);
    // Empty and termag's own, it still stays: an upload could be signed into it in the moment before a delete.
    expect((await prisma.space.findUniqueOrThrow({ where: { id: made.id } })).deletedAt).toBeNull();
    expect((await prisma.workstream.findUniqueOrThrow({ where: { id: ws.id } })).spaceId).toBe(made.id);
    // Freed, it can take a role again.
    const q = await project(kim.id, 'blog');
    expect(await pf.useExistingSpace(kim, { kind: 'project', userProjectId: q.id }, made.name)).toMatchObject({ ok: true });
  });

  it('grants nothing to a box while a box below it can\'t address the new spaces', async () => {
    const nia = await person('nia');
    const p = await project(nia.id, 'kids');
    const parent = await box(nia.id);
    const child = await box(nia.id, parent.id);
    await box(nia.id, child.id, 'terminated');
    // The child's agent isn't connected (it can't say), then is older, then announces the capability.
    expect((await pf.grantFilesToBox(nia, parent, CAPABLE, [p.id])).projects.size).toBe(0);
    connected.agents.set(child.id, ['chat-runner-v1']);
    expect((await pf.grantFilesToBox(nia, parent, CAPABLE, [p.id])).projects.size).toBe(0);
    expect(await grantsOf(parent.id)).toEqual([]);
    connected.agents.set(child.id, CAPABLE);
    expect((await pf.grantFilesToBox(nia, parent, CAPABLE, [p.id])).projects.get(p.id)?.name).toBe('nia-kids');
    expect(await grantsOf(parent.id)).toEqual(['nia-kids', 'nia-my-files']);
    // A grandchild counts too; a terminated box (and below it) passes nothing on, so doesn't.
    const grandchild = await box(nia.id, child.id);
    expect(await pf.heirsCanAddress(parent)).toBe(false);
    connected.agents.set(grandchild.id, CAPABLE);
    expect(await pf.heirsCanAddress(parent)).toBe(true);
    connected.agents.clear();
  });

  it('gives a chat turn its files only on a capable box, granting them first', async () => {
    const lu = await person('lu');
    const p = await project(lu.id, 'cli');
    const b = await box(lu.id);
    const c = await checkoutOn(lu.id, b.id, p.id);
    const ws = await prisma.workstream.create({ data: { projectId: c.id, name: 'main', branch: 'main' } });
    expect(await pf.turnFilesFor(ws.id, ['chat-runner-v1'])).toBeUndefined();
    expect(await grantsOf(b.id)).toEqual([]);
    expect(await pf.turnFilesFor(ws.id, CAPABLE)).toEqual({ project: 'lu-cli', mine: 'lu-my-files' });
    expect(await grantsOf(b.id)).toEqual(['lu-cli', 'lu-my-files']);
    flags.on = false;
    expect(await pf.turnFilesFor(ws.id, CAPABLE)).toBeUndefined();
    flags.on = true;
  });

  it('says where a space is for files.saved', async () => {
    const mo = await person('mo');
    const p = await project(mo.id, 'x');
    const files = (await pf.ensureProjectFiles(p.id, mo.id))!;
    const mine = (await pf.ensureMyFiles(mo.id))!.space;
    const plain = await prisma.space.create({ data: { name: 'mo-plain', createdById: mo.id } });
    expect(await pf.filesLocation(files.id)).toBe('project-files');
    expect(await pf.filesLocation(mine.id)).toBe('my-files');
    expect(await pf.filesLocation(plain.id)).toBe('other');
  });
});
