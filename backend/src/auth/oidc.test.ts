import { describe, it, expect } from 'vitest';
import { oidcConfigFromEnv, identityFromClaims, newTransaction } from './oidc';

const BASE = {
  OIDC_ISSUER_URL: 'https://login.example.com/oauth2/default/',
  OIDC_CLIENT_ID: 'abc',
  OIDC_CLIENT_SECRET: 'shh',
};

describe('oidcConfigFromEnv', () => {
  it('names every missing required variable in one error', () => {
    expect(() => oidcConfigFromEnv({})).toThrow(/OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET/);
    expect(() => oidcConfigFromEnv({ ...BASE, OIDC_CLIENT_SECRET: '  ' })).toThrow(/requires OIDC_CLIENT_SECRET to be set/);
  });

  it('derives the redirect URI from FRONTEND_URL + BASE_PATH and defaults the scope', () => {
    const cfg = oidcConfigFromEnv({ ...BASE, FRONTEND_URL: 'https://termag.example.internal/', BASE_PATH: '/termag' });
    expect(cfg.redirectUri).toBe('https://termag.example.internal/termag/auth/oidc/callback');
    expect(cfg.scope).toBe('openid profile email');
    expect(cfg.issuerUrl).toBe('https://login.example.com/oauth2/default');
  });

  it('falls back to a local frontend URL and honours OIDC_SCOPE', () => {
    const cfg = oidcConfigFromEnv({ ...BASE, OIDC_SCOPE: 'openid email groups' });
    expect(cfg.redirectUri).toBe('http://localhost:3040/auth/oidc/callback');
    expect(cfg.scope).toBe('openid email groups');
  });
});

describe('identityFromClaims', () => {
  it('extracts sub, email and name', () => {
    expect(identityFromClaims({ sub: 'u1', email: 'a@example.com', name: 'Ada' }))
      .toEqual({ sub: 'u1', email: 'a@example.com', name: 'Ada' });
  });

  it('accepts preferred_username only when it is an email', () => {
    expect(identityFromClaims({ sub: 'u1', preferred_username: 'a@example.com' }).email).toBe('a@example.com');
    expect(() => identityFromClaims({ sub: 'u1', preferred_username: 'ada' })).toThrow(/missing sub\/email/);
  });

  it('rejects claims without a subject or email', () => {
    expect(() => identityFromClaims({ email: 'a@example.com' })).toThrow(/missing sub\/email/);
    expect(() => identityFromClaims({ sub: 'u1' })).toThrow(/missing sub\/email/);
  });

  it('omits an empty name', () => {
    expect(identityFromClaims({ sub: 'u1', email: 'a@example.com', name: '  ' }).name).toBeUndefined();
  });
});

describe('newTransaction', () => {
  it('produces distinct, non-empty state/nonce/verifier per login', () => {
    const a = newTransaction();
    const b = newTransaction();
    for (const tx of [a, b]) {
      expect(tx.state.length).toBeGreaterThan(20);
      expect(tx.nonce.length).toBeGreaterThan(20);
      expect(tx.codeVerifier.length).toBeGreaterThanOrEqual(43);
    }
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});
