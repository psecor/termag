/**
 * PR 3 of docs/server-tracing/implementation-plan.md: is every span a request
 * makes after the session stack (its pg queries, its Prisma operations, its
 * outbound HTTP) filed under that request's own server span?
 *
 * Production's shape, in a child process (fixtures/sessionContext.ts): the
 * real tracer and instrumentations, express-session over the real
 * connect-pg-simple store, one small pg pool shared with Prisma's driver
 * adapter, and many requests at once, so pool callbacks queue.
 *
 * Without PgPoolContextInstrumentation they aren't: a queued pool callback
 * runs in whichever request released the connection, and the pg
 * instrumentation, with connect spans off, doesn't bind it. The control run
 * takes the binding off and must see the leak, so this test fails if the
 * fixture stops reproducing it.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL on a cluster that trusts local
 * connections, as db.integration.test.ts does; skipped without it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const backendRoot = join(__dirname, '..', '..', '..');

interface FixtureSpan { name: string; spanId: string; parentSpanId: string | null; attributes: Record<string, unknown> }
interface Result { requests: number; statuses: number[]; spans: FixtureSpan[] }

/** For each work request: does it hold exactly its own pg query, one Prisma operation and one outbound call? */
function misfiled(result: Result): number {
  const byId = new Map(result.spans.map(s => [s.spanId, s]));
  const serverOf = (s: FixtureSpan): FixtureSpan => {
    let cur = s;
    for (let i = 0; cur.parentSpanId && i < 50; i++) cur = byId.get(cur.parentSpanId) ?? cur;
    return cur;
  };
  const servers = result.spans.filter(s => s.name === 'GET /termag/api/work');
  expect(servers).toHaveLength(result.requests);
  let wrong = 0;
  for (const server of servers) {
    const n = String(server.attributes['fixture.request']);
    const mine = result.spans.filter(s => s !== server && serverOf(s) === server);
    const queries = mine.filter(s => String(s.attributes['db.query.text'] ?? '').includes('fixture_request'));
    const ok = queries.length === 1
      && String(queries[0].attributes['db.query.text']).startsWith(`SELECT ${n}::int`)
      && mine.filter(s => s.name === 'prisma:queryRaw').length === 1
      && mine.filter(s => s.name === 'GET').length === 1;
    if (!ok) wrong++;
  }
  return wrong;
}

describe.skipIf(!adminUrl)('the session store\'s context (integration)', () => {
  const dbName = `termag_ctx_${process.pid}_${Date.now()}`;
  const out = mkdtempSync(join(tmpdir(), 'termag-ctx-'));
  const dbUrl = () => {
    const u = new URL(adminUrl!);
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  async function admin(text: string) {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(text);
    } finally {
      await c.end();
    }
  }
  function run(unbound: boolean): Result {
    const file = join(out, unbound ? 'unbound.json' : 'bound.json');
    const r = spawnSync(join(backendRoot, 'node_modules', '.bin', 'tsx'), [join(__dirname, 'fixtures', 'sessionContext.ts')], {
      cwd: backendRoot,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: '/dev/null',
        FIXTURE_DB_URL: dbUrl(), FIXTURE_OUT: file, FIXTURE_UNBOUND_POOL: unbound ? '1' : '0',
      },
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const result = JSON.parse(readFileSync(file, 'utf8')) as Result;
    expect(result.statuses.every(s => s === 200)).toBe(true);
    return result;
  }

  beforeAll(async () => { await admin(`CREATE DATABASE ${dbName}`); }, 30_000);
  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    rmSync(out, { recursive: true, force: true });
  });

  it('files every span after the session stack under its own request', () => {
    expect(misfiled(run(false))).toBe(0);
  }, 120_000);

  it('misfiles them without the pg-pool binding (the control)', () => {
    expect(misfiled(run(true))).toBeGreaterThan(0);
  }, 120_000);
});
