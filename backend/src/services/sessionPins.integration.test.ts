/**
 * Session pins against a real Postgres: the caller's
 * own pins on sessions they can see, kept through an archive and a rename,
 * gone with the session, its project or the person.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_session_pins_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_session_pins_${process.pid}$1`); });

describe.skipIf(!adminUrl)('session pins against Postgres', () => {
  let pins: typeof import('./sessionPins');
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
    pins = await import('./sessionPins');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const ids = (list: Array<{ workstreamId: string }>) => list.map(p => p.workstreamId);

  it("keeps each person's pins to sessions they can see, through an archive and a rename, and drops them with the session", async () => {
    for (const id of ['own', 'pal', 'other']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    const mine = await prisma.project.create({ data: { name: 'sample', userId: 'own' } });
    const theirs = await prisma.project.create({ data: { name: 'secret', userId: 'other' } });
    const [main, side, gone] = await Promise.all(['main', 'side', 'gone'].map(name =>
      prisma.workstream.create({ data: { projectId: mine.id, name, branch: name } })));
    const private_ = await prisma.workstream.create({ data: { projectId: theirs.id, name: 'main', branch: 'main' } });
    await prisma.projectShare.create({ data: { projectId: mine.id, userId: 'pal' } });

    // Pinned in order; a second pin is the same pin.
    const first = await pins.pinSession('own', side.id);
    expect(first).toMatchObject({ ok: true, created: true, pin: { workstreamId: side.id, projectId: mine.id, workstream: 'side' } });
    expect(await pins.pinSession('own', main.id)).toMatchObject({ ok: true, created: true });
    const again = await pins.pinSession('own', side.id);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(again.ok && first.ok && again.pin.pinnedAt).toBe(first.ok && first.pin.pinnedAt);
    expect(ids(await pins.listSessionPins('own'))).toEqual([side.id, main.id]);

    // A collaborator pins the shared session for themselves only; nobody pins what they can't see.
    expect(await pins.pinSession('pal', main.id)).toMatchObject({ ok: true, created: true });
    expect(await pins.pinSession('pal', private_.id)).toMatchObject({ ok: false, status: 404, code: 'session_not_found' });
    expect(await pins.pinSession('own', 'no-such-session')).toMatchObject({ ok: false, status: 404 });
    expect(ids(await pins.listSessionPins('pal'))).toEqual([main.id]);
    expect(await pins.listSessionPins('other')).toEqual([]);

    // A rename keeps the pin, under its new name.
    await prisma.workstream.update({ where: { id: side.id }, data: { name: 'renamed' } });
    expect((await pins.listSessionPins('own'))[0]).toMatchObject({ workstreamId: side.id, workstream: 'renamed' });

    // Archived, it leaves the list but keeps its pin; reopened, it's back where it was.
    await prisma.workstream.update({ where: { id: side.id }, data: { archived: true } });
    expect(ids(await pins.listSessionPins('own'))).toEqual([main.id]);
    expect(await pins.pinSession('own', side.id)).toMatchObject({ ok: false, status: 409, code: 'session_archived' });
    await prisma.workstream.update({ where: { id: side.id }, data: { archived: false } });
    expect(ids(await pins.listSessionPins('own'))).toEqual([side.id, main.id]);
    await prisma.project.update({ where: { id: mine.id }, data: { archived: true } });
    expect(await pins.listSessionPins('own')).toEqual([]);
    await prisma.project.update({ where: { id: mine.id }, data: { archived: false } });

    // A revoked share hides the collaborator's pin.
    await prisma.projectShare.deleteMany({ where: { projectId: mine.id, userId: 'pal' } });
    expect(await pins.listSessionPins('pal')).toEqual([]);

    // Unpin is the caller's own and idempotent.
    expect(await pins.unpinSession('pal', side.id)).toBe(false);
    expect(await pins.unpinSession('own', side.id)).toBe(true);
    expect(await pins.unpinSession('own', side.id)).toBe(false);
    expect(ids(await pins.listSessionPins('own'))).toEqual([main.id]);

    // Deleting the session, or its project, deletes its pins.
    expect(await pins.pinSession('own', gone.id)).toMatchObject({ ok: true });
    await prisma.workstream.delete({ where: { id: gone.id } });
    expect(await prisma.sessionPin.count({ where: { workstreamId: gone.id } })).toBe(0);
    await prisma.project.delete({ where: { id: mine.id } });
    expect(await prisma.sessionPin.count()).toBe(0);
  });

  it('pins only what the sidebar lists: not MetaTerm, a space orchestrator or an automation\'s main', async () => {
    await prisma.user.create({ data: { id: 'kinds', googleId: 'g-kinds', googleEmail: 'kinds@example.com', unixUsername: 'kinds', displayName: 'kinds' } });
    const ws = async (kind: string, name: string) => {
      const p = await prisma.project.create({ data: { name: `${kind}-${name}`, userId: 'kinds', kind } });
      return prisma.workstream.create({ data: { projectId: p.id, name, branch: name } });
    };
    const run = await ws('automation', 'run-1');
    const autoMain = await ws('automation', 'main');
    const meta = await ws('metaterm', 'main');
    const orch = await ws('space-orchestrator', 'main');
    expect(await pins.pinSession('kinds', run.id)).toMatchObject({ ok: true });
    for (const w of [autoMain, meta, orch]) {
      expect(await pins.pinSession('kinds', w.id)).toMatchObject({ ok: false, status: 404, code: 'session_not_found' });
    }
    // A pin made some other way on one is never listed.
    await prisma.sessionPin.create({ data: { userId: 'kinds', workstreamId: meta.id } });
    expect(ids(await pins.listSessionPins('kinds'))).toEqual([run.id]);
  });

  it('deletes them with the person, and leaves the session', async () => {
    for (const id of ['host', 'leaver']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    const p = await prisma.project.create({ data: { name: 'x', userId: 'host' } });
    const ws = await prisma.workstream.create({ data: { projectId: p.id, name: 'main', branch: 'main' } });
    await prisma.projectShare.create({ data: { projectId: p.id, userId: 'leaver' } });
    expect(await pins.pinSession('leaver', ws.id)).toMatchObject({ ok: true });
    await prisma.user.delete({ where: { id: 'leaver' } });
    expect(await prisma.sessionPin.count({ where: { userId: 'leaver' } })).toBe(0);
    expect(await prisma.workstream.count({ where: { id: ws.id } })).toBe(1);
  });
});
