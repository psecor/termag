/**
 * Schema sync entrypoint for container deployments (`npm run db:push`).
 *
 * Mirrors what the EC2 cloud-init used to run by hand — `prisma db push
 * --accept-data-loss --skip-generate` — but resolves the connection the same
 * way the server does, so a platform that injects PG_* instead of DATABASE_URL
 * (and, with RDS IAM auth, no password at all) works for the migration step too:
 *
 *   DATABASE_URL set                  → used as-is.
 *   PG_* with PG_PASSWORD             → DSN composed from them.
 *   PG_* without a password, or       → an RDS IAM auth token is minted for the
 *   PG_IAM_AUTH=true                    user (PG_USERNAME / PG_USER, e.g. the
 *                                       "migration" user) and used as the password.
 *                                       Tokens live 15 minutes — plenty for a push.
 *
 * DB_PUSH_MODE=additive refuses data-losing changes instead of applying them
 * (../config/schemaSync.ts); the default keeps --accept-data-loss.
 *
 * Why `db push` and not `migrate deploy`: the migration history has known
 * drift from schema.prisma; `db push`
 * converges the DB to the schema regardless. It also drops tables the schema
 * doesn't know about — which is why connect-pg-simple's `session` table is
 * declared in schema.prisma (model Session): this step, running as the
 * `migration` user, creates and keeps it, so the server (the DML-only
 * `application` user under RDS IAM auth) never has to CREATE TABLE on boot.
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Signer } from '@aws-sdk/rds-signer';
import {
  buildDatabaseUrl, iamAuthEnabled, iamSigningRegion, pgConnectionFromEnv, pgSslConfig, prismaSslParams,
} from '../config/env';

import { postgresTrustAnchor } from '../config/pgTrustAnchor';
import { classifyPushResult, prismaPushArgs, schemaSyncMode } from '../config/schemaSync';

const backendRoot = join(__dirname, '..', '..');
const localBin = join(backendRoot, 'node_modules', '.bin', 'prisma');

// Prisma reads only the first certificate of `sslcert` (pgTrustAnchor.ts), so it
// gets the bundle's root for this server, written here and removed on exit.
let scratchFile: string | null = null;

async function prismaCaFile(host: string, port: number, bundleFile: string): Promise<string> {
  const anchor = await postgresTrustAnchor({ host, port, ca: readFileSync(bundleFile, 'utf8') });
  scratchFile = join(mkdtempSync(join(tmpdir(), 'termag-db-push-')), 'server-root.pem');
  writeFileSync(scratchFile, anchor, { mode: 0o600 });
  console.log(`[db:push] Prisma CA: ${new X509Certificate(anchor).subject.replace(/\n/g, ', ')}`);
  return scratchFile;
}

async function resolveDatabaseUrl(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const conn = pgConnectionFromEnv(env);
  if (!conn) return null;

  const useIam = iamAuthEnabled(env) || conn.password === undefined;
  let ssl = pgSslConfig(useIam ? { ...env, PG_IAM_AUTH: 'true' } : env, existsSync);
  if (ssl.mode === 'verify') ssl = { mode: 'verify', caFile: await prismaCaFile(conn.host, conn.port, ssl.caFile) };
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
  const mode = schemaSyncMode(process.env);
  const args = prismaPushArgs(mode);
  console.log(`[db:push] mode=${mode}`);

  // Piped rather than inherited so the data-loss refusal can be recognised;
  // stdin is closed so prisma never waits on a prompt.
  const opts = { cwd: backendRoot, env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const result = existsSync(localBin)
    ? spawnSync(localBin, args, opts)
    : spawnSync('npx', ['prisma', ...args], opts);

  if (result.error) {
    console.error('[db:push] failed to start prisma:', result.error.message);
    return 1;
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  const outcome = classifyPushResult(mode, result.status, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  switch (outcome.kind) {
    case 'applied':
      return 0;
    case 'skipped-data-loss':
      console.warn('[db:push] additive mode: schema sync SKIPPED, nothing was applied. The database is ahead of this');
      console.warn('[db:push] image, or the change drops data; destructive changes are a manual step. Prisma reported:');
      for (const w of outcome.warnings) console.warn(`[db:push]   - ${w}`);
      return 0;
    case 'failed':
      return outcome.status;
  }
}

function removeScratch(): void {
  if (!scratchFile) return;
  rmSync(scratchFile, { force: true });
  rmdirSync(dirname(scratchFile));
}

main().then(
  code => {
    removeScratch();
    process.exit(code);
  },
  err => {
    removeScratch();
    console.error('[db:push]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
