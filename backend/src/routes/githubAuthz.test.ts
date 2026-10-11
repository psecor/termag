import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const BOX_TOKEN = 'tmag_box_token_sentinel_0123456789'; // gitleaks:allow (test sentinel)
const OWNER_TOKEN = 'gho_OWNERsentinelOWNERsentinel0123'; // gitleaks:allow (test sentinel)

const state = vi.hoisted(() => ({
  tokens: new Map<string, unknown>(),
  ownerToken: null as string | null,
  callerOk: true,
}));

vi.mock('./agentTokens', () => ({ validateAgentToken: async (t: string) => state.tokens.get(t) ?? null }));
vi.mock('../services/credentialStore', () => ({ githubTokenSource: async () => state.ownerToken }));
vi.mock('../services/callerIdentity', () => ({
  verifyCallerProof: async (h: Record<string, string>) => (state.callerOk && h['x-termag-caller-authorization'] ? 'arn:gateway' : null),
}));

const { githubAuthzRouter } = await import('./githubAuthz');

const user = { id: 'owner1', googleEmail: 'o@example.com' };
const box = (kind: string) => ({ user, instance: { id: `inst-${kind}`, userId: 'owner1', kind }, token: { id: `tok-${kind}`, scope: 'agent', name: kind } });

let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use('/termag/internal/github-authz', githubAuthzRouter({ allowedRoleArns: ['arn:gateway'], stsUrl: 'http://sts' }));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/internal/github-authz`;
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
});
afterAll(() => { server.close(); vi.restoreAllMocks(); });

beforeEach(() => {
  state.tokens = new Map([[BOX_TOKEN, box('ec2')], ['tmag_external_box', box('external')]]);
  state.ownerToken = OWNER_TOKEN;
  state.callerOk = true;
  logs.length = 0;
});

// What Envoy's ext_authz sends: the box's method, path and Authorization, the
// TLS listener's secret (nginx) and the caller proof (the gateway's Lua filter).
function check(path: string, opts: { auth?: string; proof?: boolean; method?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.proof !== false) headers['x-termag-caller-authorization'] = 'AWS4-HMAC-SHA256 Credential=x';
  if (opts.auth) headers.authorization = opts.auth;
  return fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body });
}
const basic = (token: string) => `Basic ${Buffer.from(`termag-box:${token}`).toString('base64')}`;
const REFS = '/o/r.git/info/refs?service=git-upload-pack';

describe('the GitHub broker check (ext_authz)', () => {
  it("answers 200 with the owner's Authorization for a managed box", async () => {
    const res = await check(REFS, { auth: basic(BOX_TOKEN) });
    expect(res.status).toBe(200);
    expect(res.headers.get('authorization')).toBe(`Basic ${Buffer.from(`x-access-token:${OWNER_TOKEN}`).toString('base64')}`);
    expect(res.headers.get('x-termag-user')).toBe('owner1');
    expect(res.headers.get('x-termag-instance')).toBe('inst-ec2');
    expect(logs.join('\n')).toMatch(/\[GH-AUTHZ\] user=owner1 instance=inst-ec2 git GET \/o\/r.git\/info\/refs\?service=git-upload-pack allowed/);
  });

  it('refuses a caller without a valid proof, even over the TLS listener with a good box token', async () => {
    state.callerOk = false;
    const res = await check(REFS, { auth: basic(BOX_TOKEN) });
    expect(res.status).toBe(403);
    expect(res.headers.get('authorization')).toBeNull();
    expect((await check(REFS, { auth: basic(BOX_TOKEN), proof: false })).status).toBe(403);
  });

  it('takes no header for proof of the TLS listener: a client-sent one changes nothing', async () => {
    state.callerOk = false;
    const forged = await fetch(`${base}${REFS}`, { headers: { authorization: basic(BOX_TOKEN), 'x-termag-agent-tls': 's'.repeat(64), 'x-forwarded-proto': 'https' } });
    expect(forged.status).toBe(403);
    state.callerOk = true;
    expect((await check(REFS, { auth: basic(BOX_TOKEN) })).status).toBe(200);
  });

  it('refuses an external box, with 401 for no or an unknown token', async () => {
    expect((await check(REFS, { auth: basic('tmag_external_box') })).status).toBe(403);
    const none = await check(REFS);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Basic/);
    expect((await check(REFS, { auth: basic('tmag_nope') })).status).toBe(401);
  });

  it('checks a GraphQL body Envoy forwards', async () => {
    const res = await check('/api/graphql', {
      method: 'POST', auth: `token ${BOX_TOKEN}`, body: '{"query":"mutation { addDeployKey(input:{}) { x } }"}',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/Blocked by the termag GitHub broker: graphql addDeployKey/);
    const ok = await check('/api/graphql', { method: 'POST', auth: `token ${BOX_TOKEN}`, body: '{"query":"{viewer{login}}"}' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('authorization')).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  it('never logs a token', async () => {
    await check(REFS, { auth: basic(BOX_TOKEN) });
    await check('/api/v3/user/keys', { method: 'POST', auth: `token ${BOX_TOKEN}` });
    const all = logs.join('\n');
    expect(all).not.toContain(BOX_TOKEN);
    expect(all).not.toContain(OWNER_TOKEN);
  });
});
