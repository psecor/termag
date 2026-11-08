import { describe, it, expect, beforeEach } from 'vitest';
import { ALLOW_TTL_MS, decideFireworksRequest, type FireworksAuthzDeps } from './fireworksAuthz';
import type { AuthzBox } from './gatewayAuthz';

const KIMI = 'accounts/fireworks/models/kimi-k3';
// Not on any fireworks-models list: the check no longer reads one.
const UNLISTED = 'accounts/fireworks/models/minimax-m3p1-flash';

const BOX_TOKEN = 'tmag_box_token_sentinel_fw_0123456789'; // gitleaks:allow (test sentinel)
const MANAGED: AuthzBox = { userId: 'owner1', instanceId: 'inst1', managed: true, email: 'o@example.com' };
const PATH = '/fireworks/inference/v1/chat/completions';

let clock = 1_000_000;
let lookups = 0;
let box: AuthzBox | null = MANAGED;

function deps(over: Partial<FireworksAuthzDeps> = {}): FireworksAuthzDeps {
  return {
    configured: true,
    boxForToken: async t => { lookups++; return t === BOX_TOKEN ? box : null; },
    now: () => clock,
    ...over,
  };
}
const decide = (headers: { authorization?: string; apiKey?: string; model?: string; path?: string } = { authorization: `Bearer ${BOX_TOKEN}` }, d = deps()) =>
  decideFireworksRequest({
    path: headers.path ?? PATH, authorization: headers.authorization, apiKey: headers.apiKey,
    model: 'model' in headers ? headers.model : KIMI,
  }, d);

beforeEach(() => {
  clock += ALLOW_TTL_MS;
  lookups = 0;
  box = MANAGED;
});

describe('decideFireworksRequest', () => {
  it("allows a managed box's own token, naming the box for Envoy's access log", async () => {
    expect(await decide()).toEqual({
      allow: true,
      audit: `user=owner1 instance=inst1 ${PATH} model=${KIMI} allowed`,
      headers: { 'x-termag-user': 'owner1', 'x-termag-instance': 'inst1', 'x-termag-email': 'o@example.com' },
    });
  });

  it("takes the token as x-api-key too (Claude Code's apiKeyHelper)", async () => {
    expect(await decide({ apiKey: BOX_TOKEN })).toMatchObject({ allow: true });
    expect(await decide({ apiKey: `${BOX_TOKEN} extra` })).toMatchObject({ allow: false, status: 401 });
  });

  it('asks for a token, and refuses an unknown or revoked one', async () => {
    expect(await decide({})).toMatchObject({ allow: false, status: 401, headers: { 'www-authenticate': expect.stringContaining('Fireworks') } });
    expect(await decide({ authorization: 'Bearer tmag_other' })).toMatchObject({ allow: false, status: 401, message: expect.stringMatching(/Unknown or revoked/) });
  });

  it("refuses a box termag does not manage, and a user's laptop agent", async () => {
    box = { userId: 'owner1', instanceId: 'inst2', managed: false };
    expect(await decide()).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/managed box/) });
  });

  it('allows any model id, listed or not, and leaves odd or missing ones for Fireworks to answer', async () => {
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: UNLISTED })).toEqual({
      allow: true,
      audit: `user=owner1 instance=inst1 ${PATH} model=${UNLISTED} allowed`,
      headers: { 'x-termag-user': 'owner1', 'x-termag-instance': 'inst1', 'x-termag-email': 'o@example.com' },
    });
    for (const model of ['accounts/fireworks/routers/kimi-k3-fast', 'accounts/someone-else/models/x', 'not-a-fireworks-id']) {
      expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model })).toMatchObject({ allow: true, audit: expect.stringContaining(`model=${model}`) });
    }
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined })).toMatchObject({ allow: true, audit: expect.not.stringContaining('model=') });
  });

  it('refuses any path but the two inference calls and auth-check, before reading the token', async () => {
    for (const path of ['/fireworks/inference/v1/models', '/fireworks/inference/v1/messages/count_tokens', '/fireworks/inference/v1/batches',
      '/fireworks/v1/accounts/fireworks/models', '/fireworks/inference/v1/chat/completions/../../v1/batches', '/fireworks/inference/v1/Messages']) {
      expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, path })).toMatchObject({ allow: false, status: 404 });
    }
    expect(lookups).toBe(0);
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, path: '/fireworks/inference/v1/messages' })).toMatchObject({ allow: true });
  });

  it('lets auth-check through without a model', async () => {
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined, path: '/fireworks/auth-check' })).toMatchObject({ allow: true });
  });

  it('refuses when the orchestrator has no Fireworks config', async () => {
    expect(await decide(undefined, deps({ configured: false }))).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/no Fireworks gateway/) });
  });

  it('remembers an allow for ALLOW_TTL_MS per token, whatever the model, and never a refusal', async () => {
    await decide();
    expect(await decide()).toMatchObject({ allow: true, audit: expect.stringMatching(/\(cached\)$/) });
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: UNLISTED })).toMatchObject({ allow: true, audit: expect.stringMatching(new RegExp(`model=${UNLISTED} allowed \\(cached\\)$`)) });
    expect(lookups).toBe(1);
    clock += ALLOW_TTL_MS;
    box = null;
    expect(await decide()).toMatchObject({ allow: false, status: 401 });
    expect(await decide()).toMatchObject({ allow: false, status: 401 });
    expect(lookups).toBe(3);
  });
});
