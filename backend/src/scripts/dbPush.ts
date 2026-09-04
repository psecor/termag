/**
 * Schema sync entrypoint for container deployments (`npm run db:push`).
 *
 * Mirrors what the EC2 cloud-init used to run by hand — `prisma db push
 * --accept-data-loss --skip-generate` — but goes through the same env
 * bootstrap as the server so a platform that injects PG_* instead of
 * DATABASE_URL works for the migration step too. Run it as the deploy
 * pipeline's migration command (or an init container) before the new server
 * image starts.
 *
 * Why `db push` and not `migrate deploy`: the migration history has known
 * drift from schema.prisma; `db push`
 * converges the DB to the schema regardless. It also drops tables the schema
 * doesn't know about — including connect-pg-simple's `session` table, which
 * the server recreates on boot (createTableIfMissing).
 */
import 'dotenv/config';
import '../config/bootstrap';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const backendRoot = join(__dirname, '..', '..');
const localBin = join(backendRoot, 'node_modules', '.bin', 'prisma');
const args = ['db', 'push', '--accept-data-loss', '--skip-generate'];

if (!process.env.DATABASE_URL) {
  console.error('[db:push] DATABASE_URL is not set and could not be derived from PG_HOST/PG_DATABASE/PG_USERNAME');
  process.exit(2);
}

const result = existsSync(localBin)
  ? spawnSync(localBin, args, { stdio: 'inherit', cwd: backendRoot, env: process.env })
  : spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', cwd: backendRoot, env: process.env });

if (result.error) {
  console.error('[db:push] failed to start prisma:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
