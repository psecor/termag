/**
 * Preview links and their audience core against a real Postgres: the name's
 * advisory lock and the store's writes, ending a project's audiences ends
 * its links (the end hook), and deleting the project cascades the audience,
 * the link and its sessions away while the name's reservation stays, its
 * linkId set null (SR19).
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_previews_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_previews_${process.pid}$1`); });
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: () => true, projectAgentCapabilities: () => ['preview-link-v1'], sendForProject: async () => ({ listeners: [] }) }));

const T0 = new Date('2026-11-04T12:00:00Z');
const HOUR = 3600_000;

describe.skipIf(!adminUrl)('preview links against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let links: typeof import('./previewLinks');
  let core: typeof import('./previewAudience');
  let deps: import('./previewLinks').PreviewLinkDeps;
  const revoked: string[][] = [];

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
    links = await import('./previewLinks');
    core = await import('./previewAudience');
    for (const id of ['alice', 'bob']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    await prisma.project.create({ data: { id: 'proj0001', name: 'app', userId: 'alice' } });
    deps = {
      ...links.defaultPreviewLinkDeps,
      enabled: async () => true, audiencesOn: async () => true, ttlDefault: async () => 24,
      now: () => T0, onSessionsRevoked: (_l, ids) => { revoked.push(ids); },
    };
    core.resetPreviewDeliveries();
    links.installPreviewLinkDelivery(deps);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const caller = { id: 'alice', googleEmail: 'alice@example.com' };

  it('publishes a people link: an audience with its grantee, and the link with its own fields', async () => {
    const r = await links.publishPreviewLinkFor(deps, caller, 'proj0001', { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@example.com'], ttlHours: 2 });
    expect(r.status).toBe(201);
    const link = await prisma.previewLink.findUniqueOrThrow({ where: { id: (r.body as any).link.id }, include: { audience: { include: { grantees: true } } } });
    expect(link).toMatchObject({ name: 'my-app', port: 5173, hostMode: 'localhost', linkTokenHash: null });
    expect(link.audience).toMatchObject({ projectId: 'proj0001', ownerId: 'alice', kind: 'people', expiresAt: new Date(T0.getTime() + 2 * HOUR), endedAt: null });
    expect(link.audience.grantees.map(g => g.userId)).toEqual(['bob']);
    const events = await prisma.previewAudienceEvent.findMany({ where: { audienceId: link.audienceId } });
    expect(events).toEqual([expect.objectContaining({ kind: 'created', actorId: 'alice', deliveryKind: 'link', deliveryId: link.id })]);
  });

  it('removes a viewer under the core\'s column name, and lists them', async () => {
    const link = await prisma.previewLink.findFirstOrThrow({ where: { name: 'my-app' } });
    expect((await links.removePreviewLinkViewerFor(deps, caller, link.id, 'bob')).status).toBe(200);
    // Removing a viewer drops their grant too: only naming them again lets them back in.
    expect(await core.audienceStandingOf(link.audienceId, 'bob', T0)).toEqual({ hasGrant: false, removed: true });
    expect(await prisma.previewAudienceGrantee.count({ where: { audienceId: link.audienceId } })).toBe(0);
    const list = await links.listPreviewLinksFor(deps, caller, 'proj0001');
    expect((list.body as any).links[0].viewers).toEqual([expect.objectContaining({ id: 'bob', revokedAt: T0.toISOString() })]);
  });

  it("lists a collaborator's live link to the project's owner, and keeps the owner's out of the collaborator's renew", async () => {
    await prisma.projectShare.create({ data: { projectId: 'proj0001', userId: 'bob' } });
    const bob = { id: 'bob', googleEmail: 'bob@example.com' };
    const r = await links.publishPreviewLinkFor(deps, bob, 'proj0001', { workstream: 'main', port: 3000, name: 'bobs-app' });
    expect(r.status).toBe(201);
    const names = async (who: typeof caller) => ((await links.listOwnPreviewLinksFor(deps, who)).body as any).links.map((l: any) => l.name).sort();
    expect(await names(caller)).toEqual(['bobs-app', 'my-app']);
    expect(await names(bob)).toEqual(['bobs-app']);
    expect(await links.publishPreviewLinkFor(deps, bob, 'proj0001', { workstream: 'main', port: 3001, name: 'my-app' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    // Out of the way of the archive test below, which counts live audiences.
    await prisma.previewAudience.delete({ where: { id: (await prisma.previewLink.findFirstOrThrow({ where: { name: 'bobs-app' } })).audienceId } });
    await prisma.projectShare.deleteMany({});
  });

  it("a publish holds the project's row: an archive waits for it, and a publish after the archive is refused", async () => {
    await prisma.project.create({ data: { id: 'proj0002', name: 'other', userId: 'alice' } });
    let archived = false;
    let archive!: Promise<unknown>;
    await prisma.$transaction(async () => {}); // warm the pool
    await links.prismaPreviewLinkStore.withName('lock-probe', async (tx) => {
      expect(await tx.scopeLive('proj0002', null)).toBe(true);
      archive = prisma.project.update({ where: { id: 'proj0002' }, data: { archived: true } }).then(() => { archived = true; });
      await new Promise(r => setTimeout(r, 300));
      // Still waiting on this transaction's share lock.
      expect(archived).toBe(false);
    });
    await archive;
    expect(archived).toBe(true);
    // A publish whose standing was read before the archive (a stale findProject) is refused in its transaction.
    const stale = { ...deps, findProject: async (id: string) => ({ ...(await deps.findProject(id))!, archived: false }) };
    expect(await links.publishPreviewLinkFor(stale, caller, 'proj0002', { workstream: 'main', port: 3000, name: 'late-app' })).toMatchObject({ status: 404 });
    expect(await prisma.previewLink.count({ where: { name: 'late-app' } })).toBe(0);
    await prisma.project.delete({ where: { id: 'proj0002' } });
  });

  it("a publish holds the workstream's row too: its removal's mark waits, and a publish after the delete is a 404, not a foreign-key 500", async () => {
    await prisma.workstream.create({ data: { id: 'ws-gone', projectId: 'proj0001', name: 'gone-ws', branch: 'gone-ws' } });
    let marked = false;
    let mark!: Promise<unknown>;
    await links.prismaPreviewLinkStore.withName('lock-probe-ws', async (tx) => {
      expect(await tx.scopeLive('proj0001', 'ws-gone')).toBe(true);
      mark = prisma.workstream.update({ where: { id: 'ws-gone' }, data: { archived: true } }).then(() => { marked = true; });
      await new Promise(r => setTimeout(r, 300));
      expect(marked).toBe(false);
    });
    await mark;
    expect(marked).toBe(true);
    await prisma.workstream.delete({ where: { id: 'ws-gone' } });
    // Standing read before the removal (a stale findWorkstream): refused in the transaction.
    const stale = { ...deps, findWorkstream: async () => ({ id: 'ws-gone' }) };
    expect(await links.publishPreviewLinkFor(stale, caller, 'proj0001', { workstream: 'gone-ws', port: 3000, name: 'gone-app' })).toMatchObject({ status: 404 });
    expect(await prisma.previewLink.count({ where: { name: 'gone-app' } })).toBe(0);
  });

  it('archiving the project ends its audiences and so its links, through the end hook', async () => {
    const link = await prisma.previewLink.findFirstOrThrow({ where: { name: 'my-app' } });
    await prisma.previewLinkSession.create({
      data: { idHash: 'sess-1', linkId: link.id, basis: 'owner', userId: 'alice', verifiedAt: T0, expiresAt: new Date(T0.getTime() + HOUR) },
    });
    await prisma.previewLinkCode.create({ data: { codeHash: 'code-1', linkId: link.id, userId: 'alice', basis: 'owner', next: '/', expiresAt: new Date(T0.getTime() + 60_000) } });
    expect(await core.endPreviewAudiences({ projectId: 'proj0001' }, 'project-gone', null, T0)).toBe(1);
    const audience = await prisma.previewAudience.findUniqueOrThrow({ where: { id: link.audienceId } });
    expect(audience).toMatchObject({ endedAt: T0, endReason: 'project-gone', revokedAt: null });
    expect((await prisma.previewLinkSession.findUniqueOrThrow({ where: { idHash: 'sess-1' } })).revokedAt).toEqual(T0);
    expect(await prisma.previewLinkCode.count({ where: { linkId: link.id } })).toBe(0);
    expect(revoked).toEqual([['sess-1']]);
    // Held 30 days past the later of its expiry and now.
    const name = await prisma.previewLinkName.findUniqueOrThrow({ where: { name: 'my-app' } });
    expect(name).toMatchObject({ ownerId: 'alice', linkId: link.id, reservedUntil: new Date(T0.getTime() + 2 * HOUR + 30 * 24 * HOUR) });
  });

  it('deleting the project cascades the audience, link and sessions away, and keeps the name held (SR19)', async () => {
    const held = (await prisma.previewLinkName.findUniqueOrThrow({ where: { name: 'my-app' } })).reservedUntil;
    await prisma.project.delete({ where: { id: 'proj0001' } });
    expect(await prisma.previewAudience.count()).toBe(0);
    expect(await prisma.previewLink.count()).toBe(0);
    expect(await prisma.previewLinkSession.count()).toBe(0);
    expect(await prisma.previewAudienceGrantee.count()).toBe(0);
    expect(await prisma.previewLinkName.findUniqueOrThrow({ where: { name: 'my-app' } })).toEqual({ name: 'my-app', ownerId: 'alice', reservedUntil: held, linkId: null });
  });
});
