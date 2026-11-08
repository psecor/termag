import { describe, expect, it } from 'vitest';
import { allowedWsOrigins, isAllowedUpgradeOrigin, isPreviewOrigin, termagCorsOrigin } from './wsOrigin';

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

// Pinning test: a preview host
// runs someone's app, so it is never an origin termag's CORS or sockets trust.
describe('preview hosts are never trusted origins (SR1, SR3)', () => {
  const env = {
    FRONTEND_URL: 'https://app.termag.example',
    PREVIEW_LINKS_DOMAIN: 'previews.test',
    ALLOWED_WS_ORIGINS: 'https://my-app.previews.test, https://PREVIEWS.TEST, https://alt.example.com',
  };

  it('drops every preview origin from the WebSocket allowlist, even one configured in it', () => {
    expect([...allowedWsOrigins(env)].sort()).toEqual(['https://alt.example.com', 'https://app.termag.example']);
    expect(isAllowedUpgradeOrigin('https://my-app.previews.test', env)).toBe(false);
    expect(isAllowedUpgradeOrigin('https://previews.test', env)).toBe(false);
  });

  it('answers CORS for the UI only, and for nobody if FRONTEND_URL were a preview host', () => {
    expect(termagCorsOrigin(env)).toBe('https://app.termag.example');
    expect(termagCorsOrigin({ ...env, FRONTEND_URL: 'https://x.previews.test' })).toBe(false);
  });

  it('knows a preview origin only with a preview domain', () => {
    expect(isPreviewOrigin('https://a.previews.test', env)).toBe(true);
    expect(isPreviewOrigin('https://previews.test.evil.example', env)).toBe(false);
    expect(isPreviewOrigin('https://a.previews.test', {})).toBe(false);
  });
});
