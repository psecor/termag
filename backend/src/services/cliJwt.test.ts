import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'crypto';
import { CLI_JWT_AUDIENCE, CliJwt, isJwtShaped, localCliJwtKey, rsaJwk, type CliJwtKey } from './cliJwt';

const ISSUER = 'https://termag.example.com/termag';
const NOW = Date.parse('2026-10-06T12:00:00Z');

function decode(token: string) {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
  };
}

/** Re-sign a modified header/payload with `key`, as an attacker holding some other key would. */
async function resign(key: CliJwtKey, header: object, payload: object): Promise<string> {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${(await key.sign(Buffer.from(input))).toString('base64url')}`;
}

describe('rsaJwk', () => {
  it('uses the RFC 7638 thumbprint as kid', () => {
    // The example key and thumbprint from RFC 7638 section 3.1.
    const n = '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
    const publicKey = createPublicKey({ key: { kty: 'RSA', n, e: 'AQAB' }, format: 'jwk' });
    expect(rsaJwk(publicKey)).toEqual({
      kty: 'RSA', n, e: 'AQAB', alg: 'RS256', use: 'sig', kid: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
    });
  });
});

describe('CliJwt', () => {
  const key = localCliJwtKey();
  const jwt = new CliJwt(ISSUER, [key]);

  it('issues RS256 tokens with the claims the ALB rule checks, and no iat or nbf', async () => {
    const { token, expiresIn } = await jwt.issue('alice', 's1', NOW);
    expect(isJwtShaped(token)).toBe(true);
    expect(expiresIn).toBe(3600);
    expect(decode(token)).toEqual({
      header: { alg: 'RS256', typ: 'JWT', kid: jwt.jwks().keys[0].kid },
      payload: { iss: ISSUER, aud: CLI_JWT_AUDIENCE, sub: 'alice', jti: 's1', exp: NOW / 1000 + 3600 },
    });
    expect(jwt.verify(token, NOW)).toEqual({ sub: 'alice', jti: 's1', exp: NOW / 1000 + 3600 });
  });

  it('refuses expired, tampered and foreign tokens', async () => {
    const { token } = await jwt.issue('alice', 's1', NOW);
    const { header, payload } = decode(token);
    expect(jwt.verify(token, NOW + 3600_000)).toBeNull();

    const [h, , s] = token.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...payload, sub: 'bob' })).toString('base64url')}.${s}`;
    expect(jwt.verify(tampered, NOW)).toBeNull();

    const foreign = localCliJwtKey();
    expect(jwt.verify(await resign(foreign, header, payload), NOW)).toBeNull();
    expect(jwt.verify(await resign(key, { ...header, alg: 'none' }, payload), NOW)).toBeNull();
    expect(jwt.verify(await resign(key, header, { ...payload, iss: 'https://evil.example.com' }), NOW)).toBeNull();
    expect(jwt.verify(await resign(key, header, { ...payload, aud: 'something-else' }), NOW)).toBeNull();
    expect(jwt.verify(await resign(key, header, { ...payload, jti: 7 }), NOW)).toBeNull();
    expect(jwt.verify('not.a.jwt', NOW)).toBeNull();
  });

  it('signs with the first key and accepts every published one', async () => {
    const next = localCliJwtKey();
    const old = await jwt.issue('alice', 's1', NOW);
    const rotated = new CliJwt(ISSUER, [next, key]);
    expect(rotated.jwks().keys.map(k => k.kid)).toEqual([rsaJwk(next.publicKey).kid, rsaJwk(key.publicKey).kid]);
    const fresh = await rotated.issue('alice', 's1', NOW);
    expect(decode(fresh.token).header.kid).toBe(rsaJwk(next.publicKey).kid);
    expect(rotated.verify(fresh.token, NOW)).not.toBeNull();
    expect(rotated.verify(old.token, NOW)).not.toBeNull();
    expect(jwt.verify(fresh.token, NOW)).toBeNull();
  });
});
