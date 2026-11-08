/**
 * The Prisma ThreadFreezer (threadFreezer.ts) against a real Postgres: at link
 * every thread in the channel freezes, at unlink only its `space` threads, a
 * frozen thread keeps its first frozenAt, other channels are untouched, and
 * this process's in-memory bindings follow. Through link()/unlink() too, wired
 * as spaceSlackLinkDeps() wires it.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_space_freeze_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_space_freeze_${process.pid}$1`); });
vi.mock('../../slack/app', () => ({ getSlackApp: () => null }));

const backendDir = join(__dirname, '../../..');

describe.skipIf(!adminUrl)('prismaThreadFreezer against Postgres', () => {
  let prisma: typeof import('../../db').prisma;
  let freezer: typeof import('./threadFreezer').prismaThreadFreezer;
  let claims: typeof import('../../slack/session/claims');

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(backendDir, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../../db'));
    ({ prismaThreadFreezer: freezer } = await import('./threadFreezer'));
    claims = await import('../../slack/session/claims');
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const thread = (channelId: string, threadTs: string, scope: string, frozenAt: Date | null = null) =>
    prisma.slackAgentThread.create({ data: { channelId, threadTs, scope, frozenAt, ownerSlackId: 'U1' } });
  const frozen = async (channelId: string) => Object.fromEntries(
    (await prisma.slackAgentThread.findMany({ where: { channelId } })).map(t => [t.threadTs, t.frozenAt?.toISOString() ?? null]));

  beforeEach(async () => {
    claims.resetAgentThreadsForTests();
    await prisma.slackAgentThread.deleteMany({});
  });

  it('at link freezes every thread in the channel, personal ones and an earlier link\'s leftover space ones, and keeps an earlier freeze', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const at = new Date('2026-11-06T10:00:00Z');
    await thread('C1', '1.1', 'personal');
    await thread('C1', '1.2', 'space');
    await thread('C1', '1.3', 'personal', earlier);
    await thread('C2', '2.1', 'personal');
    expect(await freezer.freezeAtLink('C1', 'payments', at)).toBe(2);
    // 1.2: a space thread an earlier unlink's failed freeze left unfrozen; a new claim freezes it.
    expect(await frozen('C1')).toEqual({ '1.1': at.toISOString(), '1.2': at.toISOString(), '1.3': earlier.toISOString() });
    expect(await frozen('C2')).toEqual({ '2.1': null });
    // This process's bindings follow, so a loaded thread sees the freeze at once.
    expect(claims.threadBindingOf(claims.threadKey('C1', '1.1')).frozenAt).toEqual(at);
    expect(claims.threadBindingOf(claims.threadKey('C2', '2.1')).frozenAt).toBeNull();
  });

  it('keeps an unloaded thread\'s space binding: it is built from the row, not written back as personal', async () => {
    const at = new Date('2026-11-06T12:00:00Z');
    await prisma.slackAgentThread.create({ data: { channelId: 'C3', threadTs: '3.1', scope: 'space', spaceId: 'sp-1', routeSeq: 2, ownerSlackId: 'U1' } });
    expect(await freezer.freezeAtUnlink('C3', 'payments', at)).toBe(1);
    expect(claims.threadBindingOf(claims.threadKey('C3', '3.1'))).toEqual({ scope: 'space', spaceId: 'sp-1', routeSeq: 2, frozenAt: at });
    expect(await prisma.slackAgentThread.findUnique({ where: { channelId_threadTs: { channelId: 'C3', threadTs: '3.1' } } }))
      .toMatchObject({ scope: 'space', spaceId: 'sp-1', routeSeq: 2, frozenAt: at });
  });

  it('a same-space repeat (the no-op retrying a failed freeze) leaves the live link\'s space threads alone', async () => {
    const at = new Date('2026-11-06T13:00:00Z');
    await thread('C4', '4.1', 'personal');
    await thread('C4', '4.2', 'space');
    expect(await freezer.freezeAtLink('C4', 'payments', at, { repeat: true })).toBe(1);
    expect(await frozen('C4')).toEqual({ '4.1': at.toISOString(), '4.2': null });
  });

  it('at unlink freezes only the channel\'s space threads, and counts them first for the preview', async () => {
    const at = new Date('2026-11-06T11:00:00Z');
    await thread('C1', '1.1', 'space');
    await thread('C1', '1.2', 'space');
    await thread('C1', '1.3', 'personal');
    await thread('C1', '1.4', 'router');
    expect(await freezer.spaceThreadCount('C1')).toBe(2);
    expect(await freezer.freezeAtUnlink('C1', 'payments', at)).toBe(2);
    expect(await frozen('C1')).toEqual({ '1.1': at.toISOString(), '1.2': at.toISOString(), '1.3': null, '1.4': null });
    expect(await freezer.spaceThreadCount('C1')).toBe(0);
  });

  it('is what spaceSlackLinkDeps() wires into link() and unlink()', async () => {
    const { spaceSlackLinkDeps } = await import('./runtime');
    expect(spaceSlackLinkDeps().freezer).toBe(freezer);
  });
});
