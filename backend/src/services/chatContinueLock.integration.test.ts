/**
 * The "Continue on a new box" lock against a real Postgres
 * (chatContinueLock.ts): of many takers at once exactly one wins, a release
 * lets the next one in, and a crashed holder's lock is taken over once stale.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_continue_lock_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_continue_lock_${process.pid}$1`); });

describe.skipIf(!adminUrl)('the continue lock against Postgres', () => {
  let lock: typeof import('./chatContinueLock');
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
    lock = await import('./chatContinueLock');
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
    for (const id of ['p1', 'p2', 'p3']) await prisma.project.create({ data: { id, name: id, userId: 'u1' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('of twenty takers at once, exactly one gets it', async () => {
    const tokens = await Promise.all(Array.from({ length: 20 }, () => lock.acquireContinueLock('p1')));
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect(await lock.continueUnderWay('p1')).toBe(true);
  });

  it('a release lets the next one in, and only the holder can release', async () => {
    const t = await lock.acquireContinueLock('p2');
    expect(t).toBeTruthy();
    expect(await lock.acquireContinueLock('p2')).toBeNull();
    await lock.releaseContinueLock('p2', 'someone-else');
    expect(await lock.acquireContinueLock('p2')).toBeNull();
    await lock.releaseContinueLock('p2', t!);
    expect(await lock.continueUnderWay('p2')).toBe(false);
    expect(await lock.acquireContinueLock('p2')).toBeTruthy();
  });

  it('a crashed holder\'s lock is taken over once it is stale, and its late release leaves the new holder be', async () => {
    const t0 = new Date('2026-10-27T12:00:00Z');
    const crashed = await lock.acquireContinueLock('p3', t0);
    expect(crashed).toBeTruthy();
    const soon = new Date(t0.getTime() + lock.CONTINUE_LOCK_STALE_MS - 1000);
    expect(await lock.acquireContinueLock('p3', soon)).toBeNull();
    const later = new Date(t0.getTime() + lock.CONTINUE_LOCK_STALE_MS + 1000);
    expect(await lock.continueUnderWay('p3', later)).toBe(false);
    const next = await lock.acquireContinueLock('p3', later);
    expect(next).toBeTruthy();
    await lock.releaseContinueLock('p3', crashed!);
    expect(await lock.continueUnderWay('p3', later)).toBe(true);
  });
});
