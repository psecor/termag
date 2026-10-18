import { describe, it, expect } from 'vitest';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  managedBlock,
  parseSshPublicKey,
  rewriteAuthorizedKeys,
  SshKeyError,
} from './sshKeys';

// Generated with ssh-keygen; fingerprints and bit counts are what `ssh-keygen -l -f` printed.
const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 fixture-ed25519';
const ECDSA256 = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNRCnYISflZVoBjhlkKC6UYS9rB+suogLhVDpPIAT0mqbraOsXtX5jz0fD24yT6ac4bMQLB2CdQZZ/rAbtiUZkY= fixture-ecdsa256';
const ECDSA384 = 'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBLHTQ2iKe6Iv8HrJ9kAiXTYN9dIJUXw+k8nhkekTyFUgeYBT7Y+Ms59QpA2OflIV1egJKi0ukpfp4ZQdwyj9MebBK1RIo2xnrEXTgU6TTiE73VIyZK4eABW6XeQFYboqAw== fixture-ecdsa384';
const ECDSA521 = 'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBACHKVgRoTlwmjbdvAsjNmwfbiqROiP8azKo7Y9i7S9n+rp/9neDWTZURS/Jdp6Ynea2DtS7otC8NmJjv8hIX+3CSAB08bbzjz9Z0gojIxZBhYBpzsgri9mb3XF1M/NiBh56j8x/JiGKv+oVqi5/9CsGu/gnSxfdehVKqKeTclzXdHOftQ== fixture-ecdsa521';
const RSA3072 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDARVogWextbNX8mHeGrF4MPy7ffdUBjjsP6gA4kvhUBPi63YtN53yttMjYGaqHN/4X/5pZF2o8lAYDEWIfh6uBFb0SbVen0B47OwYdEKYhOOjxn8hQUeedMblwgKaMWY/tRf9mp5AboNIVAvhttRewNqHkiGDKg5au5rTpE/UjoHEv52lcJcoq06uy0ZTrmgRdaU066H8QeNlhuJS+tIqOpl7z/nVLEvlLpbcpSlr8BodPvS4uSzbflJI5AOH2vQMswNhsLsvZQ5xzCQVe+3mcI0oKlv3EOJwu3no92K7DQz2Q0U56BQ4Y0I5xmGAcrjY0v3DTyOJzYCNmHqfdyibOn6lo6HlGCfwJt1o518iry1mdKnMoQLav/7WwDjZYttasBKis8cHl+FjUN9xGndlGIglzB68OtqOmrPaPLFX4g88dGsP3+XOHfDGlWHu1F2n9/zXM/wiTnBg/nxG08k+hd1culVkVELYsxhI+UtdAZJOof+1knfgCLlHNVi2A5F0= fixture-rsa3072';
const RSA2048 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC1VvHmD+ALeC02mU8VKBiwuKS4AeQKLoe/hMz3KGC3A4KKyWdGYYjzI958vE20b/t84vyymzk77oHyyC65RPAQJ3+uXQzc8ErvgZM3jKUEOXFt6fEZX0T4hiQViRu0hJXV2Grui+7oi98SP6yB58TyqhG5A8liN7m/vODe+dY2hcCXN3dNNzbz24yHzjakt/atEjIgSFx3RJlieaCcboCucwr7b6YuBzzM5GE5jldbBDVYl2jfipDekpcxa+fz5hzruNtN+E48YPIhICTuqPd6lhjM435tNaXYgCheJveYVpQnz5to1OCyhYrDD194IEX4/U3K6yn10vR1UNseJcZ9 fixture-rsa2048';

function blobOf(line: string): Buffer {
  return Buffer.from(line.split(' ')[1], 'base64');
}

function lineWith(type: string, blob: Buffer, comment = 'x'): string {
  return `${type} ${blob.toString('base64')} ${comment}`;
}

describe('parseSshPublicKey', () => {
  it.each([
    [ED25519, 'ssh-ed25519', 256, 'SHA256:ZnRevkBTCgJnh2VrIgfnKVQeliMRgvmIxaSgFpWOK74'],
    [ECDSA256, 'ecdsa-sha2-nistp256', 256, 'SHA256:H4R3Wciqi9nItKxhIEu2ryM+ZdfuVgT4ZeT7QJqXZx4'],
    [ECDSA384, 'ecdsa-sha2-nistp384', 384, 'SHA256:peoah9EFIuyYndagNOgXf1OFlcPsxiqW5JgYGx/0Bag'],
    [ECDSA521, 'ecdsa-sha2-nistp521', 521, 'SHA256:YSO2CvuAYzYDeo+4bHu1w6cCuCXV8a5TcRDWmn18rmY'],
    [RSA3072, 'ssh-rsa', 3072, 'SHA256:yrE05Lh4/7m6fnIMTwIXsAiniemW/qjldgYkxcx+cZ4'],
  ])('accepts %#: type, bits and fingerprint match ssh-keygen -l', (line, type, bits, fingerprint) => {
    const k = parseSshPublicKey(line);
    expect(k.type).toBe(type);
    expect(k.bits).toBe(bits);
    expect(k.fingerprint).toBe(fingerprint);
    expect(k.line).toBe(line);
  });

  it('rejects ssh-rsa under 3072 bits', () => {
    expect(() => parseSshPublicKey(RSA2048)).toThrow(/at least 3072 bits \(this one is 2048\)/);
  });

  it('normalizes surrounding and internal whitespace', () => {
    const [t, b, c] = ED25519.split(' ');
    const k = parseSshPublicKey(`  ${t}\t${b}   ${c}  \n`);
    expect(k.line).toBe(ED25519);
  });

  it('accepts a key without a comment and keeps multi-word comments', () => {
    const [t, b] = ED25519.split(' ');
    expect(parseSshPublicKey(`${t} ${b}`).line).toBe(`${t} ${b}`);
    expect(parseSshPublicKey(`${t} ${b} alice at laptop`).comment).toBe('alice at laptop');
  });

  it.each([
    ['empty', ''],
    ['two keys', `${ED25519}\n${ECDSA256}`],
    ['an options prefix', `restrict,command="true" ${ED25519}`],
    ['a certificate', lineWith('ssh-ed25519-cert-v01@openssh.com', blobOf(ED25519))],
    ['a security key', lineWith('sk-ssh-ed25519@openssh.com', blobOf(ED25519))],
    ['ssh-dss', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP x'],
    ['an unknown curve', lineWith('ecdsa-sha2-nistp999', blobOf(ECDSA256))],
    ['non-base64 data', 'ssh-ed25519 not*base64 x'],
    ['a private key header', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSshPublicKey(input)).toThrow(SshKeyError);
  });

  it('rejects a blob whose inner type differs from the declared one', () => {
    expect(() => parseSshPublicKey(lineWith('ssh-rsa', blobOf(ED25519)))).toThrow(/does not match/);
  });

  it('rejects truncated and padded blobs', () => {
    const blob = blobOf(ED25519);
    expect(() => parseSshPublicKey(lineWith('ssh-ed25519', blob.subarray(0, blob.length - 1)))).toThrow(SshKeyError);
    expect(() => parseSshPublicKey(lineWith('ssh-ed25519', Buffer.concat([blob, Buffer.from([0])])))).toThrow(/trailing data/);
  });

  it('rejects an ecdsa blob that names a different curve', () => {
    expect(() => parseSshPublicKey(lineWith('ecdsa-sha2-nistp384', Buffer.concat([
      Buffer.from([0, 0, 0, 19]), Buffer.from('ecdsa-sha2-nistp384'),
      blobOf(ECDSA256).subarray(4 + 19),
    ])))).toThrow(/different curve/);
  });

  it('rejects comments that could escape a line or smuggle control characters', () => {
    const [t, b] = ED25519.split(' ');
    expect(() => parseSshPublicKey(`${t} ${b} a\rb`)).toThrow(SshKeyError);
    expect(() => parseSshPublicKey(`${t} ${b} caf\u00e9`)).toThrow(/printable ASCII/);
    expect(() => parseSshPublicKey(`${t} ${b} ${'c'.repeat(201)}`)).toThrow(/at most 200/);
  });
});

describe('rewriteAuthorizedKeys', () => {
  const HAND = 'ssh-ed25519 AAAAhand hand-added@laptop';

  it('creates the block in a missing or empty file', () => {
    expect(rewriteAuthorizedKeys(null, [ED25519])).toBe(`${MANAGED_BEGIN}\n${ED25519}\n${MANAGED_END}\n`);
    expect(rewriteAuthorizedKeys('', [ED25519])).toBe(managedBlock([ED25519]));
  });

  it('appends after hand-added keys and leaves them alone', () => {
    expect(rewriteAuthorizedKeys(`${HAND}\n`, [ED25519])).toBe(`${HAND}\n${managedBlock([ED25519])}`);
    expect(rewriteAuthorizedKeys(HAND, [ED25519])).toBe(`${HAND}\n${managedBlock([ED25519])}`);
  });

  it('replaces the managed block in place of the old set, keeping keys on both sides', () => {
    const before = `${HAND}\n${managedBlock([ED25519, ECDSA256])}# after\n${RSA3072}\n`;
    const after = rewriteAuthorizedKeys(before, [ECDSA256]);
    expect(after).toContain(HAND);
    expect(after).toContain(`# after\n${RSA3072}\n`);
    expect(after).not.toContain(ED25519);
    expect(after.match(new RegExp(MANAGED_BEGIN, 'g'))).toHaveLength(1);
    expect(after.endsWith(managedBlock([ECDSA256]))).toBe(true);
  });

  it('removes the block entirely when the owner has no keys', () => {
    expect(rewriteAuthorizedKeys(`${HAND}\n${managedBlock([ED25519])}`, [])).toBe(`${HAND}\n`);
  });

  it('leaves a file with no block byte-for-byte alone when there are no keys', () => {
    const file = `${HAND}\n\n# trailing blank lines kept\n\n`;
    expect(rewriteAuthorizedKeys(file, [])).toBe(file);
  });

  it('is idempotent', () => {
    const once = rewriteAuthorizedKeys(`${HAND}\n`, [ED25519, RSA3072]);
    expect(rewriteAuthorizedKeys(once, [ED25519, RSA3072])).toBe(once);
  });

  it('treats an unterminated block as running to end of file, so removed keys go', () => {
    const file = `${HAND}\n${MANAGED_BEGIN}\n${ED25519}\n`;
    expect(rewriteAuthorizedKeys(file, [])).toBe(`${HAND}\n`);
  });

  it('recognizes markers with CRLF endings', () => {
    const file = `${HAND}\r\n${MANAGED_BEGIN}\r\n${ED25519}\r\n${MANAGED_END}\r\n`;
    expect(rewriteAuthorizedKeys(file, [])).toBe(`${HAND}\r\n`);
  });
});
