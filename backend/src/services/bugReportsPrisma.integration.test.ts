/**
 * The bug-report store (bugReportsPrisma.ts) against a real Postgres: a capped
 * list is new reports first, then the rest, newest first within each, so an
 * old `new` report is never pushed off the list by newer triaged ones while
 * the nav badge still counts it.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_bugs_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_bugs_${process.pid}$1`); });

describe.skipIf(!adminUrl)('bug reports against Postgres', () => {
  let store: typeof import('./bugReportsPrisma').prismaBugReports;
  let prisma: typeof import('../db').prisma;
  const at = (min: number) => new Date(Date.UTC(2026, 9, 29, 12, min));

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
    ({ prismaBugReports: store } = await import('./bugReportsPrisma'));
    // The oldest is still new; the four after it are triaged, fixed or wontfix.
    const rows: Array<[string, string, string]> = [
      ['old-new', 'new', 'space put answers 403'], ['t1', 'triaged', 'broker 403'], ['t2', 'fixed', 'space put again'],
      ['t3', 'wontfix', 'classifier'], ['t4', 'triaged', 'publish reason'],
    ];
    for (const [i, [id, status, title]] of rows.entries()) {
      await prisma.bugReport.create({ data: { id, status, title, body: 'repro', reporterUserId: 'u1', credential: 'box', createdAt: at(i) } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const ids = async (f: Parameters<typeof store.list>[0]) => (await store.list(f)).map(r => r.id);

  it('keeps an old new report on a capped list, ahead of newer ones', async () => {
    expect(await ids({ limit: 2 })).toEqual(['old-new', 't4']);
    expect(await ids({ limit: 1 })).toEqual(['old-new']);
    expect(await ids({ limit: 10 })).toEqual(['old-new', 't4', 't3', 't2', 't1']);
  });

  it('applies the filters to both halves', async () => {
    expect(await ids({ limit: 2, search: 'space put' })).toEqual(['old-new', 't2']);
    expect(await ids({ limit: 2, statuses: ['triaged', 'fixed'] })).toEqual(['t4', 't2']);
    expect(await ids({ limit: 5, statuses: ['new'] })).toEqual(['old-new']);
  });
});
