import { describe, it, expect } from 'vitest';
import {
  AUTH_CODE_TTL_MS,
  AuthCodeStore,
  CLI_IDLE_MS,
  CLI_MAX_AGE_MS,
  approvalPageHeaders,
  cliSessionAfterUse,
  cliSessionValidity,
  generateCliToken,
  isSameOriginPost,
  loopbackRedirect,
  parseAuthorizeParams,
  pkceChallenge,
  renderApprovalPage,
  sha256Hex,
  shouldTouch,
} from './cliAuth';

const DAY = 24 * 60 * 60 * 1000;
// RFC 7636 appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('generateCliToken', () => {
  it('mints a prefixed 256-bit token, its hash and a short display prefix', () => {
    const { token, tokenHash, tokenPrefix } = generateCliToken();
    expect(token).toMatch(/^tmcli_[0-9a-f]{64}$/);
    expect(tokenHash).toBe(sha256Hex(token));
    expect(tokenPrefix.startsWith(token.slice(0, 14))).toBe(true);
    expect(tokenPrefix.length).toBeLessThan(20);
    expect(generateCliToken().token).not.toBe(token);
  });
});

describe('cliSessionValidity', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  const fresh = { createdAt: created, lastUsedAt: created, revokedAt: null };

  it('is valid until 7 days without use', () => {
    expect(cliSessionValidity(fresh, new Date(created.getTime() + CLI_IDLE_MS - 1)).valid).toBe(true);
    const lapsed = cliSessionValidity(fresh, new Date(created.getTime() + CLI_IDLE_MS));
    expect(lapsed).toMatchObject({ valid: false, reason: 'idle' });
  });

  it('slides the idle window on use but never past 30 days', () => {
    let s = { ...fresh };
    for (let day = 6; day < 30; day += 6) {
      const at = new Date(created.getTime() + day * DAY);
      expect(cliSessionValidity(s, at).valid).toBe(true);
      s = { ...s, lastUsedAt: at };
    }
    const hard = cliSessionValidity(s, new Date(created.getTime() + CLI_MAX_AGE_MS));
    expect(hard).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('reports the earlier of the idle and hard limits as expiresAt', () => {
    const at = new Date(created.getTime() + 28 * DAY);
    const v = cliSessionAfterUse(fresh, at);
    expect(v.expiresAt.toISOString()).toBe(new Date(created.getTime() + CLI_MAX_AGE_MS).toISOString());
    const early = cliSessionAfterUse(fresh, new Date(created.getTime() + DAY));
    expect(early.expiresAt.toISOString()).toBe(new Date(created.getTime() + DAY + CLI_IDLE_MS).toISOString());
  });

  it('is invalid once revoked', () => {
    expect(cliSessionValidity({ ...fresh, revokedAt: created }, created)).toMatchObject({ valid: false, reason: 'revoked' });
  });
});

describe('shouldTouch', () => {
  it('writes lastUsedAt at most once a minute', () => {
    const t = new Date('2026-10-01T00:00:00Z');
    expect(shouldTouch(t, new Date(t.getTime() + 59_000))).toBe(false);
    expect(shouldTouch(t, new Date(t.getTime() + 60_000))).toBe(true);
  });
});

describe('pkceChallenge', () => {
  it('matches the RFC 7636 S256 vector', () => {
    expect(pkceChallenge(VERIFIER)).toBe(CHALLENGE);
  });
});

describe('parseAuthorizeParams', () => {
  const good = {
    port: '53682', state: 'abcdefghijklmnop', code_challenge: CHALLENGE,
    code_challenge_method: 'S256', device_name: 'zane-mbp.local',
  };

  it('accepts a well-formed request', () => {
    expect(parseAuthorizeParams(good)).toEqual({
      port: 53682, state: 'abcdefghijklmnop', codeChallenge: CHALLENGE, deviceName: 'zane-mbp.local',
    });
  });

  it.each([
    ['a privileged port', { port: '80' }],
    ['a port out of range', { port: '70000' }],
    ['a non-numeric port', { port: '5368x' }],
    ['a short state', { state: 'short' }],
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['a malformed challenge', { code_challenge: 'x'.repeat(42) }],
    ['markup in the device name', { device_name: '<script>' }],
    ['an empty device name', { device_name: '' }],
    ['an array value', { state: ['abcdefghijklmnop', 'x'] }],
  ])('rejects %s', (_label, override) => {
    expect(parseAuthorizeParams({ ...good, ...override })).toHaveProperty('error');
  });
});

describe('AuthCodeStore', () => {
  const grant = { userId: 'u1', deviceName: 'mbp', codeChallenge: CHALLENGE };

  it('redeems a code once with the matching verifier', () => {
    const store = new AuthCodeStore();
    const code = store.issue(grant, 0);
    expect(store.redeem(code, VERIFIER, 1000)).toEqual({ userId: 'u1', deviceName: 'mbp' });
    expect(store.redeem(code, VERIFIER, 1000)).toBeNull();
  });

  it('burns the code on a wrong verifier', () => {
    const store = new AuthCodeStore();
    const code = store.issue(grant, 0);
    expect(store.redeem(code, 'A'.repeat(43), 0)).toBeNull();
    expect(store.redeem(code, VERIFIER, 0)).toBeNull();
  });

  it('refuses an expired code', () => {
    const store = new AuthCodeStore();
    const code = store.issue(grant, 0);
    expect(store.redeem(code, VERIFIER, AUTH_CODE_TTL_MS)).toBeNull();
  });

  it('does not keep raw codes and sweeps expired ones', () => {
    const store = new AuthCodeStore();
    const code = store.issue(grant, 0);
    expect(JSON.stringify([...(store as unknown as { pending: Map<string, unknown> }).pending.keys()])).not.toContain(code);
    store.issue(grant, AUTH_CODE_TTL_MS + 1);
    expect(store.size).toBe(1);
  });

  it('caps pending codes', () => {
    const store = new AuthCodeStore();
    for (let i = 0; i < 1005; i++) store.issue(grant, 0);
    expect(store.size).toBe(1000);
  });
});

describe('isSameOriginPost', () => {
  const allowed = ['https://termag.example'];
  it('trusts Sec-Fetch-Site: same-origin only', () => {
    expect(isSameOriginPost({ secFetchSite: 'same-origin' }, allowed)).toBe(true);
    expect(isSameOriginPost({ secFetchSite: 'same-site', origin: 'https://termag.example' }, allowed)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: 'cross-site' }, allowed)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: 'none' }, allowed)).toBe(false);
  });
  it('falls back to an exact Origin match', () => {
    expect(isSameOriginPost({ origin: 'https://termag.example' }, allowed)).toBe(true);
    expect(isSameOriginPost({ origin: 'https://evil.example' }, allowed)).toBe(false);
    expect(isSameOriginPost({ origin: 'null' }, allowed)).toBe(false);
    expect(isSameOriginPost({}, allowed)).toBe(false);
  });
});

describe('approval page', () => {
  it('limits form posts to self and the loopback port and forbids framing', () => {
    const h = approvalPageHeaders(53682);
    expect(h['Content-Security-Policy']).toContain("form-action 'self' http://127.0.0.1:53682;");
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h['X-Frame-Options']).toBe('DENY');
  });

  it('escapes what it echoes', () => {
    const html = renderApprovalPage({
      port: 53682, state: 'abcdefghijklmnop', codeChallenge: CHALLENGE, deviceName: 'mbp',
      email: 'a"><script>x</script>@example.com', action: '/termag/auth/cli/authorize',
    });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('name="code_challenge" value="' + CHALLENGE + '"');
  });

  it('redirects only to 127.0.0.1', () => {
    expect(loopbackRedirect(53682, { code: 'c', state: 's' })).toBe('http://127.0.0.1:53682/callback?code=c&state=s');
  });
});
