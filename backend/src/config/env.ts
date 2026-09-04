/**
 * Environment derivation shared by the container and host deployments.
 *
 * Container platforms typically inject a Postgres connection as discrete
 * PG_* variables (host, port, database, user, password) rather than a single
 * DSN. Prisma and connect-pg-simple both want DATABASE_URL, so compose one when
 * it is absent. An explicit DATABASE_URL always wins.
 *
 * Kept pure (no process.env access) so it is unit-testable; the side-effecting
 * application lives in ./bootstrap.
 */

export interface PgEnv {
  PG_HOST?: string;
  PG_PORT?: string;
  PG_DATABASE?: string;
  PG_USERNAME?: string;
  PG_USER?: string;
  PG_PASSWORD?: string;
  PG_SSLMODE?: string;
  DATABASE_URL?: string;
}

/**
 * Returns the DSN to use, or null when neither DATABASE_URL nor a complete
 * PG_* set is present. PG_USERNAME is preferred; PG_USER is accepted for
 * platforms that use libpq's spelling.
 */
export function databaseUrlFromEnv(env: PgEnv): string | null {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const host = env.PG_HOST?.trim();
  const database = env.PG_DATABASE?.trim();
  const username = (env.PG_USERNAME ?? env.PG_USER)?.trim();
  if (!host || !database || !username) return null;

  const port = env.PG_PORT?.trim() || '5432';
  const auth = env.PG_PASSWORD
    ? `${encodeURIComponent(username)}:${encodeURIComponent(env.PG_PASSWORD)}`
    : encodeURIComponent(username);

  const params = new URLSearchParams();
  if (env.PG_SSLMODE?.trim()) params.set('sslmode', env.PG_SSLMODE.trim());
  const query = params.toString();

  return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(database)}${query ? `?${query}` : ''}`;
}

/** Mutates `env` to set DATABASE_URL from PG_* when it is missing. */
export function applyDerivedDatabaseUrl(env: PgEnv & Record<string, string | undefined>): void {
  if (env.DATABASE_URL) return;
  const url = databaseUrlFromEnv(env);
  if (url) env.DATABASE_URL = url;
}
