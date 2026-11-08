/**
 * tokenReport grouped by model/backend against a real Postgres (modelTokenSourceSql).
 * Needs TERMAG_TEST_PG_URL (an admin URL, e.g. postgresql://postgres:pw@127.0.0.1:55499/postgres).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_usage_models_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_usage_models_${process.pid}$1`); });

const NOW = new Date('2026-11-05T12:00:00Z');
const D = '2026-11-04';
const tok = (input: number, cacheRead = 0) => ({ input: BigInt(input), output: 0n, cacheRead: BigInt(cacheRead), cacheCreate: 0n, reasoning: 0n, calls: 1 });

describe.skipIf(!adminUrl)('token report by model against Postgres', () => {
  let prisma: typeof import('../../db').prisma;
  let q: typeof import('./usageQueries');
  let range: import('./range').Range;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../../db'));
    q = await import('./usageQueries');
    const { parseRange } = await import('./range');
    range = parseRange({ range: '7d' }, NOW) as import('./range').Range;

    for (const id of ['u1', 'u2']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
    const base = { hostKey: 'box1', date: D, scannedAt: NOW };
    // u1's claude dir: split by model (new agent).
    await prisma.tokenUsageDay.create({ data: { ...base, userId: 'u1', provider: 'claude', sourceKey: 'dir-a', agentSchema: 2, ...tok(30, 300) } });
    await prisma.tokenUsageModelDay.create({ data: { ...base, userId: 'u1', provider: 'claude', sourceKey: 'dir-a', model: 'claude-opus-5-5', ...tok(20, 200) } });
    await prisma.tokenUsageModelDay.create({ data: { ...base, userId: 'u1', provider: 'claude', sourceKey: 'dir-a', model: 'us.anthropic.claude-haiku-5-5', ...tok(10, 100) } });
    // u1's pi on Fireworks: split, with a backend.
    await prisma.tokenUsageDay.create({ data: { ...base, userId: 'u1', provider: 'pi', sourceKey: '/home/u1/q', agentSchema: 2, ...tok(4) } });
    await prisma.tokenUsageModelDay.create({ data: { ...base, userId: 'u1', provider: 'pi', sourceKey: '/home/u1/q', model: 'accounts/fireworks/models/kimi-k3', backend: 'fireworks', ...tok(4) } });
    // u2: an agent from before the split, and a poller estimate: day rows only.
    await prisma.tokenUsageDay.create({ data: { ...base, userId: 'u2', provider: 'claude', sourceKey: 'dir-b', agentSchema: 2, ...tok(7) } });
    await prisma.tokenUsageDay.create({ data: { ...base, userId: 'u2', hostKey: 'poller', provider: 'cursor', sourceKey: '', estimated: true, ...tok(5) } });
    // Outside the range: never counted.
    await prisma.tokenUsageModelDay.create({ data: { ...base, date: '2026-10-01', userId: 'u2', provider: 'claude', sourceKey: 'dir-b', model: 'old', ...tok(999) } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (!adminUrl) return;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('splits by model, puts unsplit day rows under "not recorded", and keeps the totals of the plain report', async () => {
    const byModel = await q.tokenReport(range, ['model']);
    const rows = Object.fromEntries(byModel.rows.map(r => [r.keys[0], r]));
    expect(Object.keys(rows).sort()).toEqual(['', 'accounts/fireworks/models/kimi-k3', 'claude-opus-5-5', 'us.anthropic.claude-haiku-5-5']);
    expect(rows['claude-opus-5-5'].total).toBe(220);
    expect(rows[''].labels[0]).toBe('not recorded');
    expect(rows[''].total).toBe(12);
    expect(rows[''].estimated).toBe(5);
    const plain = await q.tokenReport(range, ['user']);
    expect(byModel.totals).toEqual(plain.totals);
    expect(byModel.rows.reduce((a, r) => a + r.total, 0)).toBe(plain.totals.total);
  });

  it('groups by user × backend', async () => {
    const r = await q.tokenReport(range, ['user', 'backend']);
    const m = Object.fromEntries(r.rows.map(x => [x.keys.join('|'), x.total]));
    expect(m).toEqual({ 'u1|': 330, 'u1|fireworks': 4, 'u2|': 12 });
  });
});
