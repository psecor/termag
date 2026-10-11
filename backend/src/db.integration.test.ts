/**
 * The RDS connection path against a real Postgres: the IAM pool through Prisma's
 * driver adapter, db:push as `migration` with a minted token, additive schema
 * sync, the role bootstrap's grants, and db:guard.
 *
 * Needs TERMAG_TEST_PG_URL: a superuser URL on a cluster that trusts local
 * connections, so the IAM tokens the code mints are accepted as passwords
 * (`make e2e-up`'s Postgres is one: postgresql://termag@127.0.0.1:55432/postgres).
 * Skipped without it. Each run uses its own database; the `migration`,
 * `application` and `rds_iam` roles are cluster-wide and are created if absent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const backendRoot = join(__dirname, '..');
const repoRoot = join(backendRoot, '..');
const tsx = join(backendRoot, 'node_modules', '.bin', 'tsx');

// Shared across every copy of the mocked module, however many times it loads.
const signed = vi.hoisted(() => ({ users: [] as string[] }));
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class {
    constructor(readonly opts: { username: string }) {}
    async getAuthToken() {
      signed.users.push(this.opts.username);
      return `fake-token-${this.opts.username}-${signed.users.length}`;
    }
  },
}));

describe.skipIf(!adminUrl)('RDS connection path (integration)', () => {
  const dbName = `termag_it_${process.pid}_${Date.now()}`;
  let host = '';
  let port = 0;
  let dataDir = '';

  const admin = (database = 'postgres') => {
    const u = new URL(adminUrl!);
    u.pathname = `/${database}`;
    return u.toString();
  };
  async function sql(database: string, user: string | null, text: string) {
    const u = new URL(admin(database));
    if (user) u.username = user;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
      return await c.query(text);
    } finally {
      await c.end();
    }
  }

  function iamEnv(username: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOTENV_CONFIG_PATH: '/dev/null',
      CHECKPOINT_DISABLE: '1',
      PG_IAM_AUTH: 'true',
      PG_HOST: host,
      PG_PORT: String(port),
      PG_DATABASE: dbName,
      PG_USERNAME: username,
      PG_SSLMODE: 'disable',
      AWS_REGION: 'us-east-2',
      // The real signer presigns locally; any well-formed credentials will do.
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEINTEGRATION',
      AWS_SECRET_ACCESS_KEY: 'integration-test-secret',
      TERMAG_DATA_DIR: dataDir,
      ...extra,
    };
  }
  const run = (script: string, env: NodeJS.ProcessEnv) =>
    spawnSync(tsx, [join('src', 'scripts', script)], { cwd: backendRoot, env, encoding: 'utf8', timeout: 120_000 });

  beforeAll(async () => {
    const u = new URL(adminUrl!);
    host = u.hostname;
    port = Number(u.port || 5432);
    dataDir = mkdtempSync(join(tmpdir(), 'termag-it-data-'));

    // rds_iam and a non-superuser master that owns the database, as on RDS.
    await sql('postgres', null, `DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_iam') THEN CREATE ROLE rds_iam NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'it_administrator') THEN
        CREATE ROLE it_administrator LOGIN; GRANT rds_iam TO it_administrator WITH ADMIN OPTION;
      END IF;
      ALTER ROLE it_administrator CREATEROLE CREATEDB; END $$`);
    await sql('postgres', null, `CREATE DATABASE ${dbName} OWNER it_administrator`);

    const u2 = new URL(admin(dbName));
    u2.username = 'it_administrator';
    const boot = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', u2.toString(), '-f', join(repoRoot, 'deploy', 'termag-rds-bootstrap.sql')], { encoding: 'utf8' });
    expect(boot.status, boot.stderr).toBe(0);
  }, 60_000);

  afterAll(async () => {
    if (!adminUrl) return;
    await sql('postgres', null, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('db:push as migration syncs the schema with a minted IAM token, and migration owns it', async () => {
    const r = run('dbPush.ts', iamEnv('migration', { DB_PUSH_MODE: 'additive' }));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/minting RDS IAM token for migration@/);
    expect(r.stdout).toMatch(/mode=additive/);
    const owners = await sql(dbName, null, `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`);
    expect(owners.rows.map(r => r.tableowner)).toEqual(['migration']);
  }, 120_000);

  it('the IAM pool reaches the database as application through the Prisma adapter', async () => {
    const { iamPoolConfig } = await import('./db');
    const { Pool } = await import('pg');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('@prisma/client');

    const config = iamPoolConfig(iamEnv('application'));
    // A function, so node-postgres asks for a fresh token on every new connection.
    // Trust auth never requests a password, so the server never calls it here.
    expect(typeof config.password).toBe('function');
    const before = signed.users.length;
    expect(await (config.password as () => Promise<string>)()).toMatch(/^fake-token-application-/);
    expect(signed.users.slice(before)).toEqual(['application']);

    const pool = new Pool(config);
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      const [{ who }] = await prisma.$queryRaw<{ who: string }[]>`SELECT current_user::text AS who`;
      expect(who).toBe('application');
      await prisma.user.create({ data: { id: 'it-user', googleId: 'g-it', googleEmail: 'it@example.test', unixUsername: 'it', displayName: 'IT' } });
      expect(await prisma.user.count()).toBe(1);
      await expect(prisma.$executeRawUnsafe('CREATE TABLE app_ddl (id int)')).rejects.toThrow(/permission denied/);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  }, 60_000);

  it('additive mode keeps a column that holds data, and the default mode drops it', async () => {
    await sql(dbName, 'migration', `ALTER TABLE users ADD COLUMN future_col text; UPDATE users SET future_col = 'keep'`);

    const additive = run('dbPush.ts', iamEnv('migration', { DB_PUSH_MODE: 'additive' }));
    expect(additive.status, additive.stderr).toBe(0);
    expect(additive.stderr).toMatch(/schema sync SKIPPED/);
    expect(additive.stderr).toMatch(/future_col/);
    const kept = await sql(dbName, null, `SELECT future_col FROM users`);
    expect(kept.rows).toEqual([{ future_col: 'keep' }]);

    const destructive = run('dbPush.ts', iamEnv('migration'));
    expect(destructive.status, destructive.stderr).toBe(0);
    const cols = await sql(dbName, null, `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'future_col'`);
    expect(cols.rowCount).toBe(0);
  }, 180_000);

  it('db:guard passes a restored RDS database and refuses an empty one unless allowed', async () => {
    const ok = run('dbGuard.ts', iamEnv('application'));
    expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    expect(ok.stdout).toMatch(/restored \(1 users\)/);

    await sql(dbName, 'migration', `DELETE FROM users`);
    const refused = run('dbGuard.ts', iamEnv('application'));
    expect(refused.status).toBe(3);
    expect(refused.stdout).toMatch(/never restored/);

    writeFileSync(join(dataDir, 'ALLOW_EMPTY_DATABASE'), '');
    const allowed = run('dbGuard.ts', iamEnv('application'));
    expect(allowed.status).toBe(0);
  }, 60_000);

  it('db:guard in local mode refuses after the cutover marker until the rollback allowance exists', () => {
    const localEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: '/dev/null', TERMAG_DATA_DIR: dataDir, DATABASE_URL: admin(dbName) };
    expect(run('dbGuard.ts', localEnv).status).toBe(0);
    writeFileSync(join(dataDir, 'DATABASE_MOVED_TO_RDS'), 'moved_at=now\n');
    const refused = run('dbGuard.ts', localEnv);
    expect(refused.status).toBe(3);
    expect(refused.stdout).toMatch(/moved to RDS/);
    writeFileSync(join(dataDir, 'ALLOW_DOCKER_ROLLBACK'), '');
    expect(run('dbGuard.ts', localEnv).status).toBe(0);
  }, 60_000);
});
