import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { AlbJwksCache } from 'aws-jwt-verify/alb-cache';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { albVerifierConfigFromEnv, createAlbVerifier, verifyAlbIdentity } from './albOidc';

const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-2:111122223333:loadbalancer/app/termag-orchestrator/0123456789abcdef';
const ISSUER = 'https://idp.example.com/oauth2/default';
const CLIENT_ID = '0oaexampleclientid';
const KID = '6f2b1d4e-8c3a-4f5b-9e7d-1a2b3c4d5e6f';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// The ALB encodes each segment as base64url WITH `=` padding, and signs over the
// padded header.payload. Reproduce that exactly.
const b64Padded = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function albToken(
  opts: {
    signer?: string; client?: string; key?: KeyObject; tamper?: boolean;
    exp?: number | null; // header exp (and payload exp unless payloadExp says otherwise); null omits it
    payloadExp?: number | null; // null omits exp from the payload
    iss?: string; // header iss (and payload iss unless payloadIss says otherwise)
    payloadIss?: string | null; // null omits iss from the payload
  } = {},
): string {
  const exp = opts.exp === undefined ? Math.floor(Date.now() / 1000) + 120 : opts.exp;
  const payloadExp = opts.payloadExp === undefined ? exp : opts.payloadExp;
  const header = {
    alg: 'ES256', kid: KID, signer: opts.signer ?? ALB_ARN,
    iss: opts.iss ?? ISSUER, client: opts.client ?? CLIENT_ID, ...(exp === null ? {} : { exp }),
  };
  // Pick a filler so the payload's base64 needs `==` padding, guaranteeing the
  // test exercises the case jsonwebtoken rejects.
  let claims: Record<string, unknown> = {};
  for (let n = 0; n < 3; n++) {
    const iss = opts.payloadIss === undefined ? (opts.iss ?? ISSUER) : opts.payloadIss;
    claims = {
      sub: 'okta-sub-1', email: 'dev@example.com', name: 'Dev User',
      ...(payloadExp === null ? {} : { exp: payloadExp }), ...(iss === null ? {} : { iss }), x: 'a'.repeat(n),
    };
    if (Buffer.from(JSON.stringify(claims)).length % 3 === 1) break;
  }
  const h = b64Padded(Buffer.from(JSON.stringify(header)));
  const p = b64Padded(Buffer.from(JSON.stringify(claims)));
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key: opts.key ?? privateKey, dsaEncoding: 'ieee-p1363' });
  // `tamper` sends different claims under the signature computed above.
  const sent = opts.tamper ? b64Padded(Buffer.from(JSON.stringify({ ...claims, email: 'root@example.com' }))) : p;
  return `${h}.${sent}.${b64Padded(sig)}`;
}

const reqWith = (token?: string) =>
  ({ headers: token === undefined ? {} : { 'x-amzn-oidc-data': token } }) as unknown as Request;

let fetched: string[];
function verifier() {
  fetched = [];
  const fetcher = {
    fetch: async (uri: string) => {
      fetched.push(uri);
      return new TextEncoder().encode(PEM).buffer as ArrayBuffer;
    },
  };
  return createAlbVerifier(
    { albArn: ALB_ARN, issuer: ISSUER, clientId: CLIENT_ID },
    { jwksCache: new AlbJwksCache({ fetcher }) },
  );
}

describe('verifyAlbIdentity', () => {
  let v: ReturnType<typeof verifier>;
  beforeEach(() => { v = verifier(); });

  it('accepts a padded ALB token that jsonwebtoken cannot even decode', async () => {
    const token = albToken();
    expect(token.split('.')[1]).toMatch(/==$/);
    expect(jwt.decode(token)).toBeNull(); // the regression: "ALB OIDC data is not a valid JWT"

    await expect(verifyAlbIdentity(reqWith(token), v)).resolves.toEqual({
      sub: 'okta-sub-1', email: 'dev@example.com', name: 'Dev User',
    });
    expect(fetched).toEqual([`https://public-keys.auth.elb.us-east-2.amazonaws.com/${KID}`]);
  });

  it('returns null when the header is absent', async () => {
    await expect(verifyAlbIdentity(reqWith(), v)).resolves.toBeNull();
    expect(fetched).toEqual([]);
  });

  it('rejects a token signed for a different ALB (keys are shared region-wide)', async () => {
    const other = ALB_ARN.replace('termag-orchestrator/0123456789abcdef', 'someone-else/fedcba9876543210');
    await expect(verifyAlbIdentity(reqWith(albToken({ signer: other })), v)).rejects.toThrow();
  });

  it('rejects the wrong Okta client or issuer', async () => {
    await expect(verifyAlbIdentity(reqWith(albToken({ client: '0oaotherapp' })), v)).rejects.toThrow();
    await expect(verifyAlbIdentity(reqWith(albToken({ iss: 'https://idp.example.com' })), v)).rejects.toThrow();
  });

  // The ALB always puts iss on the signed header; whether the payload (built
  // from the IdP's userinfo) carries one too is not guaranteed.
  it('pins the issuer on the header, whether or not the payload has one', async () => {
    await expect(verifyAlbIdentity(reqWith(albToken({ payloadIss: null })), v)).resolves.toMatchObject({ email: 'dev@example.com' });
    await expect(verifyAlbIdentity(reqWith(albToken({ iss: 'https://evil.example.com', payloadIss: ISSUER })), v))
      .rejects.toThrow(/header iss/);
    await expect(verifyAlbIdentity(reqWith(albToken({ payloadIss: 'https://evil.example.com' })), v))
      .rejects.toThrow(/payload iss/);
  });

  it('rejects a tampered payload, a foreign signing key, and an expired token', async () => {
    const { privateKey: foreign } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(verifyAlbIdentity(reqWith(albToken({ tamper: true })), v)).rejects.toThrow();
    await expect(verifyAlbIdentity(reqWith(albToken({ key: foreign })), v)).rejects.toThrow();
    await expect(
      verifyAlbIdentity(reqWith(albToken({ exp: Math.floor(Date.now() / 1000) - 60 })), v),
    ).rejects.toThrow();
  });
  // Same shape question as iss: the ALB always sets exp on the signed header,
  // and the library skips expiry entirely when the payload has none.
  it('enforces the header exp, whether or not the payload has one', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(verifyAlbIdentity(reqWith(albToken({ payloadExp: null })), v)).resolves.toMatchObject({ email: 'dev@example.com' });
    await expect(verifyAlbIdentity(reqWith(albToken({ exp: past, payloadExp: null })), v)).rejects.toThrow(/expired/);
    await expect(verifyAlbIdentity(reqWith(albToken({ exp: null, payloadExp: null })), v)).rejects.toThrow(/no exp/);
  });
});

describe('albVerifierConfigFromEnv', () => {
  it('names every missing variable in one error', () => {
    expect(() => albVerifierConfigFromEnv({})).toThrow(/ALB_ARN, ALB_OIDC_ISSUER, ALB_OIDC_CLIENT_ID/);
    expect(() => albVerifierConfigFromEnv({ ALB_ARN: ALB_ARN, ALB_OIDC_ISSUER: ISSUER, ALB_OIDC_CLIENT_ID: ' ' }))
      .toThrow(/requires ALB_OIDC_CLIENT_ID to be set/);
  });

  it('trims values', () => {
    expect(albVerifierConfigFromEnv({ ALB_ARN: ` ${ALB_ARN} `, ALB_OIDC_ISSUER: `${ISSUER}\n`, ALB_OIDC_CLIENT_ID: CLIENT_ID }))
      .toEqual({ albArn: ALB_ARN, issuer: ISSUER, clientId: CLIENT_ID });
  });
});
