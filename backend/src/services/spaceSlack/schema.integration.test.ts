/**
 * Migration 2 of spaces in Slack (20261104200000_space_slack) against a real Postgres. Deploys sync with
 * `db push` (docs/agents/data-and-schema.md), and `db:guard` runs before every
 * start (gotcha deploy-db-guard), so the migration has to be safe on live data
 * and has to say exactly what the schema says:
 *
 * - a database at the schema before the migration, with a space event in it,
 *   takes the migration's SQL, and then matches schema.prisma exactly;
 * - the older event reads back with null `surface` and `onBehalfOfUserId`;
 * - the new tables take rows, and a space's Slack rows go with the space.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_space_slack_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_space_slack_${process.pid}$1`); });

const backendDir = join(__dirname, '../../..');
const prismaBin = join(backendDir, 'node_modules/.bin/prisma');
const migrationSql = readFileSync(join(backendDir, 'prisma/migrations/20261104200000_space_slack/migration.sql'), 'utf8');

// The schema before the migration: what it creates, taken away again.
const BEFORE = `
  DROP TABLE space_channels; DROP TABLE space_slack; DROP TABLE slack_thread_routes;
  DROP TABLE space_slack_tasks; DROP TABLE space_slack_pending;
  ALTER TABLE space_events DROP COLUMN surface, DROP COLUMN "onBehalfOfUserId";
`;

function prismaCli(args: string[]) {
  return spawnSync(prismaBin, args, { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
}

describe.skipIf(!adminUrl)('migration 20261104200000_space_slack against Postgres', () => {
  let prisma: typeof import('../../db').prisma;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = prismaCli(['db', 'push', '--skip-generate', '--accept-data-loss']);
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);

    const db = new Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(BEFORE);
    // Live data the migration must leave alone: a space and an event written before it.
    await db.query(`INSERT INTO users (id, "googleId", "googleEmail", "unixUsername", "displayName") VALUES ('u1', 'g-u1', 'u1@example.com', 'u1', 'u1')`);
    await db.query(`INSERT INTO spaces (id, name, "createdById") VALUES ('s1', 'assets', 'u1')`);
    await db.query(`INSERT INTO space_events (id, "spaceId", "actorUserId", action) VALUES ('ev-old', 's1', 'u1', 'space.create')`);
    await db.query(migrationSql);
    await db.end();
    ({ prisma } = await import('../../db'));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('brings the database to exactly what schema.prisma says', () => {
    const diff = prismaCli(['migrate', 'diff', '--from-url', dbUrl, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
    expect(diff.stdout + diff.stderr).toMatch(/No difference detected|^\s*$/);
    expect(diff.status).toBe(0);
  });

  it('leaves an older space event with no surface and no on-behalf-of', async () => {
    expect(await prisma.spaceEvent.findUnique({ where: { id: 'ev-old' } }))
      .toMatchObject({ action: 'space.create', surface: null, onBehalfOfUserId: null });
  });

  it('stores a space\'s Slack row and channels, and removes them with the space', async () => {
    await prisma.spaceSlack.create({
      data: {
        id: 'ss1', spaceId: 's1', enabledById: 'u1', runnerUserId: 'u1',
        channels: { create: { channelId: 'C1', teamId: 'T1', name: 'assets', linkedById: 'u1', linkedVia: 'slack_command' } },
      },
    });
    expect(await prisma.spaceSlack.findUnique({ where: { spaceId: 's1' }, include: { channels: true } }))
      .toMatchObject({ status: 'active', projectId: null, channels: [{ channelId: 'C1', isPrivate: false, createdByTermag: false, unlinkedAt: null }] });
    // One space per channel: the channel id is the key.
    await expect(prisma.spaceChannel.create({ data: { channelId: 'C1', teamId: 'T1', spaceSlackId: 'ss1', name: 'x', linkedById: 'u1', linkedVia: 'web' } }))
      .rejects.toThrow();

    await prisma.space.delete({ where: { id: 's1' } });
    expect(await prisma.spaceSlack.count()).toBe(0);
    expect(await prisma.spaceChannel.count()).toBe(0);
  });

  it('keeps a thread\'s routing history in order, and the queue and report-back rows', async () => {
    for (const seq of [1, 2]) {
      await prisma.slackThreadRoute.create({
        data: { channelId: 'D1', threadTs: '1.1', seq, spaceId: `s${seq}`, requestedBySlackId: 'U1', requestedByUserId: 'u1', decidedBy: 'explicit', candidateCount: 2 },
      });
    }
    expect((await prisma.slackThreadRoute.findMany({ where: { channelId: 'D1', threadTs: '1.1' }, orderBy: { seq: 'desc' } })).map(r => r.spaceId))
      .toEqual(['s2', 's1']);
    await prisma.spaceSlackTask.create({ data: { agentThreadId: 't1', spaceId: 's2', channelId: 'D1', threadTs: '1.1', requestedByUserId: 'u1' } });
    await prisma.spaceSlackPending.create({ data: { spaceId: 's2', channelId: 'D1', threadTs: '1.1', slackId: 'U1', message: 'hi' } });
    expect(await prisma.spaceSlackTask.findUnique({ where: { agentThreadId: 't1' } })).toMatchObject({ postedAt: null });
    expect(await prisma.spaceSlackPending.count({ where: { spaceId: 's2' } })).toBe(1);
  });
});
