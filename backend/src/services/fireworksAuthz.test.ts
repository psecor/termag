import { describe, it, expect, beforeEach } from 'vitest';
import { ALLOW_TTL_MS, decideFireworksRequest, type FireworksAuthzDeps } from './fireworksAuthz';
import { parseFireworksModels } from './fireworksGateway';
import type { AuthzBox } from './gatewayAuthz';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const GLM = 'accounts/fireworks/models/glm-5p3';
const FW = parseFireworksModels({ models: [{ id: KIMI }, { id: 'accounts/fireworks/routers/kimi-k3-fast' }] });

const BOX_TOKEN = 'tmag_box_token_sentinel_fw_0123456789'; // gitleaks:allow (test sentinel)
const MANAGED: AuthzBox = { userId: 'owner1', instanceId: 'inst1', managed: true, email: 'o@example.com' };
const PATH = '/fireworks/inference/v1/chat/completions';

let clock = 1_000_000;
let lookups = 0;
let flagReads = 0;
let box: AuthzBox | null = MANAGED;
let enabled = true;
let list = FW;

function deps(over: Partial<FireworksAuthzDeps> = {}): FireworksAuthzDeps {
  return {
    configured: true,
    boxForToken: async t => { lookups++; return t === BOX_TOKEN ? box : null; },
    modelsFor: async () => { flagReads++; return enabled ? list : null; },
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
  flagReads = 0;
  box = MANAGED;
  enabled = true;
  list = FW;
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

  it("allows only a model on the owner's fireworks-models list, naming the allowed ones, and needs the model", async () => {
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: GLM })).toMatchObject({
      allow: false, status: 403, message: `The termag Fireworks gateway does not allow this model for you. Allowed: ${KIMI}, accounts/fireworks/routers/kimi-k3-fast`,
    });
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: 'accounts/fireworks/routers/kimi-k3-fast' })).toMatchObject({ allow: true });
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined })).toMatchObject({ allow: false, status: 400 });
  });

  it('lets auth-check through without a model while Fireworks is on', async () => {
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined, path: '/fireworks/auth-check' })).toMatchObject({ allow: true });
    enabled = false;
    clock += ALLOW_TTL_MS;
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined, path: '/fireworks/auth-check' })).toMatchObject({ allow: false, status: 403 });
  });

  it('refuses when the flag is off for the owner, or the orchestrator has no Fireworks config', async () => {
    enabled = false;
    expect(await decide()).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/fireworks-enabled/) });
    enabled = true;
    expect(await decide(undefined, deps({ configured: false }))).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/no Fireworks gateway/) });
  });

  it('remembers an allow for ALLOW_TTL_MS per token and model, and never a refusal', async () => {
    await decide();
    expect(await decide()).toMatchObject({ allow: true, audit: expect.stringMatching(/\(cached\)$/) });
    expect([lookups, flagReads]).toEqual([1, 1]);
    // A model dropped from the list since is checked afresh, not served from another model's allow.
    list = parseFireworksModels({ models: [{ id: GLM }] });
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: 'accounts/fireworks/routers/kimi-k3-fast' })).toMatchObject({ allow: false, status: 403 });
    list = FW;
    clock += ALLOW_TTL_MS;
    enabled = false;
    expect(await decide()).toMatchObject({ allow: false, status: 403 });
    expect(await decide()).toMatchObject({ allow: false, status: 403 });
    expect(flagReads).toBe(4);
  });
});
