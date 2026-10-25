import { describe, expect, it, vi } from 'vitest';
import { chatReclaimPostRefusal, chatTerminalPostRefusal, chatTrustPostRefusal, runAfterPostRefusal } from './chatTrustPost';

const env = { FRONTEND_URL: 'https://app.termag.example.com/termag/' };
const app = 'https://app.termag.example.com';
const sibling = 'https://deploy.shd.example.com';
const json = { contentType: 'application/json', body: { trust: true } };

describe('chatTrustPostRefusal', () => {
  it('accepts a same-origin JSON trust from the app origin', () => {
    expect(chatTrustPostRefusal({
      secFetchSite: 'same-origin', origin: app, ...json,
    }, env)).toBeNull();
    expect(chatTrustPostRefusal({
      secFetchSite: 'same-origin', origin: app, contentType: 'application/json; charset=utf-8', body: { trust: true },
    }, env)).toBeNull();
  });

  it('rejects a same-site form POST from another ldinfra host', () => {
    expect(chatTrustPostRefusal({
      secFetchSite: 'same-site',
      origin: sibling,
      contentType: 'application/x-www-form-urlencoded',
      body: {},
    }, env)).toEqual({ status: 403, error: 'This trust request did not come from termag.' });
  });

  it('rejects cross-site, null, and missing Origin, and trusts the WebSocket allowlist only as a fallback', () => {
    expect(chatTrustPostRefusal({ secFetchSite: 'cross-site', origin: 'https://evil.example', ...json }, env)?.status).toBe(403);
    expect(chatTrustPostRefusal({ secFetchSite: 'none', ...json }, env)?.status).toBe(403);
    expect(chatTrustPostRefusal({ origin: 'null', ...json }, env)?.status).toBe(403);
    expect(chatTrustPostRefusal({ ...json }, env)?.status).toBe(403);
    expect(chatTrustPostRefusal({ origin: sibling, ...json }, env)?.status).toBe(403);
    expect(chatTrustPostRefusal({ origin: app, ...json }, env)).toBeNull();
    expect(chatTrustPostRefusal({
      origin: 'https://alt.example.com', ...json,
    }, { ...env, ALLOWED_WS_ORIGINS: 'https://alt.example.com' })).toBeNull();
  });

  it('does not treat an empty or non-JSON POST as a trust action, even from the app', () => {
    const same = { secFetchSite: 'same-origin' as const, origin: app };
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/json', body: {} }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/json', body: undefined }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/json', body: null }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/json', body: { trust: false } }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/json', body: { trust: 'true' } }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: 'application/x-www-form-urlencoded', body: { trust: true } }, env)?.status).toBe(400);
    expect(chatTrustPostRefusal({ ...same, contentType: undefined, body: undefined }, env)?.status).toBe(400);
  });
});

describe('chatTerminalPostRefusal', () => {
  const workstream = { contentType: 'application/json', body: { workstream: 'main' } };

  it('accepts a same-origin JSON body, including one that only names a workstream', () => {
    expect(chatTerminalPostRefusal({
      secFetchSite: 'same-origin', origin: app, ...workstream,
    }, env)).toBeNull();
    expect(chatTerminalPostRefusal({
      secFetchSite: 'same-origin', origin: app, contentType: 'application/json; charset=utf-8', body: { workstream: 'feature' },
    }, env)).toBeNull();
    expect(chatTerminalPostRefusal({ origin: app, ...workstream }, env)).toBeNull();
  });

  it('rejects a same-site form POST from another ldinfra host', () => {
    expect(chatTerminalPostRefusal({
      secFetchSite: 'same-site',
      origin: sibling,
      contentType: 'application/x-www-form-urlencoded',
      body: {},
    }, env)).toEqual({ status: 403, error: 'This resume request did not come from termag.' });
  });

  it('rejects cross-site and a missing Origin', () => {
    expect(chatTerminalPostRefusal({ secFetchSite: 'cross-site', origin: 'https://evil.example', ...workstream }, env)?.status).toBe(403);
    expect(chatTerminalPostRefusal({ secFetchSite: 'same-site', origin: app, ...workstream }, env)?.status).toBe(403);
    expect(chatTerminalPostRefusal({ ...workstream }, env)?.status).toBe(403);
    expect(chatTerminalPostRefusal({ origin: 'null', ...workstream }, env)?.status).toBe(403);
  });

  it('does not treat an empty or non-JSON POST as a resume, even from the app', () => {
    const same = { secFetchSite: 'same-origin' as const, origin: app };
    expect(chatTerminalPostRefusal({ ...same, contentType: 'application/json', body: {} }, env)).toBeNull();
    expect(chatTerminalPostRefusal({ ...same, contentType: 'application/json', body: undefined }, env)?.status).toBe(400);
    expect(chatTerminalPostRefusal({ ...same, contentType: 'application/json', body: null }, env)?.status).toBe(400);
    expect(chatTerminalPostRefusal({ ...same, contentType: 'application/json', body: [] }, env)?.status).toBe(400);
    expect(chatTerminalPostRefusal({ ...same, contentType: 'application/x-www-form-urlencoded', body: { workstream: 'main' } }, env)?.status).toBe(400);
    expect(chatTerminalPostRefusal({ ...same, contentType: undefined, body: undefined }, env)?.status).toBe(400);
  });
});

describe('chatReclaimPostRefusal', () => {
  const workstream = { contentType: 'application/json', body: { workstream: 'main' } };

  it('accepts same-origin JSON and rejects a form POST that would exit Claude', () => {
    const same = { secFetchSite: 'same-origin' as const, origin: app };
    expect(chatReclaimPostRefusal({ ...same, ...workstream }, env)).toBeNull();
    expect(chatReclaimPostRefusal({
      secFetchSite: 'same-site', origin: sibling, contentType: 'application/x-www-form-urlencoded', body: {},
    }, env)?.status).toBe(403);
    expect(chatReclaimPostRefusal({ ...same, contentType: 'text/plain', body: { workstream: 'main' } }, env)?.status).toBe(400);
  });
});

describe('runAfterPostRefusal', () => {
  it('does not run the handler when the gate refuses, and returns the handler when it passes', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: { resumed: true } }));
    const refused = await runAfterPostRefusal({ status: 403, error: 'no' }, handler);
    expect(refused).toEqual({ status: 403, body: { error: 'no' } });
    expect(handler).not.toHaveBeenCalled();
    const allowed = await runAfterPostRefusal(null, handler);
    expect(allowed).toEqual({ status: 200, body: { resumed: true } });
    expect(handler).toHaveBeenCalledOnce();
  });
});
