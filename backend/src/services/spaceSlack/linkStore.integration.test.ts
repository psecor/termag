/**
 * The link store (linkStore.ts) against a real Postgres: a channel is linked at
 * most once at a time, however many links race for it, and an unlinked channel
 * can be linked again; a space's SpaceSlack is created once.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_space_link_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_space_link_${process.pid}$1`); });

const backendDir = join(__dirname, '../../..');

describe.skipIf(!adminUrl)('linkStore against Postgres', () => {
  let prisma: typeof import('../../db').prisma;
  let store: typeof import('./linkStore').prismaSpaceSlackStore;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(backendDir, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../../db'));
    ({ prismaSpaceSlackStore: store } = await import('./linkStore'));
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1', slackUserId: 'U1' } });
    await prisma.space.create({ data: { id: 's1', name: 'payments', createdById: 'u1' } });
    await prisma.space.create({ data: { id: 's2', name: 'billing', createdById: 'u1' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const linkOf = (spaceSlackId: string, channelId = 'C1') => ({
    channelId, teamId: 'T1', spaceSlackId, name: 'pay-team', isPrivate: false, createdByTermag: false, linkedById: 'u1', linkedVia: 'slack_command',
  });

  it('creates a space\'s SpaceSlack once, however many enables race', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => store.enableSpaceSlack({ spaceId: 's1', enabledById: 'u1', runnerUserId: 'u1', instanceId: null })));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.row.id)).size).toBe(1);
    await store.enableSpaceSlack({ spaceId: 's2', enabledById: 'u1', runnerUserId: 'u1', instanceId: null });
  });

  it('links a channel once when links from two spaces race, and again after an unlink', async () => {
    const a = (await store.spaceSlack('s1'))!;
    const b = (await store.spaceSlack('s2'))!;
    const claims = await Promise.all([a, b, a, b].map(s => store.claimChannel(linkOf(s.id))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.activeChannelCount(claims.find(Boolean)!.spaceSlackId)).toBe(1);

    expect(await store.markUnlinked('C1', 'owner', new Date())).toMatchObject({ unlinkReason: 'owner' });
    expect(await store.markUnlinked('C1', 'owner', new Date())).toBeNull();

    const again = await Promise.all([a, b].map(s => store.claimChannel(linkOf(s.id))));
    expect(again.filter(Boolean)).toHaveLength(1);
    expect(again.find(Boolean)).toMatchObject({ unlinkedAt: null, unlinkReason: null, confirmTs: null });
  });

  it('releases an activation only while it has never had a channel', async () => {
    await prisma.space.create({ data: { id: 's3', name: 'spare', createdById: 'u1' } });
    const { row } = await store.enableSpaceSlack({ spaceId: 's3', enabledById: 'u1', runnerUserId: 'u1', instanceId: null });
    await store.claimChannel(linkOf(row.id, 'C-S3'));
    expect(await store.releaseSpaceSlack(row.id)).toBe(false);
    await prisma.spaceChannel.delete({ where: { channelId: 'C-S3' } });
    expect(await store.releaseSpaceSlack(row.id)).toBe(true);
    expect(await store.spaceSlack('s3')).toBeNull();
  });

  it('maps users to their Slack ids', async () => {
    expect(await store.slackIdsOf(['u1', 'nobody'])).toEqual(new Map([['u1', 'U1']]));
  });
});
