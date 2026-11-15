/**
 * persistHost against a real Postgres: a rescan is authoritative for the model
 * rows of the buckets it reports, so token_usage_model_days always sums to the
 * token_usage_days row beside it.
 * Needs TERMAG_TEST_PG_URL (an admin URL, e.g. postgresql://postgres:pw@127.0.0.1:55499/postgres).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_usage_persist_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_usage_persist_${process.pid}$1`); });

const NOW = new Date('2026-11-05T12:00:00Z');
const D = '2026-11-04';
const day = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, calls: 1 });
const bucket = (dir: string, models: Record<string, number>) => ({
  dir, cwdHint: null,
  days: { [D]: day(Object.values(models).reduce((a, n) => a + n, 0)) },
  models: Object.entries(models).map(([model, n]) => ({ model, backend: '', days: { [D]: day(n) } })),
});

describe.skipIf(!adminUrl)('persistHost against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let s: typeof import('./tokenUsageSampler');
  let q: typeof import('./admin/usageQueries');
  let range: import('./admin/range').Range;

  const scan = async (raw: unknown, at = NOW) => {
    const norm = s.normalizeScanResponse(raw);
    await s.persistHost('u1', 'box1', norm, s.resolveRows(norm.rows, 'u1', []), s.resolveRows(norm.modelRows, 'u1', []), at);
  };
  // xmin changes whenever Postgres writes a new version of the row.
  const versions = async (table: 'token_usage_days' | 'token_usage_model_days') =>
    (await prisma.$queryRawUnsafe<Array<{ id: string; xmin: string; scannedAt: Date; updatedAt: Date }>>(
      `SELECT id, xmin::text AS xmin, "scannedAt", "updatedAt" FROM ${table} ORDER BY "sourceKey", id`));
  const models = async () => (await prisma.tokenUsageModelDay.findMany({ where: { userId: 'u1' }, orderBy: [{ sourceKey: 'asc' }, { model: 'asc' }] }))
    .map(r => [r.sourceKey, r.model, Number(r.input)]);
  const expectReportsAgree = async () => {
    const byModel = await q.tokenReport(range, ['model']);
    const byBackend = await q.tokenReport(range, ['backend']);
    const plain = await q.tokenReport(range, ['user']);
    expect(byModel.totals).toEqual(plain.totals);
    expect(byBackend.totals).toEqual(plain.totals);
  };

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
    s = await import('./tokenUsageSampler');
    q = await import('./admin/usageQueries');
    const { parseRange } = await import('./admin/range');
    range = parseRange({ range: '7d' }, NOW) as import('./admin/range').Range;
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
  }, 120_000);

  beforeEach(async () => {
    await prisma.tokenUsageModelDay.deleteMany({});
    await prisma.tokenUsageDay.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (!adminUrl) return;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('a rescan that no longer reports a model for a bucket deletes its model row; an errored dir keeps its rows', async () => {
    await scan({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: 20, haiku: 10 }), bucket('dir-b', { opus: 5 })] } } });
    expect(await models()).toEqual([['dir-a', 'haiku', 10], ['dir-a', 'opus', 20], ['dir-b', 'opus', 5]]);
    await scan({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: 20 })], errors: [{ dir: 'dir-b', file: 'x.jsonl', error: 'EACCES' }] } } });
    expect(await models()).toEqual([['dir-a', 'opus', 20], ['dir-b', 'opus', 5]]);
    await expectReportsAgree();
  });

  it('a rescan of a bucket from an agent without models[] deletes its model rows', async () => {
    await scan({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: 20, haiku: 10 })] } } });
    await scan({ schema: 2, sources: { claude: { buckets: [{ dir: 'dir-a', cwdHint: null, days: { [D]: day(30) } }] } } });
    expect(await models()).toEqual([]);
    await expectReportsAgree();
  });

  it('a flip back to schema 1 deletes the model rows with the schema-2 day rows', async () => {
    await scan({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: 20, haiku: 10 })] } } });
    await scan({ providers: { claude: { [D]: day(30) } } });
    expect(await prisma.tokenUsageDay.count({ where: { userId: 'u1', sourceKey: { not: '' } } })).toBe(0);
    expect(await models()).toEqual([]);
    await expectReportsAgree();
  });

  it('writes the scannedAt it is given as Prisma does (UTC), and ids and updatedAt for new rows', async () => {
    await scan({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: 20 })] } } });
    const [d] = await prisma.tokenUsageDay.findMany({ where: { userId: 'u1' } });
    expect(d.scannedAt.toISOString()).toBe(NOW.toISOString());
    expect(d.id).toBeTruthy();
    expect(Math.abs(d.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(d.estimated).toBe(false);
    expect(Number(d.input)).toBe(20);
    const [m] = await prisma.tokenUsageModelDay.findMany({ where: { userId: 'u1' } });
    expect(m.scannedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('a rescan with the same numbers rewrites no row; a changed day is rewritten, its neighbours are not', async () => {
    const raw = (opusA: number) => ({ schema: 2, sources: { claude: { buckets: [bucket('dir-a', { opus: opusA }), bucket('dir-b', { opus: 5 })] } } });
    await scan(raw(20));
    const days0 = await versions('token_usage_days');
    const models0 = await versions('token_usage_model_days');
    await scan(raw(20), new Date(NOW.getTime() + 300_000));
    expect(await versions('token_usage_days')).toEqual(days0);
    expect(await versions('token_usage_model_days')).toEqual(models0);

    const later = new Date(NOW.getTime() + 600_000);
    await scan(raw(25), later);
    const days1 = await versions('token_usage_days');
    expect(days1[0].xmin).not.toBe(days0[0].xmin);       // dir-a changed
    expect(days1[0].scannedAt.toISOString()).toBe(later.toISOString());
    expect(days1[1]).toEqual(days0[1]);                  // dir-b didn't
    expect((await models()).map(r => r[2])).toEqual([25, 5]);
    await expectReportsAgree();
  });

  it('a scan that reports one bucket-day twice keeps the last, as the per-row upserts did', async () => {
    await scan({ schema: 2, sources: { codex: { buckets: [
      { cwdHint: '/w/a', days: { [D]: day(1) } },
      { cwdHint: '/w/a', days: { [D]: day(7) } },
    ] } } });
    const rows = await prisma.tokenUsageDay.findMany({ where: { userId: 'u1' } });
    expect(rows.map(r => Number(r.input))).toEqual([7]);
  });

  it('writes a host of 2,500 rows (more than one statement) in full', async () => {
    const days: Record<string, ReturnType<typeof day>> = {};
    for (let i = 0; i < 250; i++) days[new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)] = day(i + 1);
    const buckets = Array.from({ length: 10 }, (_, k) => ({ dir: `dir-${k}`, cwdHint: null, days }));
    await scan({ schema: 2, sources: { claude: { buckets } } });
    expect(await prisma.tokenUsageDay.count({ where: { userId: 'u1' } })).toBe(2500);
  });
});
