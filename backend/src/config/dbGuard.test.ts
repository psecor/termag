import { describe, it, expect } from 'vitest';
import { dataDirFromEnv, guardLocalDatabase, guardRdsDatabase, type GuardMarkers } from './dbGuard';

const none: GuardMarkers = { movedToRds: false, allowDockerRollback: false, allowEmptyDatabase: false };
const dir = '/srv/termag';

describe('dataDirFromEnv', () => {
  it('defaults to the orchestrator data volume', () => {
    expect(dataDirFromEnv({})).toBe('/srv/termag');
    expect(dataDirFromEnv({ TERMAG_DATA_DIR: ' /tmp/x ' })).toBe('/tmp/x');
  });
});

describe('guardLocalDatabase', () => {
  it('lets every install that never moved start', () => {
    expect(guardLocalDatabase(none, dir).ok).toBe(true);
  });

  it('refuses the stale container copy once the database moved to RDS', () => {
    const d = guardLocalDatabase({ ...none, movedToRds: true }, dir);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/DATABASE_MOVED_TO_RDS/);
    expect(d.message).toMatch(/rollback-to-docker/);
  });

  it('allows it again after RDS was copied back', () => {
    expect(guardLocalDatabase({ ...none, movedToRds: true, allowDockerRollback: true }, dir).ok).toBe(true);
  });

  it('ignores ALLOW_EMPTY_DATABASE, which is about RDS', () => {
    expect(guardLocalDatabase({ ...none, movedToRds: true, allowEmptyDatabase: true }, dir).ok).toBe(false);
  });
});

describe('guardRdsDatabase', () => {
  it('passes a restored database', () => {
    expect(guardRdsDatabase(none, { exists: true, rows: 12 }, dir)).toEqual({ ok: true, message: 'RDS database restored (12 users)' });
  });

  it('refuses a database that was never restored, with or without a users table', () => {
    const missing = guardRdsDatabase(none, { exists: false, rows: 0 }, dir);
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/no users table/);
    const empty = guardRdsDatabase(none, { exists: true, rows: 0 }, dir);
    expect(empty.ok).toBe(false);
    expect(empty.message).toMatch(/empty users table/);
  });

  it('allows an empty database for a brand-new install', () => {
    expect(guardRdsDatabase({ ...none, allowEmptyDatabase: true }, { exists: false, rows: 0 }, dir).ok).toBe(true);
  });

  it('does not care about the local-mode markers', () => {
    expect(guardRdsDatabase({ ...none, movedToRds: true }, { exists: true, rows: 1 }, dir).ok).toBe(true);
  });
});
