import { describe, it, expect } from 'vitest';
import { parseAllowedUsers, resolveUnixUsername } from './allowedUsers';

describe('resolveUnixUsername', () => {
  const config = parseAllowedUsers(
    'Admin@example.com:root, @example.org, @acme.com:deploy'
  );

  it('returns the unix user for an exact email match', () => {
    expect(resolveUnixUsername(config, 'Admin@example.com')).toBe('root');
  });

  it('matches exact emails case-insensitively', () => {
    expect(resolveUnixUsername(config, 'admin@example.com')).toBe('root');
  });

  it('prefers an exact match over a domain wildcard', () => {
    const c = parseAllowedUsers('jane@example.org:special, @example.org');
    expect(resolveUnixUsername(c, 'jane@example.org')).toBe('special');
  });

  it('derives the unix user from the local part for a bare domain wildcard', () => {
    expect(resolveUnixUsername(config, 'alice@example.org')).toBe('alice');
  });

  it('lowercases the derived username and matches the domain case-insensitively', () => {
    expect(resolveUnixUsername(config, 'Bob@EXAMPLE.org')).toBe('bob');
  });

  it('strips plus-addressing aliases from the derived username', () => {
    expect(resolveUnixUsername(config, 'jane+work@example.org')).toBe('jane');
  });

  it('maps a fixed-user domain wildcard to its unix user', () => {
    expect(resolveUnixUsername(config, 'someone@acme.com')).toBe('deploy');
  });

  it('rejects emails outside the allow-list', () => {
    expect(resolveUnixUsername(config, 'nobody@other.com')).toBeUndefined();
  });

  it('rejects empty and malformed emails', () => {
    expect(resolveUnixUsername(config, '')).toBeUndefined();
    expect(resolveUnixUsername(config, 'malformed')).toBeUndefined();
    expect(resolveUnixUsername(config, '@nolocalpart.com')).toBeUndefined();
  });

  it('uses first-match-wins for duplicate domain rules', () => {
    const c = parseAllowedUsers('@dupe.com, @dupe.com:shared');
    expect(resolveUnixUsername(c, 'first@dupe.com')).toBe('first');
  });
});

describe('parseAllowedUsers', () => {
  it('ignores blank and malformed entries', () => {
    const c = parseAllowedUsers(' , good@example.com:gu, broken-no-colon, ');
    expect(c.exact.size).toBe(1);
    expect(c.domains).toHaveLength(0);
    expect(resolveUnixUsername(c, 'good@example.com')).toBe('gu');
  });

  it('handles an undefined env value', () => {
    const c = parseAllowedUsers(undefined);
    expect(c.exact.size).toBe(0);
    expect(c.domains).toHaveLength(0);
  });
});
