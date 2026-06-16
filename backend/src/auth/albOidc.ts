import jwt, { JwtHeader } from 'jsonwebtoken';
import type { Request } from 'express';

// Verifies the identity AWS ALB injects after its authenticate-oidc action.
//
// When the ALB's listener authenticates a user against Okta, it forwards the
// request with an `x-amzn-oidc-data` header: a JWT (ES256) whose claims are the
// OIDC userinfo (email, name, sub). The JWT is signed by the ALB with a
// per-region key; we fetch the public key by `kid` from the regional endpoint
// and verify the signature so a request that reaches the instance WITHOUT going
// through the ALB (e.g. directly inside the VPC) cannot spoof an identity.
//
// Docs: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#user-claims-encoding

const HEADER = 'x-amzn-oidc-data';

// kid -> PEM public key. Keys are stable per region/ALB; cache to avoid a fetch
// on every request.
const keyCache = new Map<string, string>();

function regionFromEnv(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
}

async function fetchPublicKey(kid: string): Promise<string> {
  const cached = keyCache.get(kid);
  if (cached) return cached;

  const region = regionFromEnv();
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`failed to fetch ALB OIDC public key ${kid}: HTTP ${resp.status}`);
  }
  const pem = (await resp.text()).trim();
  keyCache.set(kid, pem);
  return pem;
}

export interface AlbIdentity {
  email: string;
  sub: string;
  name?: string;
}

/**
 * Verify and decode the ALB `x-amzn-oidc-data` identity. Returns null when the
 * header is absent (e.g. a machine/token request that bypassed edge auth) and
 * throws when the header is present but invalid (tampered/expired) so callers
 * fail closed.
 */
export async function verifyAlbIdentity(req: Request): Promise<AlbIdentity | null> {
  const raw = req.headers[HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new Error('ALB OIDC data is not a valid JWT');
  }
  const header = decoded.header as JwtHeader;
  if (!header.kid || header.alg !== 'ES256') {
    throw new Error(`unexpected ALB OIDC JWT header (alg=${header.alg}, kid=${header.kid ?? 'none'})`);
  }

  // Optionally pin the signing ALB to ours when ALB_ARN is configured.
  const expectedSigner = process.env.ALB_ARN;
  const signer = (header as unknown as Record<string, unknown>).signer;
  if (expectedSigner && signer !== expectedSigner) {
    throw new Error('ALB OIDC JWT signer does not match the configured ALB');
  }

  const pem = await fetchPublicKey(header.kid);
  const claims = jwt.verify(token, pem, { algorithms: ['ES256'] }) as Record<string, unknown>;

  const email = typeof claims.email === 'string' ? claims.email : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!email || !sub) {
    throw new Error('ALB OIDC identity is missing email/sub claims');
  }
  return {
    email,
    sub,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  };
}
