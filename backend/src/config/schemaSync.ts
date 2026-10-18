/**
 * How `npm run db:push` treats a schema change that would lose data.
 *
 *   accept-data-loss (default) → `prisma db push --accept-data-loss`: the database
 *                                 converges on schema.prisma whatever it drops.
 *                                 What the container's migration step and the
 *                                 local-Postgres orchestrator have always run.
 *   additive                    → `prisma db push` without the flag. Prisma then
 *                                 refuses, and applies nothing, when the change
 *                                 would drop a column or table that holds data;
 *                                 db:push logs what it would have dropped and
 *                                 exits 0 so the service still starts.
 *
 * `additive` is for boot-time sync against a database that outlives the host
 * (RDS): a rolled-back image carries an older schema, and converging on it would
 * drop the newer release's tables. Prisma 5 drops columns and tables that are
 * empty even without the flag, since nothing is lost; only data-bearing drops
 * are refused. Destructive changes become a deliberate, separate step.
 */

export type SchemaSyncMode = 'accept-data-loss' | 'additive';

export interface SchemaSyncEnv {
  DB_PUSH_MODE?: string;
}

export function schemaSyncMode(env: SchemaSyncEnv): SchemaSyncMode {
  const raw = (env.DB_PUSH_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'accept-data-loss') return 'accept-data-loss';
  if (raw === 'additive') return 'additive';
  throw new Error(`DB_PUSH_MODE must be "additive" or "accept-data-loss", got "${env.DB_PUSH_MODE}"`);
}

export function prismaPushArgs(mode: SchemaSyncMode): string[] {
  return mode === 'additive'
    ? ['db', 'push', '--skip-generate']
    : ['db', 'push', '--accept-data-loss', '--skip-generate'];
}

export type PushOutcome =
  | { kind: 'applied' }
  | { kind: 'skipped-data-loss'; warnings: string[] }
  | { kind: 'failed'; status: number };

// Prisma's closing line when it refuses a push over data-loss warnings
// (prisma 5.22: "Use the --accept-data-loss flag to ignore the data loss warnings ...").
const DATA_LOSS_REFUSAL = /--accept-data-loss flag/;

export function classifyPushResult(mode: SchemaSyncMode, status: number | null, output: string): PushOutcome {
  if (status === 0) return { kind: 'applied' };
  if (mode === 'additive' && DATA_LOSS_REFUSAL.test(output)) {
    const warnings = output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('•'))
      .map(line => line.replace(/^•\s*/, ''));
    return { kind: 'skipped-data-loss', warnings };
  }
  return { kind: 'failed', status: status ?? 1 };
}
