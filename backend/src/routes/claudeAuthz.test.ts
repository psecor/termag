import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const BOX_TOKEN = 'tmag_box_token_sentinel_0123456789'; // gitleaks:allow (test sentinel)

const state = vi.hoisted(() => ({
  tokens: new Map<string, unknown>(),
  enabled: true,
  configured: true,
  callerOk: true,
}));

vi.mock('./agentTokens', () => ({ validateAgentToken: async (t: string) => state.tokens.get(t) ?? null }));
vi.mock('../db', () => ({ prisma: { user: { findUnique: async () => ({ claudeGatewayEnabled: state.enabled }) } } }));
vi.mock('../services/claudeGateway', () => ({ getClaudeGatewayConfig: () => (state.configured ? {} : null) }));
vi.mock('../services/callerIdentity', () => ({
  verifyCallerProof: async (h: Record<string, string>) => (state.callerOk && h['x-termag-caller-authorization'] ? 'arn:gateway' : null),
}));

const { claudeAuthzRouter } = await import('./claudeAuthz');
const { ALLOW_TTL_MS } = await import('../services/claudeAuthz');

const user = { id: 'owner1', googleEmail: 'o@example.com' };
const box = (kind: string) => ({ user, instance: { id: `inst-${kind}`, userId: 'owner1', kind }, token: { id: `tok-${kind}`, scope: 'agent', name: kind } });
const MODEL = '/model/us.anthropic.claude-opus-x/invoke';

let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use('/termag/internal/claude-authz', claudeAuthzRouter({ allowedRoleArns: ['arn:gateway'], stsUrl: 'http://sts' }));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/internal/claude-authz`;
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => { server.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

// Past the allow TTL, so no test sees the previous one's allows.
beforeEach(() => {
  advance(ALLOW_TTL_MS);
  state.tokens = new Map([[BOX_TOKEN, box('ec2')], ['tmag_external_box', box('external')]]);
  state.enabled = true;
  state.configured = true;
  state.callerOk = true;
  logs.length = 0;
});

// What Envoy's ext_authz sends for a Bedrock call: its path and Authorization,
// and the caller proof (the Lua filter).
function check(opts: { auth?: string; proof?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.proof !== false) headers['x-termag-caller-authorization'] = 'AWS4-HMAC-SHA256 Credential=x';
  if (opts.auth) headers.authorization = opts.auth;
  return fetch(`${base}${MODEL}`, { method: 'POST', headers });
}
const bearer = (t: string) => `Bearer ${t}`;

describe('the Claude gateway check (ext_authz)', () => {
  it("answers 200 with the box's identity for a managed box with the gateway on", async () => {
    const res = await check({ auth: bearer(BOX_TOKEN) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-termag-user')).toBe('owner1');
    expect(res.headers.get('x-termag-instance')).toBe('inst-ec2');
    expect(res.headers.get('x-termag-email')).toBe('o@example.com');
    expect(res.headers.get('authorization')).toBeNull();
    expect(logs.join('\n')).toContain(`[CLAUDE-AUTHZ] user=owner1 instance=inst-ec2 ${MODEL} allowed`);
  });

  it('refuses a caller that is not the gateway, before looking at the token', async () => {
    state.callerOk = false;
    expect((await check({ auth: bearer(BOX_TOKEN) })).status).toBe(403);
    state.callerOk = true;
    expect((await check({ auth: bearer(BOX_TOKEN), proof: false })).status).toBe(403);
  });

  it('refuses no token, an unknown token and an external box', async () => {
    const none = await check();
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await check({ auth: bearer('tmag_nope') })).status).toBe(401);
    expect((await check({ auth: bearer('tmag_external_box') })).status).toBe(403);
  });

  it('refuses once the owner turns the gateway off, and when the orchestrator has none', async () => {
    state.enabled = false;
    const off = await check({ auth: bearer(BOX_TOKEN) });
    expect(off.status).toBe(403);
    expect((await off.json()).message).toMatch(/turned off/);
    state.enabled = true;
    state.configured = false;
    expect((await check({ auth: bearer(BOX_TOKEN) })).status).toBe(403);
  });

  it('a revoked token stops working once its allow expires, after ALLOW_TTL_MS', async () => {
    expect((await check({ auth: bearer(BOX_TOKEN) })).status).toBe(200);
    state.tokens.delete(BOX_TOKEN);
    advance(ALLOW_TTL_MS - 1);
    expect((await check({ auth: bearer(BOX_TOKEN) })).status).toBe(200);
    advance(1);
    expect((await check({ auth: bearer(BOX_TOKEN) })).status).toBe(401);
  });

  it('never logs a token', async () => {
    await check({ auth: bearer(BOX_TOKEN) });
    await check({ auth: bearer(BOX_TOKEN) });
    await check({ auth: bearer('tmag_nope') });
    expect(logs.join('\n')).not.toContain(BOX_TOKEN);
  });
});
