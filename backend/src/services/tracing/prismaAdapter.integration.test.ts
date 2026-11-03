/**
 * The spike behind docs/server-tracing (implementation plan, PR 1): does a
 * Prisma query through the driver adapter, the production PG_IAM_AUTH path
 * (PrismaPg over a node-postgres pool, db.ts), keep the caller's
 * OpenTelemetry context, so that the pg instrumentation records it as a
 * child of the request's span?
 *
 * It doesn't. Prisma 5's engine calls the adapter from native code, so every
 * query reaches pg in the root context: a span of its own, in a trace of its
 * own, and nothing at all once `requireParentSpan` is on. This test pins that
 * finding; if a Prisma upgrade starts passing the context through, it fails,
 * and the per-operation spans in services/tracing/prismaSpans.ts, which the
 * last case shows parented correctly, can give way to the pg spans.
 *
 * Runs the fixture in a child `node` (the instrumentation patches through
 * require, which vitest's loader bypasses). Needs TERMAG_TEST_PG_URL, a
 * superuser URL on a cluster that trusts local connections, as
 * db.integration.test.ts does; skipped without it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const backendRoot = join(__dirname, '..', '..', '..');

interface SpikeResult {
  entries: { name: string; spanId: string; traceId: string }[];
  spans: { name: string; parent: string | null; traceId: string }[];
}

describe.skipIf(!adminUrl)('Prisma through the driver adapter (integration)', () => {
  const dbName = `termag_trace_${process.pid}_${Date.now()}`;
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
  function spike(requireParent: boolean): SpikeResult {
    const r = spawnSync(process.execPath, [join(__dirname, 'prismaAdapterSpike.cjs')], {
      cwd: backendRoot,
      env: { PATH: process.env.PATH, SPIKE_DB_URL: dbUrl(), SPIKE_REQUIRE_PARENT: requireParent ? '1' : '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split('\n').pop()!) as SpikeResult;
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${dbName}`);
    const push = spawnSync(join(backendRoot, 'node_modules', '.bin', 'prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: backendRoot,
      env: { PATH: process.env.PATH, DATABASE_URL: dbUrl(), CHECKPOINT_DISABLE: '1', DOTENV_CONFIG_PATH: '/dev/null' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(push.status, push.stderr).toBe(0);
  }, 150_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });

  it('records every adapter query as a root span, outside the caller\'s trace', () => {
    const { entries, spans } = spike(false);
    // 2 entries × 3 queries inside a span, plus 1 outside.
    expect(spans.length).toBeGreaterThanOrEqual(7);
    const entryTraces = new Set(entries.map((e) => e.traceId));
    for (const s of spans) {
      expect(s.parent).toBeNull();
      expect(entryTraces.has(s.traceId)).toBe(false);
    }
  }, 60_000);

  it('records nothing for them with requireParentSpan, as tracing.ts configures pg', () => {
    expect(spike(true).spans).toEqual([]);
  }, 60_000);

  it('files each operation under its own request with installOperationSpans', () => {
    const r = spawnSync(join(backendRoot, 'node_modules', '.bin', 'tsx'), [join(__dirname, 'fixtures', 'prismaSpansAdapter.ts')], {
      cwd: backendRoot,
      env: { PATH: process.env.PATH, SPIKE_DB_URL: dbUrl() },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { spans } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { spans: { name: string; entry: string | null }[] };
    expect(spans.map(s => `${s.entry} ${s.name}`).sort()).toEqual([
      'a prisma:User.count', 'a prisma:User.findMany', 'b prisma:User.count', 'b prisma:User.findMany',
    ]);
  }, 60_000);
});
