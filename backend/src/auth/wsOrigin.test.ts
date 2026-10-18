import { describe, expect, it } from 'vitest';
import { allowedWsOrigins, isAllowedUpgradeOrigin } from './wsOrigin';

describe('allowedWsOrigins', () => {
  it('allows the origin of FRONTEND_URL, normalized', () => {
    const origins = allowedWsOrigins({ FRONTEND_URL: 'https://app.termag.example.com/termag/' });
    expect(origins.has('https://app.termag.example.com')).toBe(true);
  });

  it('defaults to the Vite dev origin when FRONTEND_URL is unset', () => {
    expect(allowedWsOrigins({}).has('http://localhost:5173')).toBe(true);
  });

  it('adds comma-separated ALLOWED_WS_ORIGINS entries', () => {
    const origins = allowedWsOrigins({
      FRONTEND_URL: 'https://app.termag.example.com',
      ALLOWED_WS_ORIGINS: 'https://alt.example.com, http://localhost:4000',
    });
    expect(origins.has('https://alt.example.com')).toBe(true);
    expect(origins.has('http://localhost:4000')).toBe(true);
  });

  it('ignores a malformed ALLOWED_WS_ORIGINS entry without dropping the valid ones', () => {
    const origins = allowedWsOrigins({
      FRONTEND_URL: 'https://app.termag.example.com',
      ALLOWED_WS_ORIGINS: 'not a url, https://ok.example.com',
    });
    expect(origins.has('https://ok.example.com')).toBe(true);
    expect(origins.has('https://app.termag.example.com')).toBe(true);
  });
});

describe('isAllowedUpgradeOrigin', () => {
  const env = { FRONTEND_URL: 'https://app.termag.example.com' };

  it('allows the app origin', () => {
    expect(isAllowedUpgradeOrigin('https://app.termag.example.com', env)).toBe(true);
  });

  it('rejects another same-site origin (the hijack vector)', () => {
    expect(isAllowedUpgradeOrigin('https://deploy.shd.example.com', env)).toBe(false);
  });

  it('rejects an unrelated cross-site origin', () => {
    expect(isAllowedUpgradeOrigin('https://evil.example.com', env)).toBe(false);
  });

  it('allows an Origin-less handshake (non-browser client, e.g. the agent)', () => {
    expect(isAllowedUpgradeOrigin(undefined, env)).toBe(true);
  });

  it('does not treat a scheme/port mismatch as the app origin', () => {
    expect(isAllowedUpgradeOrigin('http://app.termag.example.com', env)).toBe(false);
    expect(isAllowedUpgradeOrigin('https://app.termag.example.com:8443', env)).toBe(false);
  });
});
