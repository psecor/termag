/**
 * Project icons' rows against a real Postgres:
 * the same image is one row, an icon is served and chosen only by its owner, an
 * upload nothing shows is deleted, and a deleted image leaves its project
 * automatic.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_project_icons_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_project_icons_${process.pid}$1`); });

/** A distinct PNG per tag (the signature, then the tag): enough for the sniff, and a hash of its own. */
const img = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

describe.skipIf(!adminUrl)('project icons against Postgres', () => {
  let store: typeof import('./projectIconStore');
  let views: typeof import('./userProjectViews');
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
    store = await import('./projectIconStore');
    views = await import('./userProjectViews');
    for (const id of ['own', 'pal']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const project = (userId: string, name: string, repoKey = 'e2e-org/sample') => prisma.userProject.create({
    data: {
      userId, name, nameKey: name.toLowerCase(), repoSetKey: repoKey,
      repos: { create: [{ repoKey, url: `https://github.com/${repoKey}` }] },
    },
    select: { id: true },
  });

  it('stores an image once per repository, and reads it only for its owner', async () => {
    const a = await store.saveIcon('own', { data: img('red'), repoKey: 'e2e-org/sample', path: 'public/favicon.png' });
    const again = await store.saveIcon('own', { data: img('red'), repoKey: 'e2e-org/sample', path: 'static/favicon.png' });
    expect(a.ok && again.ok && a.id === again.id).toBe(true);
    expect(await prisma.projectIcon.count({ where: { userId: 'own' } })).toBe(1);
    const id = a.ok ? a.id : '';
    const row = await prisma.projectIcon.findUniqueOrThrow({ where: { id } });
    expect([row.userId, row.mimeType]).toEqual(['own', 'image/png']);
    // Only its owner's reads name it: another person's picker for the same repository lists none.
    expect((await store.repoIcons('pal', [{ repoKey: 'e2e-org/sample' }]))[0].candidates).toEqual([]);
    expect((await store.saveIcon('own', { data: Buffer.from('<svg><script>1</script></svg>') })).ok).toBe(false); // not an image it takes
  });

  it("chooses an image only of the caller's own, and the view says so", async () => {
    const p = await project('own', 'Sample');
    const mine = await store.saveIcon('own', { data: img('blue'), repoKey: 'e2e-org/sample', path: 'favicon.png' });
    const theirs = await store.saveIcon('pal', { data: img('green'), repoKey: 'e2e-org/sample', path: 'favicon.png' });
    if (!mine.ok || !theirs.ok) throw new Error('save failed');
    expect((await store.setProjectIcon('own', p.id, { ok: true, iconChoice: 'image', iconId: theirs.id })).status).toBe(404);
    expect((await store.setProjectIcon('pal', p.id, { ok: true, iconChoice: 'letter', iconId: null })).status).toBe(404);
    expect((await store.setProjectIcon('own', p.id, { ok: true, iconChoice: 'image', iconId: mine.id })).status).toBe(200);
    expect((await views.userProjectViewFor('own', p.id))?.icon).toMatchObject({ choice: 'image', imageId: mine.id });
    const picker = await store.projectIconsFor('own', p.id);
    expect(picker?.choice).toBe('image');
    expect(picker?.repos[0].candidates.map(c => c.path).sort()).toEqual(['favicon.png', 'public/favicon.png']);
    expect(picker?.repos[0].candidates.every(c => c.src.startsWith('data:image/png;base64,'))).toBe(true);
    // The project list carries the chosen image inline, as a data: URI.
    expect((await views.userProjectViewFor('own', p.id))?.icon.src).toBe(`data:image/png;base64,${img('blue').toString('base64')}`);
    expect(await store.projectIconsFor('pal', p.id)).toBeNull();
  });

  it('deletes an upload once no project shows it, and an image gone leaves its project automatic', async () => {
    const p = await project('own', 'Uploads', 'e2e-org/other');
    // An image of no repository (repoKey ""): what an upload stores (POST /icons, a later step).
    const up = await store.saveIcon('own', { data: img('purple') });
    if (!up.ok) throw new Error('upload failed');
    await store.setProjectIcon('own', p.id, { ok: true, iconChoice: 'image', iconId: up.id });
    expect((await store.projectIconsFor('own', p.id))?.upload?.id).toBe(up.id);
    // Choosing the letters drops the upload nothing else shows.
    await store.setProjectIcon('own', p.id, { ok: true, iconChoice: 'letter', iconId: null });
    expect(await prisma.projectIcon.findUnique({ where: { id: up.id } })).toBeNull();

    // A detected icon deleted under a project that shows it: automatic again, the repository's pointer cleared too.
    const fav = await store.saveIcon('own', { data: img('teal'), repoKey: 'e2e-org/other', path: 'favicon.png' });
    if (!fav.ok) throw new Error('save failed');
    await prisma.userProjectRepo.updateMany({ where: { userProjectId: p.id }, data: { iconId: fav.id } });
    await store.setProjectIcon('own', p.id, { ok: true, iconChoice: 'image', iconId: fav.id });
    await prisma.projectIcon.delete({ where: { id: fav.id } });
    const view = await views.userProjectViewFor('own', p.id);
    expect(view?.icon).toEqual({ choice: 'auto', imageId: null, src: null });
    expect(view?.repos[0].iconId).toBeNull();
  });
  it("takes rasters only as uploads, and deletes a person's old uploads nothing shows at their next one", async () => {
    // An ICO is an icon the repositories may have, but not an upload; an SVG isn't an image the store takes at all.
    expect(await store.saveUpload('pal', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toEqual({ ok: false, error: 'Upload a PNG, JPEG, GIF or WebP image' });
    expect((await store.saveUpload('pal', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).ok).toBe(false);
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([n])]);
    const p = await project('pal', 'Pal');
    const shown = await store.saveUpload('pal', png(1));
    const stale = await store.saveUpload('pal', png(2));
    if (!shown.ok || !stale.ok) throw new Error('upload failed');
    await store.setProjectIcon('pal', p.id, { ok: true, iconChoice: 'image', iconId: shown.id });
    await prisma.projectIcon.updateMany({ where: { id: { in: [shown.id, stale.id] } }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    expect((await store.saveUpload('pal', png(3))).ok).toBe(true);
    expect(await prisma.projectIcon.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.projectIcon.findUnique({ where: { id: shown.id } })).not.toBeNull();
  });
});
