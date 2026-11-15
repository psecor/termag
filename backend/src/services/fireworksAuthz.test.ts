import { describe, it, expect, beforeEach } from 'vitest';
import { ADD_KEY_MESSAGE, ALLOW_TTL_MS, decideFireworksRequest, REJECTED_KEY_MESSAGE, type FireworksAuthzDeps } from './fireworksAuthz';
import type { OwnerKeyState } from './fireworksKey';
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
      audit: `user=owner1 instance=inst1 ${PATH} model=${KIMI} key=shared allowed`,
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
      audit: `user=owner1 instance=inst1 ${PATH} model=${UNLISTED} key=shared allowed`,
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
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: UNLISTED })).toMatchObject({ allow: true, audit: expect.stringMatching(new RegExp(`model=${UNLISTED} key=shared allowed \\(cached\\)$`)) });
    expect(lookups).toBe(1);
    clock += ALLOW_TTL_MS;
    box = null;
    expect(await decide()).toMatchObject({ allow: false, status: 401 });
    expect(await decide()).toMatchObject({ allow: false, status: 401 });
    expect(lookups).toBe(3);
  });
});

describe("decideFireworksRequest with the owner's own key", () => {
  const OWN = 'fw_ownerKeySentinel0123456789'; // gitleaks:allow (test sentinel)
  let owner: OwnerKeyState = { state: 'none' };
  let required = false;
  let used: string[] = [];
  let flagReads = 0;
  const keyDeps = (over: Partial<FireworksAuthzDeps> = {}) => deps({
    ownerKey: async () => owner,
    keyRequired: async () => { flagReads++; return required; },
    onOwnerKeyUsed: userId => { used.push(userId); },
    ...over,
  });
  beforeEach(() => { owner = { state: 'none' }; required = false; used = []; flagReads = 0; });

  it("hands Envoy the owner's key, and starts a re-check of it", async () => {
    owner = { state: 'valid', key: OWN };
    expect(await decide(undefined, keyDeps())).toEqual({
      allow: true,
      audit: `user=owner1 instance=inst1 ${PATH} model=${KIMI} key=own allowed`,
      headers: { 'x-termag-user': 'owner1', 'x-termag-instance': 'inst1', 'x-termag-email': 'o@example.com', 'x-termag-fireworks-key': `Bearer ${OWN}` },
    });
    expect(used).toEqual(['owner1']);
    expect(flagReads).toBe(0);
  });

  it('never puts the key in the audit line', async () => {
    owner = { state: 'valid', key: OWN };
    const d = await decide(undefined, keyDeps());
    expect(d.audit).not.toContain(OWN);
  });

  it('reads the key again on a cached allow, so a new or deleted key applies within its own cache', async () => {
    owner = { state: 'valid', key: OWN };
    await decide(undefined, keyDeps());
    owner = { state: 'none' };
    expect(await decide(undefined, keyDeps())).toMatchObject({ allow: true, audit: expect.stringMatching(/key=shared allowed \(cached\)$/), headers: expect.not.objectContaining({ 'x-termag-fireworks-key': expect.anything() }) });
    expect(lookups).toBe(1);
  });

  it('carries no key on auth-check, which forwards nothing', async () => {
    owner = { state: 'valid', key: OWN };
    const d = await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined, path: '/fireworks/auth-check' }, keyDeps());
    expect(d).toMatchObject({ allow: true, audit: expect.stringContaining('key=own') });
    expect(d.allow && d.headers['x-termag-fireworks-key']).toBeFalsy();
    expect(used).toEqual([]);
  });

  it('refuses a key Fireworks rejected, or one that expired, whatever the flag', async () => {
    owner = { state: 'invalid', reason: 'rejected', at: '2026-11-08T00:00:00Z' };
    expect(await decide(undefined, keyDeps())).toMatchObject({ allow: false, status: 403, message: REJECTED_KEY_MESSAGE, audit: expect.stringMatching(/own key rejected/) });
    owner = { state: 'invalid', reason: 'expired', at: '2026-11-01T00:00:00Z' };
    expect(await decide(undefined, keyDeps())).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/expired on 2026-11-01\. Add a new one in termag Settings/) });
    expect(await decide({ authorization: `Bearer ${BOX_TOKEN}`, model: undefined, path: '/fireworks/auth-check' }, keyDeps())).toMatchObject({ allow: false, status: 403 });
    expect(flagReads).toBe(0);
  });

  it('without a key: the shared one, or a refusal asking for one while the flag is on', async () => {
    expect(await decide(undefined, keyDeps())).toMatchObject({ allow: true, audit: expect.stringContaining('key=shared') });
    required = true;
    expect(await decide(undefined, keyDeps())).toMatchObject({ allow: false, status: 403, message: ADD_KEY_MESSAGE });
    expect(ADD_KEY_MESSAGE).toMatch(/add your Fireworks API key in termag Settings/i);
    expect(flagReads).toBe(2);
  });

  it('answers the checks before the key: an unknown token or unmanaged box never reads one', async () => {
    let reads = 0;
    const d = keyDeps({ ownerKey: async () => { reads++; return owner; } });
    expect(await decide({ authorization: 'Bearer tmag_other' }, d)).toMatchObject({ allow: false, status: 401 });
    box = { userId: 'owner1', instanceId: 'inst2', managed: false };
    expect(await decide(undefined, d)).toMatchObject({ allow: false, status: 403 });
    expect(reads).toBe(0);
  });

  it('lets a failure reading the key reach the route as an error (a 503), not the shared key', async () => {
    await expect(decide(undefined, keyDeps({ ownerKey: async () => { throw new Error('KMS is unavailable'); } }))).rejects.toThrow(/KMS/);
  });
});
