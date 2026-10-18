import { describe, it, expect } from 'vitest';
import { parseAdminUsers, isAdminEmail, isEmptyAdminConfig } from './adminUsers';

describe('parseAdminUsers / isAdminEmail', () => {
  const config = parseAdminUsers(' Ops@Example.com , @acme.io, jane@example.org:jane ');

  it('matches exact emails case-insensitively', () => {
    expect(isAdminEmail(config, 'ops@example.com')).toBe(true);
    expect(isAdminEmail(config, 'OPS@EXAMPLE.COM')).toBe(true);
  });

  it('matches domain wildcards', () => {
    expect(isAdminEmail(config, 'anyone@acme.io')).toBe(true);
    expect(isAdminEmail(config, 'anyone@notacme.io')).toBe(false);
  });

  it('tolerates and ignores an ALLOWED_USERS-style :unixuser suffix', () => {
    expect(isAdminEmail(config, 'jane@example.org')).toBe(true);
  });

  it('rejects everyone else, including empty and malformed emails', () => {
    expect(isAdminEmail(config, 'bob@example.com')).toBe(false);
    expect(isAdminEmail(config, '')).toBe(false);
    expect(isAdminEmail(config, null)).toBe(false);
    expect(isAdminEmail(config, '@acme.io')).toBe(false);
  });

  it('ignores entries that are neither an email nor a domain', () => {
    const c = parseAdminUsers('root, @, ,');
    expect(isEmptyAdminConfig(c)).toBe(true);
    expect(isAdminEmail(c, 'root')).toBe(false);
  });

  it('is fail-closed when unset', () => {
    const c = parseAdminUsers(undefined);
    expect(isEmptyAdminConfig(c)).toBe(true);
    expect(isAdminEmail(c, 'ops@example.com')).toBe(false);
  });
});
