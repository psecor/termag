/**
 * Environment derivation shared by the container and host deployments.
 *
 * Container platforms typically inject a Postgres connection as discrete
 * PG_* variables (host, port, database, user, password) rather than a single
 * DSN — and some (Aurora behind RDS Proxy on Shepherd) hand out no password at
 * all: the client mints a short-lived IAM auth token per connection instead.
 * Everything here is pure (no process.env access, no filesystem) so it is
 * unit-testable; the side-effecting bits live in ./bootstrap and ../db.
 */

export interface PgEnv {
  PG_HOST?: string;
  PG_PORT?: string;
  PG_DATABASE?: string;
  PG_USERNAME?: string;
  PG_USER?: string;
  PG_PASSWORD?: string;
  PG_SSLMODE?: string;
  /** Path to a CA bundle to verify the server certificate against. */
  PG_SSL_CA_FILE?: string;
  /** "true" → authenticate with RDS IAM tokens instead of a password. */
  PG_IAM_AUTH?: string;
  /** Region to sign IAM tokens for; defaults to AWS_REGION, then the RDS hostname. */
  PG_IAM_REGION?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  DATABASE_URL?: string;
}

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
}

/** Where the container image bakes Amazon's RDS certificate bundle (Dockerfile). */
export const DEFAULT_RDS_CA_FILE = '/app/certs/rds-global-bundle.pem';

export function isTruthy(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * The discrete connection parameters, or null when the PG_* set is incomplete.
 * PG_USERNAME is preferred; PG_USER is accepted for platforms that use libpq's
 * spelling (Shepherd's migration container sets PG_USER=migration).
 */
export function pgConnectionFromEnv(env: PgEnv): PgConnection | null {
  const host = env.PG_HOST?.trim();
  const database = env.PG_DATABASE?.trim();
  const username = (env.PG_USERNAME ?? env.PG_USER)?.trim();
  if (!host || !database || !username) return null;

  const parsedPort = parseInt(env.PG_PORT?.trim() || '5432', 10);
  return {
    host,
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5432,
    database,
    username,
    password: env.PG_PASSWORD || undefined,
  };
}

/** Assemble a libpq/Prisma-style DSN, URL-encoding credentials and the database. */
export function buildDatabaseUrl(conn: PgConnection, params: Record<string, string> = {}): string {
  const auth = conn.password !== undefined
    ? `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}`
    : encodeURIComponent(conn.username);
  const query = new URLSearchParams(params).toString();
  return `postgresql://${auth}@${conn.host}:${conn.port}/${encodeURIComponent(conn.database)}${query ? `?${query}` : ''}`;
}

/**
 * Returns the DSN to use, or null when neither DATABASE_URL nor a complete
 * PG_* set is present. An explicit DATABASE_URL always wins. (Password-based
 * only — the IAM-token path needs an async signer and lives in ../db.)
 */
export function databaseUrlFromEnv(env: PgEnv): string | null {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const conn = pgConnectionFromEnv(env);
  if (!conn) return null;
  const sslmode = env.PG_SSLMODE?.trim();
  return buildDatabaseUrl(conn, sslmode ? { sslmode } : {});
}

/** Mutates `env` to set DATABASE_URL from PG_* when it is missing. */
export function applyDerivedDatabaseUrl(env: PgEnv & Record<string, string | undefined>): void {
  if (env.DATABASE_URL) return;
  const url = databaseUrlFromEnv(env);
  if (url) env.DATABASE_URL = url;
}

// ── RDS IAM authentication ────────────────────────────────────────────────────

export function iamAuthEnabled(env: PgEnv): boolean {
  return isTruthy(env.PG_IAM_AUTH);
}

/**
 * The region embedded in an RDS / RDS Proxy hostname, e.g.
 * "x.proxy-abc.us-east-1.rds.amazonaws.com" → "us-east-1". Null for anything
 * that is not an RDS endpoint.
 */
export function regionFromRdsHost(host: string): string | null {
  const m = /\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.rds\.amazonaws\.com$/i.exec(host.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Region to sign RDS IAM tokens for: explicit override, ambient region, else parsed from the host. */
export function iamSigningRegion(env: PgEnv, host: string): string | null {
  return env.PG_IAM_REGION?.trim() || env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || regionFromRdsHost(host);
}

// ── TLS posture ───────────────────────────────────────────────────────────────

export type PgSslConfig =
  | { mode: 'off' }
  | { mode: 'encrypt-only' }          // TLS, server certificate not verified (libpq sslmode=require)
  | { mode: 'verify'; caFile: string }; // TLS, server certificate verified against caFile

/**
 * Decide how to talk TLS to Postgres.
 *   - PG_SSLMODE=disable          → plaintext.
 *   - PG_SSL_CA_FILE set          → verify against it (error if the file is missing).
 *   - baked RDS bundle present    → verify against it.
 *   - PG_SSLMODE=verify-*, no CA  → error: asked to verify with nothing to verify against.
 *   - any other PG_SSLMODE, or IAM auth (RDS requires TLS) → encrypt-only.
 *   - otherwise                   → plaintext (local dev).
 */
export function pgSslConfig(env: PgEnv, fileExists: (path: string) => boolean): PgSslConfig {
  const sslmode = (env.PG_SSLMODE ?? '').trim().toLowerCase();
  if (sslmode === 'disable') return { mode: 'off' };

  const explicitCa = env.PG_SSL_CA_FILE?.trim();
  if (explicitCa) {
    if (!fileExists(explicitCa)) throw new Error(`PG_SSL_CA_FILE ${explicitCa} does not exist`);
    return { mode: 'verify', caFile: explicitCa };
  }
  if (fileExists(DEFAULT_RDS_CA_FILE)) return { mode: 'verify', caFile: DEFAULT_RDS_CA_FILE };

  if (sslmode.startsWith('verify')) {
    throw new Error(`PG_SSLMODE=${sslmode} requires a CA bundle (PG_SSL_CA_FILE or ${DEFAULT_RDS_CA_FILE})`);
  }
  if (sslmode || iamAuthEnabled(env)) return { mode: 'encrypt-only' };
  return { mode: 'off' };
}

/** The same TLS posture expressed as Prisma connection-string parameters. */
export function prismaSslParams(ssl: PgSslConfig): Record<string, string> {
  switch (ssl.mode) {
    case 'off':
      return {};
    case 'encrypt-only':
      return { sslmode: 'require', sslaccept: 'accept_invalid_certs' };
    case 'verify':
      return { sslmode: 'require', sslcert: ssl.caFile, sslaccept: 'strict' };
  }
}
