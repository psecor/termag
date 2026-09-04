/**
 * Schema sync entrypoint for container deployments (`npm run db:push`).
 *
 * Mirrors what the EC2 cloud-init used to run by hand — `prisma db push
 * --accept-data-loss --skip-generate` — but resolves the connection the same
 * way the server does, so a platform that injects PG_* instead of DATABASE_URL
 * (and, on Shepherd, no password at all) works for the migration step too:
 *
 *   DATABASE_URL set                  → used as-is.
 *   PG_* with PG_PASSWORD             → DSN composed from them.
 *   PG_* without a password, or       → an RDS IAM auth token is minted for the
 *   PG_IAM_AUTH=true                    user (PG_USERNAME / PG_USER, e.g. the
 *                                       "migration" user) and used as the password.
 *                                       Tokens live 15 minutes — plenty for a push.
 *
 * Why `db push` and not `migrate deploy`: the migration history has known
 * drift from schema.prisma; `db push`
 * converges the DB to the schema regardless. It also drops tables the schema
 * doesn't know about — which is why connect-pg-simple's `session` table is
 * declared in schema.prisma (model Session): this step, running as the
 * `migration` user, creates and keeps it, so the server (the DML-only
 * `application` user on Shepherd) never has to CREATE TABLE on boot.
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Signer } from '@aws-sdk/rds-signer';
import {
  buildDatabaseUrl, iamAuthEnabled, iamSigningRegion, pgConnectionFromEnv, pgSslConfig, prismaSslParams,
} from '../config/env';

const backendRoot = join(__dirname, '..', '..');
const localBin = join(backendRoot, 'node_modules', '.bin', 'prisma');
const args = ['db', 'push', '--accept-data-loss', '--skip-generate'];

async function resolveDatabaseUrl(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const conn = pgConnectionFromEnv(env);
  if (!conn) return null;

  const useIam = iamAuthEnabled(env) || conn.password === undefined;
  const ssl = pgSslConfig(useIam ? { ...env, PG_IAM_AUTH: 'true' } : env, existsSync);
  const params = prismaSslParams(ssl);

  if (!useIam) return buildDatabaseUrl(conn, params);

  const region = iamSigningRegion(env, conn.host);
  if (!region) {
    throw new Error(`cannot determine the RDS IAM signing region for ${conn.host}; set AWS_REGION or PG_IAM_REGION`);
  }
  console.log(`[db:push] minting RDS IAM token for ${conn.username}@${conn.host} (${region}, tls=${ssl.mode})`);
  const token = await new Signer({ hostname: conn.host, port: conn.port, username: conn.username, region }).getAuthToken();
  return buildDatabaseUrl({ ...conn, password: token }, params);
}

async function main(): Promise<number> {
  const url = await resolveDatabaseUrl(process.env);
  if (!url) {
    console.error('[db:push] DATABASE_URL is not set and could not be derived from PG_HOST/PG_DATABASE/PG_USERNAME');
    return 2;
  }
  const env = { ...process.env, DATABASE_URL: url };

  const result = existsSync(localBin)
    ? spawnSync(localBin, args, { stdio: 'inherit', cwd: backendRoot, env })
    : spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', cwd: backendRoot, env });

  if (result.error) {
    console.error('[db:push] failed to start prisma:', result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

main().then(
  code => process.exit(code),
  err => {
    console.error('[db:push]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
