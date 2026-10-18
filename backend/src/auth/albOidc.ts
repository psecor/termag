import { AlbJwtVerifier } from 'aws-jwt-verify';
import type { Request } from 'express';
import { identityFromClaims } from './oidc';

// Verifies the identity AWS ALB injects after its authenticate-oidc action.
//
// When the ALB's listener authenticates a user against Okta, it forwards the
// request with an `x-amzn-oidc-data` header: an ES256 JWT whose claims are the
// OIDC userinfo (email, name, sub), signed with a per-region key the ALB
// publishes by `kid`. Verifying it is what stops a request that reaches the
// instance WITHOUT going through the ALB (e.g. directly inside the VPC) from
// spoofing an identity.
//
// aws-jwt-verify's AlbJwtVerifier does the verification, not a generic JWT
// library: the ALB pads its base64 segments with `=`, which jsonwebtoken/jws
// reject outright ("not a valid JWT") and which the signature covers, so they
// can't simply be stripped. It also enforces the three pins that make the
// header trustworthy at all. ALB signing keys are shared by every ALB in the
// region, so `signer` must be ours; `client` must be our Okta app; `iss` must be
// our Okta issuer.
//
// Docs: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#user-claims-encoding

const HEADER = 'x-amzn-oidc-data';

const REQUIRED_VARS = ['ALB_ARN', 'ALB_OIDC_ISSUER', 'ALB_OIDC_CLIENT_ID'] as const;

export interface AlbVerifierConfig {
  albArn: string;
  issuer: string;
  clientId: string;
}

/** Read and validate the okta-mode verifier config; throws naming every missing variable. */
export function albVerifierConfigFromEnv(env: NodeJS.ProcessEnv): AlbVerifierConfig {
  const missing = REQUIRED_VARS.filter(k => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=okta requires ${missing.join(', ')} to be set`);
  }
  return {
    albArn: env.ALB_ARN!.trim(),
    issuer: env.ALB_OIDC_ISSUER!.trim(),
    clientId: env.ALB_OIDC_CLIENT_ID!.trim(),
  };
}

export function createAlbVerifier(
  cfg: AlbVerifierConfig,
  additional?: Parameters<typeof AlbJwtVerifier.create>[1],
) {
  return AlbJwtVerifier.create(
    {
      albArn: cfg.albArn,
      clientId: cfg.clientId,
      // The library checks iss and exp only on the payload, and skips exp when
      // it's absent. The ALB always sets both on the (signed) header, while the
      // payload is built from the IdP's userinfo, so check the header and also
      // any iss the payload carries (the library still checks a payload exp).
      // Without the header exp check a payload-exp-less token never expires.
      issuer: null,
      customJwtCheck: ({ header, payload }) => {
        if (typeof header.exp !== 'number') {
          throw new Error('ALB JWT header has no exp');
        }
        if (header.exp < Date.now() / 1000) {
          throw new Error(`ALB JWT expired at ${new Date(header.exp * 1000).toISOString()}`);
        }
        if (header.iss !== cfg.issuer) {
          throw new Error(`ALB JWT header iss ${String(header.iss)} is not ${cfg.issuer}`);
        }
        if (payload.iss !== undefined && payload.iss !== cfg.issuer) {
          throw new Error(`ALB JWT payload iss ${String(payload.iss)} is not ${cfg.issuer}`);
        }
      },
    },
    additional,
  );
}

type AlbVerifier = ReturnType<typeof createAlbVerifier>;

// Built on first use so google/oidc deployments never read the okta variables.
// The verifier caches the ALB public key by kid.
let defaultVerifier: AlbVerifier | undefined;

export interface AlbIdentity {
  email: string;
  sub: string;
  name?: string;
}

/**
 * Verify and decode the ALB `x-amzn-oidc-data` identity. Returns null when the
 * header is absent (e.g. a machine/token request that bypassed edge auth) and
 * throws when the header is present but invalid (tampered/expired/wrong ALB)
 * so callers fail closed.
 */
export async function verifyAlbIdentity(req: Request, verifier?: AlbVerifier): Promise<AlbIdentity | null> {
  const raw = req.headers[HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;

  const v = verifier ?? (defaultVerifier ??= createAlbVerifier(albVerifierConfigFromEnv(process.env)));
  const claims = await v.verify(token);
  return identityFromClaims(claims as Record<string, unknown>);
}
