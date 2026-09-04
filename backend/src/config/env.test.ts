import { describe, it, expect } from 'vitest';
import { databaseUrlFromEnv, applyDerivedDatabaseUrl } from './env';

describe('databaseUrlFromEnv', () => {
  it('returns DATABASE_URL untouched when set', () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: 'postgresql://x', PG_HOST: 'h' })).toBe('postgresql://x');
  });

  it('returns null when the PG_* set is incomplete', () => {
    expect(databaseUrlFromEnv({})).toBeNull();
    expect(databaseUrlFromEnv({ PG_HOST: 'h', PG_DATABASE: 'd' })).toBeNull();
    expect(databaseUrlFromEnv({ PG_HOST: 'h', PG_USERNAME: 'u' })).toBeNull();
  });

  it('composes a DSN from PG_* with a default port and no password', () => {
    expect(databaseUrlFromEnv({ PG_HOST: 'db.internal', PG_DATABASE: 'termag', PG_USERNAME: 'app' }))
      .toBe('postgresql://app@db.internal:5432/termag');
  });

  it('includes password, explicit port, sslmode, and URL-encodes credentials', () => {
    expect(databaseUrlFromEnv({
      PG_HOST: 'db.internal', PG_PORT: '6432', PG_DATABASE: 'termag',
      PG_USERNAME: 'app', PG_PASSWORD: 'p@ss/w:rd', PG_SSLMODE: 'require',
    })).toBe('postgresql://app:p%40ss%2Fw%3Ard@db.internal:6432/termag?sslmode=require');
  });

  it('accepts PG_USER as an alias for PG_USERNAME', () => {
    expect(databaseUrlFromEnv({ PG_HOST: 'h', PG_DATABASE: 'd', PG_USER: 'migration' }))
      .toBe('postgresql://migration@h:5432/d');
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
