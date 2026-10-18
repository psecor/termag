import { describe, it, expect, beforeEach } from 'vitest';
import { ALLOW_TTL_MS, bearerFrom, decideClaudeRequest, type ClaudeAuthzDeps } from './claudeAuthz';
import type { AuthzBox } from './gatewayAuthz';

const BOX_TOKEN = 'tmag_box_token_sentinel_0123456789'; // gitleaks:allow (test sentinel)
const MANAGED: AuthzBox = { userId: 'owner1', instanceId: 'inst1', managed: true, email: 'o@example.com' };
const PATH = '/model/us.anthropic.claude-opus-x/invoke-with-response-stream';

let clock = 1_000_000;
let lookups = 0;
let box: AuthzBox | null = MANAGED;
let enabled = true;

function deps(over: Partial<ClaudeAuthzDeps> = {}): ClaudeAuthzDeps {
  return {
    configured: true,
    boxForToken: async t => { lookups++; return t === BOX_TOKEN ? box : null; },
    gatewayEnabled: async () => enabled,
    now: () => clock,
    ...over,
  };
}
const decide = (authorization: string | undefined = `Bearer ${BOX_TOKEN}`, d = deps()) =>
  decideClaudeRequest({ path: PATH, authorization }, d);

// The allow cache is module state; moving the clock past its TTL keeps each
// test from seeing the previous one's allows.
beforeEach(() => {
  clock += ALLOW_TTL_MS;
  lookups = 0;
  box = MANAGED;
  enabled = true;
});

describe('decideClaudeRequest', () => {
  it("allows a managed box's own token, naming the box for Envoy's access log", async () => {
    expect(await decide()).toEqual({
      allow: true,
      audit: `user=owner1 instance=inst1 ${PATH} allowed`,
      headers: { 'x-termag-user': 'owner1', 'x-termag-instance': 'inst1', 'x-termag-email': 'o@example.com' },
    });
  });

  it('asks for a Bearer token, and refuses an unknown or revoked one', async () => {
    expect(await decide('')).toMatchObject({ allow: false, status: 401, headers: { 'www-authenticate': expect.stringContaining('Bearer') } });
    expect(await decide(`Basic ${Buffer.from(`x:${BOX_TOKEN}`).toString('base64')}`)).toMatchObject({ allow: false, status: 401 });
    expect(await decide('Bearer tmag_other')).toMatchObject({ allow: false, status: 401, message: expect.stringMatching(/Unknown or revoked/) });
  });

  it("refuses a box termag does not manage, and a user's laptop agent, even with valid tokens", async () => {
    box = { userId: 'owner1', instanceId: 'inst2', managed: false };
    expect(await decide()).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/managed box/) });
  });

  it('refuses when the owner turned the gateway off, or the orchestrator has none', async () => {
    enabled = false;
    expect(await decide()).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/turned off/) });
    enabled = true;
    expect(await decide('', deps({ configured: false }))).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/no Claude gateway/) });
  });

  it('remembers an allow for a few seconds, then looks the token up again', async () => {
    await decide();
    clock += ALLOW_TTL_MS - 1;
    expect(await decide()).toMatchObject({ allow: true, audit: expect.stringMatching(/\(cached\)$/) });
    expect(lookups).toBe(1);
    clock += 1;
    box = null;
    expect(await decide()).toMatchObject({ allow: false, status: 401 });
    expect(lookups).toBe(2);
  });

  it('never remembers a refusal, so fixing the cause works on the next call', async () => {
    enabled = false;
    expect(await decide()).toMatchObject({ allow: false });
    enabled = true;
    expect(await decide()).toMatchObject({ allow: true });
  });

  it('lets a revoked token or a gateway turned off take effect once the allow expires', async () => {
    await decide();
    box = null;
    expect(await decide()).toMatchObject({ allow: true });
    clock += ALLOW_TTL_MS;
    expect(await decide()).toMatchObject({ allow: false, status: 401 });

    box = MANAGED;
    await decide();
    enabled = false;
    clock += ALLOW_TTL_MS;
    expect(await decide()).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/turned off/) });
  });

  it('never puts the token in the audit line or a refusal', async () => {
    const all = [await decide(), await decide('Bearer tmag_other'), await decide()];
    for (const d of all) {
      expect(JSON.stringify({ audit: d.audit, message: d.allow ? '' : d.message, headers: d.headers })).not.toContain(BOX_TOKEN);
    }
  });
});

describe('bearerFrom', () => {
  it('takes exactly one Bearer credential', () => {
    expect(bearerFrom(`bearer ${BOX_TOKEN}`)).toBe(BOX_TOKEN);
    expect(bearerFrom(`Bearer ${BOX_TOKEN} extra`)).toBeNull();
    expect(bearerFrom('Bearer')).toBeNull();
    expect(bearerFrom(`token ${BOX_TOKEN}`)).toBeNull();
  });
});
