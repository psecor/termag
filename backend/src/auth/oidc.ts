/**
 * In-app OpenID Connect sign-in (AUTH_MODE=oidc).
 *
 * The EC2 deployment establishes identity at the AWS ALB (authenticate-oidc →
 * x-amzn-oidc-data, see ./albOidc.ts). Container platforms front the app with
 * an ingress that has no browser OIDC action, so the app has to run the
 * authorization-code flow itself. This module owns that flow against any
 * standards-compliant issuer (Okta in practice): discovery, PKCE + state +
 * nonce, code exchange, and claim extraction. The session bookkeeping and the
 * ALLOWED_USERS gate live in routes/auth.ts, shared with the ALB path.
 *
 * Configuration (all required unless noted):
 *   OIDC_ISSUER_URL     issuer / authorization-server base URL (discovery is
 *                       appended: <issuer>/.well-known/openid-configuration)
 *   OIDC_CLIENT_ID
 *   OIDC_CLIENT_SECRET
 *   OIDC_SCOPE          optional, default "openid profile email"
 * The redirect URI is derived: <FRONTEND_URL><BASE_PATH>/auth/oidc/callback —
 * register exactly that on the OIDC app.
 */
import type { Request } from 'express';
import { Issuer, generators, type Client } from 'openid-client';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
}

export interface OidcIdentity {
  email: string;
  sub: string;
  name?: string;
}

/** Per-login state kept in the session between /auth/oidc and the callback. */
export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
}

declare module 'express-session' {
  interface SessionData {
    oidc?: OidcTransaction;
  }
}

const REQUIRED_VARS = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;

/** Read + validate the OIDC settings. Throws a single message naming every missing variable. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv): OidcConfig {
  const missing = REQUIRED_VARS.filter(k => !env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=oidc requires ${missing.join(', ')} to be set`);
  }
  const frontendUrl = (env.FRONTEND_URL ?? 'http://localhost:3040').replace(/\/+$/, '');
  const basePath = env.BASE_PATH ?? '';
  return {
    issuerUrl: env.OIDC_ISSUER_URL!.trim().replace(/\/+$/, ''),
    clientId: env.OIDC_CLIENT_ID!.trim(),
    clientSecret: env.OIDC_CLIENT_SECRET!.trim(),
    scope: env.OIDC_SCOPE?.trim() || 'openid profile email',
    redirectUri: `${frontendUrl}${basePath}/auth/oidc/callback`,
  };
}

/**
 * Pull the identity termag needs out of ID-token / userinfo claims. `email` is
 * mandatory because ALLOWED_USERS keys on it; `preferred_username` is accepted
 * only when it is itself an email address.
 */
export function identityFromClaims(claims: Record<string, unknown>): OidcIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  let email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!email && typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@')) {
    email = claims.preferred_username.trim();
  }
  if (!sub || !email) {
    throw new Error('OIDC identity is missing sub/email claims');
  }
  return {
    sub,
    email,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : undefined,
  };
}

export function newTransaction(): OidcTransaction {
  return {
    state: generators.state(),
    nonce: generators.nonce(),
    codeVerifier: generators.codeVerifier(),
  };
}

// Discovery is memoised for the process lifetime; a failed discovery is
// forgotten so the next login attempt retries instead of being poisoned.
let clientPromise: Promise<Client> | null = null;

export function getOidcClient(cfg: OidcConfig): Promise<Client> {
  if (!clientPromise) {
    clientPromise = Issuer.discover(cfg.issuerUrl).then(issuer => new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [cfg.redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    }));
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

export function authorizationUrl(client: Client, cfg: OidcConfig, tx: OidcTransaction): string {
  return client.authorizationUrl({
    scope: cfg.scope,
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: generators.codeChallenge(tx.codeVerifier),
    code_challenge_method: 'S256',
  });
}

/**
 * Finish the code flow for the callback request: verify state/nonce/PKCE,
 * exchange the code, and resolve the identity — falling back to the userinfo
 * endpoint when the ID token omits `email` (some issuers only return it there).
 */
export async function completeLogin(
  client: Client,
  cfg: OidcConfig,
  req: Request,
  tx: OidcTransaction,
): Promise<OidcIdentity> {
  const params = client.callbackParams(req);
  const tokenSet = await client.callback(cfg.redirectUri, params, {
    state: tx.state,
    nonce: tx.nonce,
    code_verifier: tx.codeVerifier,
  });

  let claims: Record<string, unknown> = { ...tokenSet.claims() };
  if (typeof claims.email !== 'string' && tokenSet.access_token) {
    try {
      const info = await client.userinfo(tokenSet);
      claims = { ...claims, ...info };
    } catch (err) {
      console.warn(`[auth] OIDC userinfo lookup failed: ${(err as Error).message}`);
    }
  }
  return identityFromClaims(claims);
}
