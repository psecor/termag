/**
 * Access tokens for /api/cli/v1: RS256 JWTs the orchestrator's ALB checks with
 * its jwt-validation action (terraform projects/termag, the `cli_jwt` rule)
 * before a laptop's request reaches us, so the CLI API needs no source-IP
 * allowlist. Each is minted from a `tmcli_` device session, which stays the
 * refresh token; `jti` is that session's id, and cliBearer still checks the
 * session on every request, so revoking it takes effect immediately.
 *
 * Pure apart from node:crypto. services/cliJwtKms.ts provides the KMS keys.
 */
import { createHash, generateKeyPairSync, sign as rsaSign, verify as rsaVerify, type KeyObject } from 'crypto';

export const CLI_JWT_AUDIENCE = 'termag-cli';
export const CLI_ACCESS_TOKEN_TTL_S = 60 * 60;

export interface CliJwtKey {
  publicKey: KeyObject;
  /** RSASSA-PKCS1-v1_5 with SHA-256 over `data`. */
  sign(data: Buffer): Promise<Buffer>;
}

export interface CliAccessClaims {
  sub: string;
  jti: string;
  exp: number;
}

interface RsaJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

/** The public JWK, with its RFC 7638 thumbprint as `kid`. */
export function rsaJwk(publicKey: KeyObject): RsaJwk {
  const { kty, n, e } = publicKey.export({ format: 'jwk' });
  if (kty !== 'RSA' || !n || !e) throw new Error('CLI access-token keys must be RSA');
  // RFC 7638 hashes the required members, in lexicographic order, with no whitespace.
  const kid = createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url');
  return { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function isJwtShaped(raw: string): boolean {
  return raw.startsWith('eyJ') && raw.split('.').length === 3;
}

/**
 * Signs with the first key; verifies and publishes all of them, so a new key
 * can be published before it signs and an old one kept until its tokens lapse.
 */
export class CliJwt {
  private readonly published: Array<{ jwk: RsaJwk; publicKey: KeyObject }>;

  constructor(readonly issuer: string, private readonly keys: CliJwtKey[]) {
    if (keys.length === 0) throw new Error('CliJwt needs at least one key');
    this.published = keys.map(k => ({ jwk: rsaJwk(k.publicKey), publicKey: k.publicKey }));
  }

  jwks(): { keys: RsaJwk[] } {
    return { keys: this.published.map(p => p.jwk) };
  }

  async issue(sub: string, jti: string, nowMs: number): Promise<{ token: string; expiresIn: number }> {
    const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid: this.published[0].jwk.kid });
    // No iat or nbf: the ALB checks them when present and documents no clock-skew leeway.
    const exp = Math.floor(nowMs / 1000) + CLI_ACCESS_TOKEN_TTL_S;
    const payload = encodeJson({ iss: this.issuer, aud: CLI_JWT_AUDIENCE, sub, jti, exp });
    const signature = await this.keys[0].sign(Buffer.from(`${header}.${payload}`));
    return { token: `${header}.${payload}.${signature.toString('base64url')}`, expiresIn: CLI_ACCESS_TOKEN_TTL_S };
  }

  verify(token: string, nowMs: number): CliAccessClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const h = decodeJson(header);
    if (h?.alg !== 'RS256') return null;
    const key = this.published.find(p => p.jwk.kid === h.kid);
    if (!key) return null;
    if (!rsaVerify('sha256', Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature, 'base64url'))) return null;
    const c = decodeJson(payload);
    if (!c || c.iss !== this.issuer || c.aud !== CLI_JWT_AUDIENCE) return null;
    if (typeof c.sub !== 'string' || typeof c.jti !== 'string' || typeof c.exp !== 'number') return null;
    if (nowMs >= c.exp * 1000) return null;
    return { sub: c.sub, jti: c.jti, exp: c.exp };
  }
}

/** An in-memory key, for orchestrators without KMS (local, e2e, tests). */
export function localCliJwtKey(): CliJwtKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKey, sign: async data => rsaSign('sha256', data, privateKey) };
}
