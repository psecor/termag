/**
 * The node-postgres pool's occupancy as OpenTelemetry gauges, read at each
 * export: connections open, idle, and queries waiting for one. A Prisma span's
 * duration includes that wait (tracing/prismaSpans.ts), so without these a
 * full pool reads as a slow database (2026-11-13). Only the IAM-auth path has a
 * pool of ours (db.ts); with a plain DATABASE_URL, Prisma's engine pools and
 * nothing is reported. Registered once, after initOtel, like the spawn gauges.
 */
import { metrics } from '@opentelemetry/api';
import type { Pool } from 'pg';

const SCOPE = 'termag.db';

let registered = false;

export function registerDbPoolGauges(pool: () => Pick<Pool, 'totalCount' | 'idleCount' | 'waitingCount'> | null): void {
  if (registered) return;
  registered = true;
  const meter = metrics.getMeter(SCOPE);
  const gauge = (name: string, description: string, unit: string, read: (p: Pick<Pool, 'totalCount' | 'idleCount' | 'waitingCount'>) => number) =>
    meter.createObservableGauge(name, { description, unit }).addCallback(result => {
      const p = pool();
      if (p) result.observe(read(p));
    });
  gauge('termag.db.pool.total', 'Postgres connections the orchestrator holds open, idle or busy', '{connection}', p => p.totalCount);
  gauge('termag.db.pool.idle', 'Open Postgres connections nothing is using', '{connection}', p => p.idleCount);
  gauge('termag.db.pool.waiting', 'Queries queued for a Postgres connection because every one is busy', '{request}', p => p.waitingCount);
}

/** Test-only: allow registering again against a new provider. */
export function resetDbPoolGaugesForTests(): void { registered = false; }
