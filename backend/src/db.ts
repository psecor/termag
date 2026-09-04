/**
 * The one PrismaClient (and, for IAM auth, the one node-postgres pool).
 *
 * Every module used to construct its own `new PrismaClient()`. That was fine
 * when the only input was DATABASE_URL, but Aurora behind RDS Proxy (Shepherd)
 * issues no password: each connection authenticates with a 15-minute IAM token
 * minted by the client. Prisma's engine cannot do that from a static URL, so in
 * that mode Prisma runs through a node-postgres pool (`driverAdapters`) whose
 * `password` is a function that signs a fresh token per connection. Sharing the
 * client here is what makes that a single switch instead of thirty.
 *
 *   PG_IAM_AUTH=true   → pool + adapter; PG_HOST/PG_PORT/PG_DATABASE/PG_USERNAME
 *                        from the platform, region from PG_IAM_REGION / AWS_REGION /
 *                        the RDS hostname, TLS per pgSslConfig (the image bakes
 *                        Amazon's RDS CA bundle, so the server cert is verified).
 *   otherwise          → plain PrismaClient on DATABASE_URL, exactly as before.
 *
 * connect-pg-simple reuses the same pool (see index.ts) so the session store
 * gets IAM auth for free.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { existsSync, readFileSync } from 'fs';
import { iamAuthEnabled, iamSigningRegion, pgConnectionFromEnv, pgSslConfig } from './config/env';

let pool: Pool | null = null;

function iamPoolConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const conn = pgConnectionFromEnv(env);
  if (!conn) {
    throw new Error('PG_IAM_AUTH=true requires PG_HOST, PG_DATABASE and PG_USERNAME (or PG_USER)');
  }
  const region = iamSigningRegion(env, conn.host);
  if (!region) {
    throw new Error(`PG_IAM_AUTH=true: cannot determine the signing region for ${conn.host}; set AWS_REGION or PG_IAM_REGION`);
  }
  const signer = new Signer({ hostname: conn.host, port: conn.port, username: conn.username, region });
  const ssl = pgSslConfig(env, existsSync);

  return {
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    // Called by node-postgres for every new connection, so tokens never go stale
    // even though each one is only valid for 15 minutes.
    password: () => signer.getAuthToken(),
    ssl: ssl.mode === 'off'
      ? undefined
      : ssl.mode === 'verify'
        ? { ca: readFileSync(ssl.caFile, 'utf8'), rejectUnauthorized: true }
        : { rejectUnauthorized: false },
    max: parseInt(env.PG_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: 30_000,
  };
}

function createPrisma(): PrismaClient {
  if (!iamAuthEnabled(process.env)) {
    return new PrismaClient();
  }
  pool = new Pool(iamPoolConfig(process.env));
  pool.on('error', (err) => console.error('[db] idle pool client error:', err.message));
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

/** Shared client. Constructed at import; connects lazily on first query. */
export const prisma: PrismaClient = createPrisma();

/** The IAM-auth pool, for consumers that speak raw node-postgres (session store). Null in URL mode. */
export function getPool(): Pool | null {
  return pool;
}
