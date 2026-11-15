/**
 * The project record against a real Postgres:
 * ensureUserProjects groups a person's checkouts by repo set, is idempotent,
 * picks up a checkout made while the flag was off and makes one set of rows
 * under two concurrent calls; a new checkout attaches by repo set or to the
 * project its create named; Lab's Add repository on a checkout leaves the
 * project alone; deleting a checkout leaves its project. + New project
 * (createPersonUserProject) makes a project with no checkout, refusing a
 * name the person has, archived or not, ignoring case.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_user_projects_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_user_projects_${process.pid}$1`); });

const TERMAG = 'https://github.com/example-org/termag.git';
const DESKTOP = 'git@github.com:example-org/termag-desktop.git';
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

describe.skipIf(!adminUrl)('the project record against Postgres', () => {
  let up: typeof import('./userProjects');
  let prisma: typeof import('../db').prisma;
  let seq = 0;

  async function user(id: string) {
    await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
  }

  async function checkout(userId: string, opts: {
    repoUrl?: string; repos?: string[]; kind?: string; archived?: boolean; createdFor?: string; minute?: number;
  } = {}) {
    const n = ++seq;
    const minute = opts.minute ?? n;
    return prisma.project.create({
      data: {
        userId, name: `p${n}`, kind: opts.kind ?? 'normal', archived: opts.archived ?? false, createdFor: opts.createdFor ?? null,
        layout: opts.repos ? 'workspace' : 'repo', repoUrl: opts.repoUrl ?? null,
        createdAt: at(minute), lastActiveAt: at(minute),
        ...(opts.repos ? { repos: { create: opts.repos.map((url, position) => ({ name: `r${position}`, url, position })) } } : {}),
      },
    });
  }

  const projectOf = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id } })).userProjectId;
  const projectsOf = (userId: string) => prisma.userProject.findMany({
    where: { userId }, include: { repos: { orderBy: { position: 'asc' } } }, orderBy: { createdAt: 'asc' },
  });

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
    up = await import('./userProjects');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('groups every checkout of a repository on every box into one project, a workspace into its own, and leaves the other kinds out', async () => {
    await user('ada');
    const box1 = await checkout('ada', { repoUrl: TERMAG });
    const box2 = await checkout('ada', { repoUrl: 'https://github.com/Example-Org/termag' });
    const archived = await checkout('ada', { repoUrl: TERMAG, archived: true });
    const ask = await checkout('ada', { repoUrl: TERMAG, createdFor: 'ask' });
    const ws = await checkout('ada', { repos: [TERMAG, DESKTOP] });
    const scratch = await checkout('ada');
    const auto = await checkout('ada', { repoUrl: TERMAG, kind: 'automation' });
    const meta = await checkout('ada', { kind: 'metaterm' });
    const orch = await checkout('ada', { kind: 'space-orchestrator' });
    const archivedUpdatedAt = archived.updatedAt;

    expect(await up.ensureUserProjects('ada')).toEqual({ attached: 6, created: 3 });

    const projects = await projectsOf('ada');
    expect(projects.map(p => [p.name, p.nameKey, p.repoSetKey, p.origin])).toEqual([
      ['termag', 'termag', 'example-org/termag', 'backfill'],
      ['termag + termag-desktop', 'termag + termag-desktop', 'example-org/termag,example-org/termag-desktop', 'backfill'],
      ['Scratch', 'scratch', '', 'backfill'],
    ]);
    expect(projects[1].repos.map(r => [r.repoKey, r.url, r.position])).toEqual([
      ['example-org/termag', TERMAG, 0], ['example-org/termag-desktop', DESKTOP, 1],
    ]);
    const [termag, both, none] = projects.map(p => p.id);
    for (const c of [box1, box2, archived, ask]) expect(await projectOf(c.id)).toBe(termag);
    expect(await projectOf(ws.id)).toBe(both);
    expect(await projectOf(scratch.id)).toBe(none);
    for (const c of [auto, meta, orch]) expect(await projectOf(c.id)).toBeNull();
    // The archived checkout keeps its updatedAt: it is when it was archived.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: archived.id } })).updatedAt).toEqual(archivedUpdatedAt);

    // Idempotent.
    expect(await up.ensureUserProjects('ada')).toEqual({ attached: 0, created: 0 });
    expect(await prisma.userProject.count({ where: { userId: 'ada' } })).toBe(3);

    // A checkout made while the flag was off joins on the next read.
    const later = await checkout('ada', { repoUrl: TERMAG });
    expect(await up.ensureUserProjects('ada')).toEqual({ attached: 1, created: 0 });
    expect(await projectOf(later.id)).toBe(termag);
  });

  it('makes one set of rows under two concurrent first reads', async () => {
    await user('bo');
    for (let i = 0; i < 4; i++) await checkout('bo', { repoUrl: TERMAG });
    await checkout('bo', { repos: [TERMAG, DESKTOP] });
    const results = await Promise.all([up.ensureUserProjects('bo'), up.ensureUserProjects('bo'), up.ensureUserProjects('bo')]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.attached, 0)).toBe(5);
    expect(await prisma.userProject.count({ where: { userId: 'bo' } })).toBe(2);
    expect(await prisma.project.count({ where: { userId: 'bo', userProjectId: null } })).toBe(0);
  });

  it('attaches a new checkout to the project for its set, or makes one; a name clash gets " 2"', async () => {
    await user('cy');
    const first = await checkout('cy', { repoUrl: TERMAG });
    const termag = await up.attachCheckout('cy', first.id);
    const [made] = await projectsOf('cy');
    expect([made.id, made.name, made.origin]).toEqual([termag, 'termag', 'checkout']);

    const again = await checkout('cy', { repoUrl: 'git@github.com:example-org/termag.git' });
    expect(await up.attachCheckout('cy', again.id)).toBe(termag);

    // Another owner's termag is another set, so another project, and the name is taken.
    const fork = await checkout('cy', { repoUrl: 'https://github.com/someone/Termag' });
    const forkProject = await up.attachCheckout('cy', fork.id);
    expect(forkProject).not.toBe(termag);
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: forkProject! } })).name).toBe('Termag 2');

    // A no-repo checkout never joins a repository project.
    const blank = await checkout('cy');
    const blankProject = await up.attachCheckout('cy', blank.id);
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: blankProject! } })).repoSetKey).toBe('');

    // An automation has none.
    const auto = await checkout('cy', { repoUrl: TERMAG, kind: 'automation' });
    expect(await up.attachCheckout('cy', auto.id)).toBeNull();
    expect(await projectOf(auto.id)).toBeNull();
  });

  it("checks a project a create names: the caller's, unarchived, on the same set", async () => {
    await user('di');
    await user('ed');
    const mine = await checkout('di', { repos: [TERMAG, DESKTOP] });
    const project = (await up.attachCheckout('di', mine.id))!;
    const urls = [DESKTOP, 'https://github.com/example-org/termag'];

    expect(await up.checkRequestedUserProject('di', project, urls)).toEqual({ ok: true, id: project });
    expect(await up.checkRequestedUserProject('ed', project, urls)).toMatchObject({ ok: false, status: 404, code: 'user_project_not_found' });
    expect(await up.checkRequestedUserProject('di', 'nope', urls)).toMatchObject({ ok: false, status: 404 });
    expect(await up.checkRequestedUserProject('di', 42, urls)).toMatchObject({ ok: false, status: 400 });
    expect(await up.checkRequestedUserProject('di', project, [TERMAG])).toMatchObject({ ok: false, status: 409, code: 'user_project_repos_mismatch' });

    // A named create attaches there, even where an older project has the set.
    const older = await prisma.userProject.create({
      data: { userId: 'di', name: 'Older', nameKey: 'older', repoSetKey: 'example-org/termag', createdAt: at(0) },
    });
    const named = await prisma.userProject.create({ data: { userId: 'di', name: 'Named', nameKey: 'named', repoSetKey: 'example-org/termag' } });
    const c = await checkout('di', { repoUrl: TERMAG });
    expect(await up.attachCheckout('di', c.id, named.id)).toBe(named.id);
    const plain = await checkout('di', { repoUrl: TERMAG });
    expect(await up.attachCheckout('di', plain.id)).toBe(older.id);

    await prisma.userProject.update({ where: { id: project }, data: { archivedAt: new Date() } });
    expect(await up.checkRequestedUserProject('di', project, urls)).toMatchObject({ ok: false, status: 409, code: 'user_project_archived' });
  });

  it("leaves the project alone when Lab adds a repository to one checkout, and a later create still finds it", async () => {
    await user('fay');
    const one = await checkout('fay', { repos: [TERMAG, DESKTOP] });
    const project = (await up.attachCheckout('fay', one.id))!;
    // Lab's Add repository (POST /api/projects/:id/repos) is a ProjectRepo row on that checkout.
    await prisma.projectRepo.create({ data: { projectId: one.id, name: 'r9', url: 'https://github.com/example-org/dev', position: 2 } });
    await up.ensureUserProjects('fay');
    const after = await prisma.userProject.findUniqueOrThrow({ where: { id: project }, include: { repos: true } });
    expect(after.repoSetKey).toBe('example-org/termag,example-org/termag-desktop');
    expect(after.formerRepoSetKeys).toEqual([]);
    expect(after.repos).toHaveLength(2);
    expect(await projectOf(one.id)).toBe(project);
    const two = await checkout('fay', { repos: [DESKTOP, TERMAG] });
    expect(await up.attachCheckout('fay', two.id)).toBe(project);
  });

  it("finds a project by a set it had before a repository was added to it", async () => {
    await user('gus');
    const grown = await prisma.userProject.create({
      data: { userId: 'gus', name: 'termag', nameKey: 'termag', repoSetKey: 'example-org/termag,example-org/termag-desktop', formerRepoSetKeys: ['example-org/termag'] },
    });
    const c = await checkout('gus', { repoUrl: TERMAG });
    expect(await up.attachCheckout('gus', c.id)).toBe(grown.id);
  });

  it('sends checkouts back to an archived project once it is unarchived', async () => {
    await user('hal');
    const first = await checkout('hal', { repoUrl: TERMAG });
    const original = (await up.attachCheckout('hal', first.id))!;
    await prisma.userProject.update({ where: { id: original }, data: { archivedAt: new Date() } });
    const second = await checkout('hal', { repoUrl: TERMAG });
    const replacement = (await up.attachCheckout('hal', second.id))!;
    expect((await prisma.userProject.findUniqueOrThrow({ where: { id: replacement } })).name).toBe('termag 2');
    await prisma.userProject.update({ where: { id: original }, data: { archivedAt: null } });
    const third = await checkout('hal', { repoUrl: TERMAG });
    expect(await up.attachCheckout('hal', third.id)).toBe(original);
  });

  it('keeps the project when a checkout is deleted, and its name when a checkout is renamed', async () => {
    await user('ivy');
    const a = await checkout('ivy', { repoUrl: TERMAG });
    const b = await checkout('ivy', { repoUrl: TERMAG });
    await up.ensureUserProjects('ivy');
    const project = (await projectOf(a.id))!;
    await prisma.project.update({ where: { id: b.id }, data: { name: 'renamed' } });
    await prisma.project.delete({ where: { id: a.id } });
    const kept = await prisma.userProject.findUniqueOrThrow({ where: { id: project }, include: { checkouts: true } });
    expect(kept.name).toBe('termag');
    expect(kept.checkouts.map(c => c.id)).toEqual([b.id]);
    await prisma.project.delete({ where: { id: b.id } });
    expect(await prisma.userProject.count({ where: { id: project } })).toBe(1);
  });

  it('makes a project with + New project, with no checkout, and a first checkout naming it joins it', async () => {
    await user('jo');
    const plan = up.planNewUserProject({ name: 'Two repos', repos: [{ url: DESKTOP }, { url: TERMAG }] });
    if (!plan.ok) throw new Error(plan.error);
    const made = await up.createPersonUserProject('jo', plan.project);
    if (!made.ok) throw new Error('taken');
    const [row] = await projectsOf('jo');
    expect(row).toMatchObject({ id: made.id, name: 'Two repos', nameKey: 'two repos', origin: 'person', repoSetKey: 'example-org/termag,example-org/termag-desktop' });
    expect(row.repos.map(r => [r.repoKey, r.position])).toEqual([['example-org/termag-desktop', 0], ['example-org/termag', 1]]);
    const first = await checkout('jo', { repos: [DESKTOP, TERMAG] });
    expect(await up.attachCheckout('jo', first.id, made.id)).toBe(made.id);
  });

  it("refuses a name the person already has, ignoring case, saying whether it's archived; another person's doesn't count", async () => {
    await user('kit');
    await user('lee');
    const scratch = up.planNewUserProject({ name: 'Scratch' });
    if (!scratch.ok) throw new Error(scratch.error);
    const made = await up.createPersonUserProject('kit', scratch.project);
    if (!made.ok) throw new Error('taken');
    const again = up.planNewUserProject({ name: 'SCRATCH' });
    if (!again.ok) throw new Error(again.error);
    expect(await up.createPersonUserProject('kit', again.project)).toEqual({ ok: false, taken: { id: made.id, name: 'Scratch', archived: false } });
    await prisma.userProject.update({ where: { id: made.id }, data: { archivedAt: new Date() } });
    expect(await up.createPersonUserProject('kit', again.project)).toEqual({ ok: false, taken: { id: made.id, name: 'Scratch', archived: true } });
    expect((await up.createPersonUserProject('lee', again.project)).ok).toBe(true);
  });

  it('adds a repository to a project: new checkouts clone it, a create on the old set still finds it, and a ninth is refused', async () => {
    await user('max');
    const first = await checkout('max', { repoUrl: TERMAG });
    const project = (await up.attachCheckout('max', first.id))!;
    expect(await up.addUserProjectRepo('max', project, { url: DESKTOP, defaultBranch: 'main' })).toEqual({ ok: true });
    const grown = await prisma.userProject.findUniqueOrThrow({ where: { id: project }, include: { repos: { orderBy: { position: 'asc' } } } });
    expect(grown.repoSetKey).toBe('example-org/termag,example-org/termag-desktop');
    expect(grown.formerRepoSetKeys).toEqual(['example-org/termag']);
    expect(grown.repos.map(r => [r.repoKey, r.position, r.defaultBranch])).toEqual([['example-org/termag', 0, null], ['example-org/termag-desktop', 1, 'main']]);
    // The checkout it had keeps its one repository, and a new one on the old set still lands in the project.
    const old = await checkout('max', { repoUrl: TERMAG });
    expect(await up.attachCheckout('max', old.id)).toBe(project);
    const both = await checkout('max', { repos: [TERMAG, DESKTOP] });
    expect(await up.attachCheckout('max', both.id, project)).toBe(project);
    expect(await up.addUserProjectRepo('max', project, { url: TERMAG })).toMatchObject({ ok: false, code: 'user_project_repo_exists' });
    for (let i = 2; i < 8; i++) expect(await up.addUserProjectRepo('max', project, { url: `https://github.com/o/extra${i}` })).toEqual({ ok: true });
    expect(await up.addUserProjectRepo('max', project, { url: 'https://github.com/o/ninth' })).toMatchObject({ ok: false, status: 409, code: 'user_project_repo_limit' });
    expect(await up.addUserProjectRepo('nobody', project, { url: 'https://github.com/o/x' })).toMatchObject({ ok: false, status: 404 });
  });

  it('keeps a session in the project it named when a repository was added to it meanwhile, not an older one on the old set', async () => {
    await user('ned');
    const plan = (name: string) => { const p = up.planNewUserProject({ name, repos: [{ url: TERMAG }] }); if (!p.ok) throw new Error(p.error); return p.project; };
    const older = await up.createPersonUserProject('ned', plan('older'));
    const picked = await up.createPersonUserProject('ned', plan('picked'));
    if (!older.ok || !picked.ok) throw new Error('taken');
    // The create checked "picked" on termag alone; a repository lands on it before the checkout is attached.
    const made = await checkout('ned', { repoUrl: TERMAG });
    expect(await up.addUserProjectRepo('ned', picked.id, { url: DESKTOP })).toEqual({ ok: true });
    expect(await up.attachCheckout('ned', made.id, picked.id, up.repoSetKeyForUrls([TERMAG]))).toBe(picked.id);
    // Without naming it, the oldest project for the set still wins, as milestone 5's lookup says.
    const plain = await checkout('ned', { repoUrl: TERMAG });
    expect(await up.attachCheckout('ned', plain.id)).toBe(older.id);
  });

  it("keeps a no-repo session in the no-repo project it named when that project's first repository lands meanwhile", async () => {
    await user('ola');
    const plan = (name: string) => { const p = up.planNewUserProject({ name }); if (!p.ok) throw new Error(p.error); return p.project; };
    const scratch = await up.createPersonUserProject('ola', plan('Scratch'));
    const notes = await up.createPersonUserProject('ola', plan('Notes'));
    if (!scratch.ok || !notes.ok) throw new Error('taken');
    const made = await checkout('ola', {});
    expect(await up.addUserProjectRepo('ola', notes.id, { url: TERMAG })).toEqual({ ok: true });
    expect(await up.attachCheckout('ola', made.id, notes.id, '')).toBe(notes.id);
    // A create that named no set (or another) gets no such leeway.
    const other = await checkout('ola', {});
    expect(await up.attachCheckout('ola', other.id, notes.id, 'example-org/termag')).toBe(scratch.id);
  });
});
