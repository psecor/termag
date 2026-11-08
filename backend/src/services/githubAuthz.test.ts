import { describe, it, expect, vi } from 'vitest';
import { decideGithubRequest, oncePerUser, type AuthzDeps } from './githubAuthz';
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

describe('decideGithubRequest: the github.push event', () => {
  it('records an allowed push with the owner, the box and the repository, nothing else', async () => {
    const record = vi.fn();
    const d = await decideGithubRequest(req('POST', '/acme/widgets.git/git-receive-pack'), { ...deps(), record });
    expect(d.allow).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('github.push', { user: 'owner1', box: 'inst1' }, { repo: 'acme/widgets' });
  });

  it('records no fetch, ref advertisement, API call or refused push', async () => {
    const record = vi.fn();
    await decideGithubRequest(req('POST', '/acme/widgets.git/git-upload-pack'), { ...deps(), record });
    await decideGithubRequest(req('GET', '/acme/widgets.git/info/refs', { search: '?service=git-receive-pack' }), { ...deps(), record });
    await decideGithubRequest(req('POST', '/api/v3/repos/acme/widgets/pulls', { body: '{}' }), { ...deps(), record });
    await decideGithubRequest(req('POST', '/acme/widgets.git/git-receive-pack'), { ...deps({ owner: null }), record });
    await decideGithubRequest(req('POST', '/acme/widgets.git/git-receive-pack', { authorization: undefined }), { ...deps(), record });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('decideGithubRequest: an org whose SSO has not authorized the token', () => {
  const SSO_URL = 'https://github.com/orgs/example-org/sso?authorization_request=abc';
  const ssoDeps = (onSsoRequired = vi.fn()): AuthzDeps => ({
    ...deps(),
    ownerOrgs: async () => ({ 'example-org': { status: 'sso-required', ssoUrl: SSO_URL }, acme: { status: 'ok' } }),
    onSsoRequired,
  });

  it('refuses REST and git requests to that org, says how to authorize it, and asks for a re-check', async () => {
    const onSsoRequired = vi.fn();
    const rest = await decideGithubRequest(req('GET', '/api/v3/repos/example-org/webapp/pulls'), ssoDeps(onSsoRequired));
    expect(rest).toMatchObject({ allow: false, status: 403, message: expect.stringContaining(SSO_URL) });
    expect(rest.allow ? '' : rest.message).toMatch(/termag Settings.*SAML SSO/);
    const git = await decideGithubRequest(req('GET', '/Example-Org/foundation/info/refs', { search: '?service=git-upload-pack' }), ssoDeps(onSsoRequired));
    expect(git).toMatchObject({ allow: false, status: 403, message: expect.stringContaining(SSO_URL) });
    expect(onSsoRequired).toHaveBeenCalledTimes(2);
    expect(onSsoRequired).toHaveBeenCalledWith('owner1');
    expect(JSON.stringify(rest)).not.toContain(OWNER_TOKEN);
  });

  it('forwards requests to other orgs, ones that name no org, and everything when the state is unknown', async () => {
    const onSsoRequired = vi.fn();
    expect(await decideGithubRequest(req('GET', '/api/v3/repos/acme/widgets'), ssoDeps(onSsoRequired))).toMatchObject({ allow: true });
    expect(await decideGithubRequest(req('GET', '/api/v3/user'), ssoDeps(onSsoRequired))).toMatchObject({ allow: true });
    expect(await decideGithubRequest(req('POST', '/api/graphql', { body: '{"query":"{viewer{login}}"}' }), ssoDeps(onSsoRequired))).toMatchObject({ allow: true });
    expect(onSsoRequired).not.toHaveBeenCalled();
    expect(await decideGithubRequest(req('GET', '/api/v3/repos/example-org/webapp'), { ...deps(), ownerOrgs: async () => ({}) }))
      .toMatchObject({ allow: true });
  });
});

describe('oncePerUser', () => {
  it('runs once per user per interval', () => {
    let t = 0;
    const fn = vi.fn();
    const once = oncePerUser(fn, 1000, () => t);
    once('a'); once('a'); once('b');
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
    t = 999; once('a');
    t = 1000; once('a');
    expect(fn.mock.calls).toEqual([['a'], ['b'], ['a']]);
  });
});

describe('decideGithubRequest: the environment pool rule', () => {
  const POOL_TOKEN = 'github_pat_POOLsentinelPOOLsentinel0123'; // gitleaks:allow (test sentinel)
  const ENV_REPOS = ['example-org/termag', 'example-org/webapp'];
  const poolBox = (status = 'env-preparing', environmentId: string | null = 'env1'): AuthzBox =>
    ({ userId: '-', instanceId: 'pool1', managed: false, pool: { status, environmentId } });
  function poolDeps(over: Partial<{ box: AuthzBox; poolToken: string | null; repos: readonly string[] | null }> = {}): AuthzDeps {
    const box = over.box ?? poolBox();
    const ownerToken = vi.fn(async () => OWNER_TOKEN);
    return {
      boxForToken: async t => (t === BOX_TOKEN ? box : null),
      ownerToken,
      poolToken: async () => ('poolToken' in over ? over.poolToken ?? null : POOL_TOKEN),
      poolEnvironmentRepos: async id => (id === 'env1' ? ('repos' in over ? over.repos ?? null : ENV_REPOS) : null),
    };
  }
  const refsUpload = () => req('GET', '/example-org/termag.git/info/refs', { search: '?service=git-upload-pack' });

  it("answers a preparing pool box's fetch of its environment's repository with the pool credential", async () => {
    const deps = poolDeps();
    const refs = await decideGithubRequest(refsUpload(), deps);
    expect(refs).toEqual({
      allow: true,
      audit: 'pool instance=pool1 environment=env1 status=env-preparing git GET /example-org/termag.git/info/refs?service=git-upload-pack allowed (pool credential)',
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${POOL_TOKEN}`).toString('base64')}`,
        'x-termag-user': 'pool',
        'x-termag-instance': 'pool1',
        'x-termag-target': 'git /example-org/termag.git/info/refs?service=git-upload-pack',
      },
    });
    const pack = await decideGithubRequest(req('POST', '/Example-Org/Webapp/git-upload-pack'), deps);
    expect(pack).toMatchObject({ allow: true, headers: { 'x-termag-user': 'pool' } });
    // Never the owner's path: a pool box has no owner.
    expect(deps.ownerToken).not.toHaveBeenCalled();
  });

  it.each(['env-stopping', 'env-stopped', 'env-starting', 'env-failed'])('refuses a pool box that is %s', async status => {
    const d = await decideGithubRequest(refsUpload(), poolDeps({ box: poolBox(status) }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(new RegExp(`pool rule \\(preparing only\\).*${status}`)) });
  });

  it('refuses a push, its ref advertisement included', async () => {
    const adv = await decideGithubRequest(req('GET', '/example-org/termag.git/info/refs', { search: '?service=git-receive-pack' }), poolDeps());
    expect(adv).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(fetch only\).*may not push/) });
    const push = await decideGithubRequest(req('POST', '/example-org/termag.git/git-receive-pack'), poolDeps());
    expect(push).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/may not push/) });
  });

  it('refuses the REST API and GraphQL, reads included', async () => {
    const rest = await decideGithubRequest(req('GET', '/api/v3/repos/example-org/termag'), poolDeps());
    expect(rest).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(fetch only\).*REST API/) });
    const gql = await decideGithubRequest(req('POST', '/api/graphql', { body: '{"query":"{viewer{login}}"}' }), poolDeps());
    expect(gql).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(fetch only\).*GraphQL/) });
  });

  it("refuses a repository that is not one of the environment's", async () => {
    const d = await decideGithubRequest(req('GET', '/example-org/secret-thing.git/info/refs', { search: '?service=git-upload-pack' }), poolDeps());
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(its environment\).*example-org\/secret-thing is not one/) });
    expect(d.allow === false && d.audit).toMatch(/refused \(pool rule: its environment\)/);
  });

  it('refuses a pool box with no environment, or one the pool cannot prepare', async () => {
    const none = await decideGithubRequest(refsUpload(), poolDeps({ box: poolBox('env-preparing', null) }));
    expect(none).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/names no environment/) });
    const personal = await decideGithubRequest(refsUpload(), poolDeps({ repos: null }));
    expect(personal).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/not one a pool can prepare/) });
  });

  it('checks for the pool credential before it resolves the environment, so no lookup runs without one', async () => {
    const lookup = vi.fn(async () => ['example-org/termag']);
    const d = await decideGithubRequest(refsUpload(), { ...poolDeps({ poolToken: null }), poolEnvironmentRepos: lookup });
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(pool credential\)/) });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses when no pool credential is set, or the broker was given no pool source', async () => {
    const unset = await decideGithubRequest(refsUpload(), poolDeps({ poolToken: null }));
    expect(unset).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/pool rule \(pool credential\).*no pool GitHub credential/) });
    const { poolToken: _t, poolEnvironmentRepos: _r, ...bare } = poolDeps();
    expect(await decideGithubRequest(refsUpload(), bare)).toMatchObject({ allow: false, status: 403 });
  });

  it('reads the repositories the row was launched to prepare, when it records them, before resolving the environment', async () => {
    const resolve = vi.fn(async () => ENV_REPOS);
    const box: AuthzBox = { userId: '-', instanceId: 'pool1', managed: false, pool: { status: 'env-preparing', environmentId: 'env1', repos: ['e2e-org/envdemo'] } };
    const deps = { ...poolDeps({ box }), poolEnvironmentRepos: resolve };
    expect(await decideGithubRequest(req('GET', '/e2e-org/envdemo.git/info/refs', { search: '?service=git-upload-pack' }), deps)).toMatchObject({ allow: true });
    expect(await decideGithubRequest(refsUpload(), deps)).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/its environment/) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves a warm-pool box and an owned box as they were', async () => {
    const warm = await decideGithubRequest(refsUpload(), poolDeps({ box: { userId: '-', instanceId: 'w1', managed: false, pool: { status: 'warm', environmentId: null } } }));
    expect(warm).toMatchObject({ allow: false, status: 403, message: expect.stringMatching(/managed box/) });
    const owned = await decideGithubRequest(req('POST', '/example-org/termag.git/git-receive-pack'), { ...poolDeps(), record: vi.fn(), boxForToken: async () => ({ userId: 'owner1', instanceId: 'inst1', managed: true }) });
    expect(owned).toMatchObject({ allow: true, headers: { 'x-termag-user': 'owner1' } });
  });
});
