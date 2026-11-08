/**
 * Slack agent threads against a real Postgres (agentStore.ts): a thread's
 * binding (scope, space, route seq, freeze) and a DM's space survive a save,
 * a simulated restart and a load, and rows from before the binding columns
 * come back personal.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_slack_agent_store_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_slack_agent_store_${process.pid}$1`); });

describe.skipIf(!adminUrl)('Slack agent thread store against Postgres', () => {
  let store: typeof import('./agentStore');
  let session: typeof import('./agentSession');
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
    store = await import('./agentStore');
    session = await import('./agentSession');
    session.setAgentThreadStore(store.prismaAgentThreadStore);
  }, 120_000);

  afterAll(async () => {
    session?.setAgentThreadStore(null);
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('round-trips a thread\'s binding and a DM\'s space through a restart', async () => {
    const frozenAt = new Date('2026-11-04T10:00:00Z');
    session.claimThread('C1:1.0', 'UA');
    session.setThreadBinding('C1:1.0', { scope: 'space', spaceId: 'sp_1', routeSeq: 3, frozenAt });
    session.rememberClaudeSession('C1:1.0', 's1', '/p');
    session.setThreadBinding('D1:2.0', { scope: 'space', spaceId: 'sp_1', routeSeq: 0, frozenAt: null });
    session.rememberClaudeSession('D1:2.0', 's2', '/p', 'D1');
    await store.flushAgentWrites();

    const row = await prisma.slackAgentThread.findUnique({ where: { channelId_threadTs: { channelId: 'C1', threadTs: '1.0' } } });
    expect(row).toMatchObject({ scope: 'space', spaceId: 'sp_1', routeSeq: 3, frozenAt, ownerSlackId: 'UA', claudeSessionId: 's1' });
    expect(await prisma.slackAgentDmLast.findUnique({ where: { channelId: 'D1' } })).toMatchObject({ spaceId: 'sp_1' });

    // A restart: memory is gone, the rows are read back.
    session.resetAgentThreadsForTests();
    expect(session.threadBindingOf('C1:1.0').scope).toBe('personal');
    await store.loadAgentThreads();
    expect(session.threadBindingOf('C1:1.0')).toEqual({ scope: 'space', spaceId: 'sp_1', routeSeq: 3, frozenAt });
    expect(session.claudeSessionFor('C1:1.0', '/p')?.sessionId).toBe('s1');
    // The DM's carry-over is kept only for a new thread under the same space binding.
    expect(session.claudeSessionFor('D1:3.0', '/p', 'D1')).toBeUndefined();
    session.setThreadBinding('D1:3.0', { scope: 'space', spaceId: 'sp_1', routeSeq: 0, frozenAt: null });
    expect(session.claudeSessionFor('D1:3.0', '/p', 'D1')).toMatchObject({ sessionId: 's2', carried: true });
  });

  it('reads a row saved without a binding as personal', async () => {
    await prisma.slackAgentThread.create({ data: { channelId: 'C9', threadTs: '1.0', ownerSlackId: 'UB', claudeSessionId: 's9', workingDir: '/p' } });
    session.resetAgentThreadsForTests();
    await store.loadAgentThreads();
    expect(session.threadBindingOf('C9:1.0')).toEqual({ scope: 'personal', spaceId: null, routeSeq: 0, frozenAt: null });
    expect(session.claudeSessionFor('C9:1.0', '/p')?.sessionId).toBe('s9');
  });
});
