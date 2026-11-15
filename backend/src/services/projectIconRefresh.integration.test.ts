/**
 * Looking for a repository's icons, against a real Postgres:
 * what's found is
 * stored and the best becomes every one of the person's projects' detected
 * icon for it; one gone is deleted unless a project shows it; no token reads
 * and stamps nothing; a repository looked at is left for a week.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';
import type { Detected } from './projectIconDetect';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_project_icon_refresh_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_project_icon_refresh_${process.pid}$1`); });
const push = vi.hoisted(() => ({ notifyWorkspaceChange: vi.fn() }));
vi.mock('./workspaceEvents', () => push);

/** A distinct PNG per tag (the signature, then the tag): enough for the sniff, and a hash of its own. */
const img = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const REPO = 'e2e-org/sample';
const DAY = 86_400_000;

describe.skipIf(!adminUrl)('looking for icons against Postgres', () => {
  let refresh: typeof import('./projectIconRefresh');
  let store: typeof import('./projectIconStore');
  let prisma: typeof import('../db').prisma;
  let found: Detected;
  const detect = vi.fn(async () => found);
  const token = vi.fn(async (): Promise<string | null> => 'gho_x');
  let now = Date.UTC(2026, 10, 14);
  const deps = () => ({ detect, token, now: () => now });

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const res = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`db push failed: ${res.stderr}`);
    ({ prisma } = await import('../db'));
    refresh = await import('./projectIconRefresh');
    store = await import('./projectIconStore');
    await prisma.user.create({ data: { id: 'own', googleId: 'g-own', googleEmail: 'own@example.com', unixUsername: 'own', displayName: 'own' } });
    for (const name of ['One', 'Two']) {
      await prisma.userProject.create({
        data: { userId: 'own', name, nameKey: name.toLowerCase(), repoSetKey: REPO, repos: { create: [{ repoKey: REPO, url: `https://github.com/${REPO}` }] } },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  beforeEach(() => { refresh.forgetIconLooks(); vi.clearAllMocks(); });

  const repos = () => prisma.userProjectRepo.findMany({ where: { repoKey: REPO }, select: { iconId: true, iconsCheckedAt: true } });

  it('reads and stamps nothing with no token connected, so connecting one later finds them', async () => {
    token.mockResolvedValueOnce(null);
    expect(await refresh.refreshRepoIcons('own', REPO, deps())).toEqual({ outcome: 'no-token', changed: false });
    expect(detect).not.toHaveBeenCalled();
    expect((await repos()).every(r => r.iconsCheckedAt === null)).toBe(true);
  });

  it("stores what's found and makes the best every project's detected icon for the repository", async () => {
    found = { status: 'ok', icons: [{ path: 'public/favicon.png', data: img('red'), score: 100 }, { path: 'logo.png', data: img('blue'), score: 60 }] };
    expect(await refresh.refreshRepoIcons('own', REPO, deps())).toEqual({ outcome: 'found', changed: true });
    const best = await prisma.projectIcon.findFirst({ where: { userId: 'own', path: 'public/favicon.png' } });
    const rows = await repos();
    expect(rows.map(r => r.iconId)).toEqual([best!.id, best!.id]);
    expect(rows.every(r => r.iconsCheckedAt?.getTime() === now)).toBe(true);
    expect(await prisma.projectIcon.count({ where: { userId: 'own', repoKey: REPO } })).toBe(2);
  });

  it('is due again only after a week, and the background look pushes projects when an icon changed', async () => {
    expect(refresh.iconsDue(new Date(now), now + 6 * DAY)).toBe(false);
    expect(refresh.iconsDue(new Date(now), now + 7 * DAY)).toBe(true);
    await refresh.refreshDueIconsInBackground('own', deps());
    expect(detect).not.toHaveBeenCalled();

    now += 8 * DAY;
    found = { status: 'ok', icons: [{ path: 'favicon.ico', data: img('green'), score: 70 }] };
    await refresh.refreshDueIconsInBackground('own', deps());
    expect(detect).toHaveBeenCalledTimes(1);
    expect(push.notifyWorkspaceChange).toHaveBeenCalledWith('own', 'projects');
    // The candidates it no longer finds are gone: nothing showed them.
    expect((await prisma.projectIcon.findMany({ where: { userId: 'own', repoKey: REPO } })).map(i => i.path)).toEqual(['favicon.ico']);
  });

  it('keeps a candidate a project shows when the repository drops it', async () => {
    const project = await prisma.userProject.findFirstOrThrow({ where: { name: 'One' } });
    const shown = await prisma.projectIcon.findFirstOrThrow({ where: { userId: 'own', path: 'favicon.ico' } });
    await store.setProjectIcon('own', project.id, { ok: true, iconChoice: 'image', iconId: shown.id });
    now += 8 * DAY;
    found = { status: 'ok', icons: [] };
    expect(await refresh.refreshRepoIcons('own', REPO, deps())).toEqual({ outcome: 'none', changed: true });
    expect(await prisma.projectIcon.findUnique({ where: { id: shown.id } })).not.toBeNull();
    expect((await repos()).every(r => r.iconId === null)).toBe(true);
  });

  it("leaves what's stored when GitHub fails, and doesn't ask again within the hour", async () => {
    now += 8 * DAY;
    found = { status: 'error', why: 'GitHub answered 502' };
    const before = await repos();
    expect(await refresh.refreshRepoIcons('own', REPO, deps())).toEqual({ outcome: 'error', changed: false });
    expect(await repos()).toEqual(before);
    await refresh.refreshForPicker('own', [REPO], { deps: deps() });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("New project's picker looks at a repository no project has yet, then reuses that look for the project made from it", async () => {
    found = { status: 'ok', icons: [{ path: 'favicon.png', data: img('pink'), score: 100 }] };
    await refresh.refreshForPicker('own', ['e2e-org/new'], { deps: deps() });
    expect(detect).toHaveBeenCalledWith('e2e-org/new', 'gho_x', expect.anything());
    const best = refresh.lastBestIcon('own', 'e2e-org/new');
    expect(best).not.toBeNull();
    const made = await prisma.userProject.create({
      data: { userId: 'own', name: 'New', nameKey: 'new', repoSetKey: 'e2e-org/new', repos: { create: [{ repoKey: 'e2e-org/new', url: 'https://github.com/e2e-org/new' }] } },
      select: { repos: { select: { id: true } } },
    });
    await refresh.refreshForPicker('own', ['e2e-org/new'], { deps: deps() });
    expect(detect).toHaveBeenCalledTimes(1);
    expect((await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: made.repos[0].id } })).iconId).toBe(best);
  });
  it('reads at most two repositories at once, handing a finished slot straight to the next', async () => {
    let live = 0;
    let most = 0;
    const slow = vi.fn(async (): Promise<Detected> => {
      live++; most = Math.max(most, live);
      await new Promise(r => setTimeout(r, 30));
      live--;
      return { status: 'ok', icons: [] };
    });
    const keys = ['e2e-org/c1', 'e2e-org/c2', 'e2e-org/c3', 'e2e-org/c4', 'e2e-org/c5'];
    await refresh.refreshForPicker('own', keys, { deps: { detect: slow, token, now: () => now }, waitMs: 5000 });
    expect(slow).toHaveBeenCalledTimes(5);
    expect(most).toBe(2);
  });

  it("looks again at once when GitHub is connected, not after the no-token hold", async () => {
    token.mockResolvedValueOnce(null);
    await refresh.refreshForPicker('own', ['e2e-org/later'], { deps: deps() });
    expect(detect).not.toHaveBeenCalled();
    await refresh.refreshForPicker('own', ['e2e-org/later'], { deps: deps() });
    expect(detect).not.toHaveBeenCalled();
    // What credentialStore's change event calls (onGithubCredentialChange).
    refresh.forgetLooksOf('own');
    found = { status: 'ok', icons: [] };
    await refresh.refreshForPicker('own', ['e2e-org/later'], { deps: deps() });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("gives a new project's repository its siblings' icon while it can't look, so Automatic stays what the picker showed", async () => {
    const shown = await store.saveIcon('own', { data: img('navy'), repoKey: 'e2e-org/kept', path: 'favicon.png' });
    if (!shown.ok) throw new Error('save failed');
    const make = (name: string) => prisma.userProject.create({
      data: { userId: 'own', name, nameKey: name.toLowerCase(), repoSetKey: 'e2e-org/kept', repos: { create: [{ repoKey: 'e2e-org/kept', url: 'https://github.com/e2e-org/kept' }] } },
      select: { repos: { select: { id: true } } },
    });
    const first = await make('Kept one');
    await prisma.userProjectRepo.update({ where: { id: first.repos[0].id }, data: { iconId: shown.id, iconsCheckedAt: new Date(now) } });
    const second = await make('Kept two');
    token.mockResolvedValueOnce(null);
    expect(await refresh.refreshRepoIcons('own', 'e2e-org/kept', deps())).toEqual({ outcome: 'no-token', changed: true });
    const row = await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: second.repos[0].id } });
    // The icon, not the look's time: it's still due, so the next look that can run reads the repository for it.
    expect([row.iconId, row.iconsCheckedAt]).toEqual([shown.id, null]);

    // Held back after that no-token look, a third project still takes the icon, through the picker, without a look.
    const third = await make('Kept three');
    await refresh.refreshForPicker('own', ['e2e-org/kept'], { deps: deps() });
    expect(detect).not.toHaveBeenCalled();
    expect((await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: third.repos[0].id } })).iconId).toBe(shown.id);
  });

  it("makes a repository whose look found nothing due again when the token changes, and drops a look begun under the old one", async () => {
    const made = await prisma.userProject.create({
      data: { userId: 'own', name: 'Locked', nameKey: 'locked', repoSetKey: 'e2e-org/locked', repos: { create: [{ repoKey: 'e2e-org/locked', url: 'https://github.com/e2e-org/locked' }] } },
      select: { repos: { select: { id: true } } },
    });
    found = { status: 'no-access' };
    expect((await refresh.refreshRepoIcons('own', 'e2e-org/locked', deps())).outcome).toBe('none');
    expect((await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: made.repos[0].id } })).iconsCheckedAt).not.toBeNull();
    await refresh.credentialChanged('own');
    expect((await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: made.repos[0].id } })).iconsCheckedAt).toBeNull();

    // A look still in flight when the token changes records nothing of the old token.
    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<Detected>(r => { release = () => r({ status: 'ok', icons: [] }); }));
    const pending = refresh.refreshRepoIcons('own', 'e2e-org/locked', { ...deps(), detect: slow });
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    found = { status: 'ok', icons: [] };
    await refresh.credentialChanged('own');
    release();
    expect((await pending).outcome).toBe('error');
    expect(refresh.lastBestIcon('own', 'e2e-org/locked')).toBeUndefined();
    // Nor did it stamp the row credentialChanged made due again: the new token's look still has it to do.
    expect((await prisma.userProjectRepo.findUniqueOrThrow({ where: { id: made.repos[0].id } })).iconsCheckedAt).toBeNull();
  });

  it('looks at once, past the once-a-minute throttle, when asked to (a project just made)', async () => {
    found = { status: 'ok', icons: [] };
    await refresh.refreshDueIconsInBackground('own', deps());
    const calls = detect.mock.calls.length;
    await prisma.userProject.create({
      data: { userId: 'own', name: 'Fresh', nameKey: 'fresh', repoSetKey: 'e2e-org/fresh', repos: { create: [{ repoKey: 'e2e-org/fresh', url: 'https://github.com/e2e-org/fresh' }] } },
    });
    await refresh.refreshDueIconsInBackground('own', deps());
    expect(detect.mock.calls.length).toBe(calls);
    await refresh.refreshDueIconsInBackground('own', deps(), { force: true });
    expect(detect.mock.calls.map(c => c[0])).toContain('e2e-org/fresh');
  });
});
