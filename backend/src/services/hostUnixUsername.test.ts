import { describe, expect, it } from 'vitest';
import { explainHostUnixUsername, HostUnixUsernameError } from './hostUnixUsername';

describe('explainHostUnixUsername', () => {
  it.each([
    'alice',
    'j-doe',
    'christopher.schmitz',
    'zoe',
    `a${'0'.repeat(31)}`,
  ])('allows %s', (name) => {
    expect(explainHostUnixUsername(name)).toBeNull();
  });

  it.each([
    '',
    'Alice',
    '../etc',
    'a;rm',
    `a${'0'.repeat(32)}`,
    '1abc',
    'jane+work',
  ])('rejects invalid pattern %j with actionable copy', (name) => {
    expect(explainHostUnixUsername(name)).toBe(
      `Unix username "${name}" cannot be provisioned on this host (must be 1–32 characters, start with a letter or underscore, and use only lowercase letters, digits, dot, underscore, or hyphen).`,
    );
  });

  it.each([
    'root',
    'termag',
    'ubuntu',
    'ssm-user',
    'nobody',
    'admin',
    'sudo',
    'adm',
    'docker',
    'postgres',
    'www-data',
    'lxd',
    'sync',
    'daemon',
    'bin',
    'sys',
    'games',
    'man',
    'mail',
    'news',
    'backup',
    'systemd-network',
    'systemd-anything',
    '_apt',
    '_ok',
  ])('rejects reserved name %s with actionable copy', (name) => {
    const expected = `Unix username "${name}" is reserved on this host and cannot be auto-provisioned. Use a box, or ask an admin to map your email to a different unix username.`;
    expect(explainHostUnixUsername(name)).toBe(expected);
    expect(new HostUnixUsernameError(name)).toMatchObject({ status: 400, message: expected });
  });
});
