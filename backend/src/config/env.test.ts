import { describe, it, expect } from 'vitest';
import {
  databaseUrlFromEnv, applyDerivedDatabaseUrl, pgConnectionFromEnv, buildDatabaseUrl,
  isTruthy, iamAuthEnabled, regionFromRdsHost, iamSigningRegion, pgSslConfig, prismaSslParams,
  DEFAULT_RDS_CA_FILE,
} from './env';

describe('pgConnectionFromEnv', () => {
  it('returns null when the PG_* set is incomplete', () => {
    expect(pgConnectionFromEnv({})).toBeNull();
    expect(pgConnectionFromEnv({ PG_HOST: 'h', PG_DATABASE: 'd' })).toBeNull();
    expect(pgConnectionFromEnv({ PG_HOST: 'h', PG_USERNAME: 'u' })).toBeNull();
  });

  it('parses the connection with defaults and trims whitespace', () => {
    expect(pgConnectionFromEnv({ PG_HOST: ' db ', PG_DATABASE: 'termag', PG_USERNAME: 'app ' }))
      .toEqual({ host: 'db', port: 5432, database: 'termag', username: 'app', password: undefined });
    expect(pgConnectionFromEnv({ PG_HOST: 'db', PG_PORT: 'nope', PG_DATABASE: 'termag', PG_USERNAME: 'app' })!.port).toBe(5432);
    expect(pgConnectionFromEnv({ PG_HOST: 'db', PG_PORT: '6432', PG_DATABASE: 'termag', PG_USERNAME: 'app', PG_PASSWORD: 'pw' }))
      .toEqual({ host: 'db', port: 6432, database: 'termag', username: 'app', password: 'pw' });
  });

  it('accepts PG_USER as an alias for PG_USERNAME (the migration container shape)', () => {
    expect(pgConnectionFromEnv({ PG_HOST: 'h', PG_DATABASE: 'd', PG_USER: 'migration' })!.username).toBe('migration');
  });
});

describe('buildDatabaseUrl', () => {
  it('URL-encodes credentials and appends params', () => {
    expect(buildDatabaseUrl({ host: 'db', port: 5432, database: 'termag', username: 'app', password: 'p@ss/w:rd' }, { sslmode: 'require' }))
      .toBe('postgresql://app:p%40ss%2Fw%3Ard@db:5432/termag?sslmode=require');
    expect(buildDatabaseUrl({ host: 'db', port: 5432, database: 'termag', username: 'app' }))
      .toBe('postgresql://app@db:5432/termag');
  });
});

describe('databaseUrlFromEnv', () => {
  it('returns DATABASE_URL untouched when set', () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: 'postgresql://x', PG_HOST: 'h' })).toBe('postgresql://x');
  });

  it('returns null when nothing can be derived', () => {
    expect(databaseUrlFromEnv({})).toBeNull();
  });

  it('composes a DSN from PG_* including sslmode', () => {
    expect(databaseUrlFromEnv({ PG_HOST: 'db.internal', PG_DATABASE: 'termag', PG_USERNAME: 'app' }))
      .toBe('postgresql://app@db.internal:5432/termag');
    expect(databaseUrlFromEnv({
      PG_HOST: 'db.internal', PG_PORT: '6432', PG_DATABASE: 'termag',
      PG_USERNAME: 'app', PG_PASSWORD: 'p@ss/w:rd', PG_SSLMODE: 'require',
    })).toBe('postgresql://app:p%40ss%2Fw%3Ard@db.internal:6432/termag?sslmode=require');
  });
});

describe('applyDerivedDatabaseUrl', () => {
  it('sets DATABASE_URL only when missing', () => {
    const env: Record<string, string | undefined> = { PG_HOST: 'h', PG_DATABASE: 'd', PG_USERNAME: 'u' };
    applyDerivedDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe('postgresql://u@h:5432/d');

    const explicit: Record<string, string | undefined> = {
      DATABASE_URL: 'postgresql://keep', PG_HOST: 'h', PG_DATABASE: 'd', PG_USERNAME: 'u',
    };
    applyDerivedDatabaseUrl(explicit);
    expect(explicit.DATABASE_URL).toBe('postgresql://keep');
  });

  it('leaves env alone when nothing can be derived', () => {
    const env: Record<string, string | undefined> = {};
    applyDerivedDatabaseUrl(env);
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

describe('isTruthy / iamAuthEnabled', () => {
  it('accepts the usual spellings of true', () => {
    for (const v of ['true', 'TRUE', ' 1 ', 'yes', 'on']) expect(isTruthy(v)).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'no', 'banana']) expect(isTruthy(v)).toBe(false);
    expect(iamAuthEnabled({ PG_IAM_AUTH: 'true' })).toBe(true);
    expect(iamAuthEnabled({})).toBe(false);
  });
});

describe('regionFromRdsHost / iamSigningRegion', () => {
  it('extracts the region from cluster and proxy endpoints', () => {
    expect(regionFromRdsHost('termag.cluster-abc123.us-east-1.rds.amazonaws.com')).toBe('us-east-1');
    expect(regionFromRdsHost('termag.proxy-abc123.eu-central-1.rds.amazonaws.com')).toBe('eu-central-1');
    expect(regionFromRdsHost('x.proxy-abc.us-gov-west-1.rds.amazonaws.com')).toBe('us-gov-west-1');
    expect(regionFromRdsHost('localhost')).toBeNull();
    expect(regionFromRdsHost('db.example.internal')).toBeNull();
  });

  it('prefers an explicit override, then the ambient region, then the hostname', () => {
    const host = 'termag.proxy-abc.us-east-1.rds.amazonaws.com';
    expect(iamSigningRegion({ PG_IAM_REGION: 'us-west-2', AWS_REGION: 'us-east-2' }, host)).toBe('us-west-2');
    expect(iamSigningRegion({ AWS_REGION: 'us-east-2' }, host)).toBe('us-east-2');
    expect(iamSigningRegion({ AWS_DEFAULT_REGION: 'eu-west-1' }, host)).toBe('eu-west-1');
    expect(iamSigningRegion({}, host)).toBe('us-east-1');
    expect(iamSigningRegion({}, 'localhost')).toBeNull();
  });
});

describe('pgSslConfig', () => {
  const none = () => false;
  const only = (p: string) => (q: string) => q === p;

  it('is plaintext by default for local dev and when explicitly disabled', () => {
    expect(pgSslConfig({}, none)).toEqual({ mode: 'off' });
    expect(pgSslConfig({ PG_SSLMODE: 'disable', PG_IAM_AUTH: 'true' }, () => true)).toEqual({ mode: 'off' });
  });

  it('verifies against an explicit CA file and fails loudly if it is missing', () => {
    expect(pgSslConfig({ PG_SSL_CA_FILE: '/ca.pem' }, only('/ca.pem'))).toEqual({ mode: 'verify', caFile: '/ca.pem' });
    expect(() => pgSslConfig({ PG_SSL_CA_FILE: '/ca.pem' }, none)).toThrow(/does not exist/);
  });

  it('verifies against the baked RDS bundle when present', () => {
    expect(pgSslConfig({ PG_IAM_AUTH: 'true' }, only(DEFAULT_RDS_CA_FILE))).toEqual({ mode: 'verify', caFile: DEFAULT_RDS_CA_FILE });
  });

  it('falls back to encrypt-only for IAM auth or any non-verify sslmode without a CA', () => {
    expect(pgSslConfig({ PG_IAM_AUTH: 'true' }, none)).toEqual({ mode: 'encrypt-only' });
    expect(pgSslConfig({ PG_SSLMODE: 'require' }, none)).toEqual({ mode: 'encrypt-only' });
    expect(pgSslConfig({ PG_SSLMODE: 'prefer' }, none)).toEqual({ mode: 'encrypt-only' });
  });

  it('refuses verify-* without anything to verify against', () => {
    expect(() => pgSslConfig({ PG_SSLMODE: 'verify-full' }, none)).toThrow(/requires a CA bundle/);
  });
});

describe('prismaSslParams', () => {
  it('maps each posture to Prisma connection-string params', () => {
    expect(prismaSslParams({ mode: 'off' })).toEqual({});
    expect(prismaSslParams({ mode: 'encrypt-only' })).toEqual({ sslmode: 'require', sslaccept: 'accept_invalid_certs' });
    expect(prismaSslParams({ mode: 'verify', caFile: '/ca.pem' })).toEqual({ sslmode: 'require', sslcert: '/ca.pem', sslaccept: 'strict' });
  });
});
