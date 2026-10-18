import { describe, it, expect } from 'vitest';
import { decideGithubRequest, type AuthzDeps } from './githubAuthz';
import type { AuthzBox } from './gatewayAuthz';

const BOX_TOKEN = 'tmag_box_token_sentinel_0123456789'; // gitleaks:allow (test sentinel)
const OWNER_TOKEN = 'gho_OWNERsentinelOWNERsentinel0123'; // gitleaks:allow (test sentinel)
const basic = (t: string) => `Basic ${Buffer.from(`termag-box:${t}`).toString('base64')}`;

function deps(over: Partial<{ box: AuthzBox | null; owner: string | null }> = {}): AuthzDeps {
  const box = 'box' in over ? over.box : { userId: 'owner1', instanceId: 'inst1', managed: true };
  const owner = 'owner' in over ? over.owner : OWNER_TOKEN;
  return {
    boxForToken: async t => (t === BOX_TOKEN ? box ?? null : null),
    ownerToken: async () => owner ?? null,
  };
}

const req = (method: string, path: string, extra: Partial<{ search: string; authorization: string; body: string }> = {}) => ({
  method, path, search: extra.search ?? '', authorization: 'authorization' in extra ? extra.authorization : basic(BOX_TOKEN), body: extra.body ?? '',
});

describe('decideGithubRequest', () => {
  it("allows a managed box's git request with the owner's Basic token", async () => {
    const d = await decideGithubRequest(req('GET', '/o/r.git/info/refs', { search: '?service=git-upload-pack' }), deps());
    expect(d).toMatchObject({
      allow: true,
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${OWNER_TOKEN}`).toString('base64')}`,
        'x-termag-user': 'owner1',
        'x-termag-instance': 'inst1',
        'x-termag-target': 'git /o/r.git/info/refs?service=git-upload-pack',
      },
    });
  });

  it("gives the API and GraphQL the owner's Bearer token, from gh's token header", async () => {
    const d = await decideGithubRequest(req('GET', '/api/v3/user', { authorization: `token ${BOX_TOKEN}` }), deps());
    expect(d).toMatchObject({ allow: true, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    const g = await decideGithubRequest(req('POST', '/api/graphql', { body: '{"query":"{viewer{login}}"}' }), deps());
    expect(g).toMatchObject({ allow: true, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  });

  it('refuses a path the broker does not forward', async () => {
    expect(await decideGithubRequest(req('GET', '/login/oauth/access_token'), deps())).toMatchObject({ allow: false, status: 404 });
  });

  it('asks for a box token, and refuses an unknown one', async () => {
    const none = await decideGithubRequest(req('GET', '/api/v3/user', { authorization: undefined }), deps());
    expect(none).toMatchObject({ allow: false, status: 401, headers: { 'www-authenticate': expect.stringContaining('Basic') } });
    const bad = await decideGithubRequest(req('GET', '/api/v3/user', { authorization: basic('tmag_other') }), deps());
    expect(bad).toMatchObject({ allow: false, status: 401 });
  });

  it('refuses a box termag does not manage, even with its own valid token', async () => {
    const d = await decideGithubRequest(req('GET', '/api/v3/user'), deps({ box: { userId: 'owner1', instanceId: 'inst2', managed: false } }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/managed box/) });
  });

  it('refuses when the owner has no GitHub credential', async () => {
    const d = await decideGithubRequest(req('GET', '/api/v3/user'), deps({ owner: null }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/Connect GitHub/) });
  });

  it('applies the blocklist to REST paths, a PATCH body and GraphQL', async () => {
    expect(await decideGithubRequest(req('POST', '/api/v3/user/keys'), deps())).toMatchObject({ allow: false, status: 403 });
    expect(await decideGithubRequest(req('DELETE', '/api/v3/repos/o/r'), deps())).toMatchObject({ allow: false, status: 403 });
    expect(await decideGithubRequest(req('PATCH', '/api/v3/repos/o/r', { body: '{"visibility":"public"}' }), deps()))
      .toMatchObject({ allow: false, message: expect.stringMatching(/visibility/) });
    expect(await decideGithubRequest(req('POST', '/api/graphql', { body: '{"query":"mutation { addDeployKey(input:{}) { x } }"}' }), deps()))
      .toMatchObject({ allow: false, message: expect.stringMatching(/DeployKey/) });
    expect(await decideGithubRequest(req('PATCH', '/api/v3/repos/o/r', { body: '{"description":"x"}' }), deps())).toMatchObject({ allow: true });
  });

  it('closes the paths that reach GitHub without the body a check needs', async () => {
    const mutation = '{"query":"mutation { addDeployKey(input:{}) { x } }"}';
    expect(await decideGithubRequest(req('POST', '/api/v3/graphql', { body: mutation }), deps())).toMatchObject({ allow: false, status: 404 });
    expect(await decideGithubRequest(req('PATCH', '/api/v3/repos/o/r%2F'), deps()))
      .toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/cannot check/) });
  });

  it('never puts a token in the audit line or a refusal', async () => {
    const all = await Promise.all([
      decideGithubRequest(req('GET', '/api/v3/user'), deps()),
      decideGithubRequest(req('POST', '/api/v3/user/keys'), deps()),
      decideGithubRequest(req('GET', '/api/v3/user'), deps({ owner: null })),
    ]);
    for (const d of all) {
      const text = JSON.stringify({ audit: d.audit, message: d.allow ? '' : d.message });
      expect(text).not.toContain(BOX_TOKEN);
      expect(text).not.toContain(OWNER_TOKEN);
    }
  });
});
