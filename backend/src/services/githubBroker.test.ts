import { describe, it, expect } from 'vitest';
import {
  blockedApiReason,
  blockedGraphqlReason,
  boxTokenFrom,
  brokerTarget,
  cachedTokenSource,
  getGithubBrokerUrl,
  MAX_CHECKED_BODY_BYTES,
  ownerAuthorization,
} from './githubBroker';

describe('brokerTarget', () => {
  it('maps GHES-layout git smart-HTTP paths to github.com', () => {
    expect(brokerTarget('GET', '/example-org/webapp.git/info/refs', '?service=git-upload-pack')).toEqual({
      kind: 'git',
      logPath: '/example-org/webapp.git/info/refs?service=git-upload-pack',
    });
    expect(brokerTarget('POST', '/o/r/git-receive-pack', '')).toEqual({ kind: 'git', logPath: '/o/r/git-receive-pack' });
  });

  it('maps /api/v3 to the REST API and /api/graphql to GraphQL', () => {
    expect(brokerTarget('GET', '/api/v3/repos/o/r', '?per_page=5')).toEqual({ kind: 'api', logPath: '/repos/o/r' });
    expect(brokerTarget('GET', '/api/v3/', '')?.logPath).toBe('/');
    expect(brokerTarget('GET', '/api/v3', '')?.logPath).toBe('/');
    expect(brokerTarget('POST', '/api/graphql', '')).toEqual({ kind: 'graphql', logPath: '/graphql' });
  });

  it('refuses GraphQL under /api/v3, which would skip the GraphQL body check', () => {
    expect(brokerTarget('POST', '/api/v3/graphql', '')).toBeNull();
    expect(brokerTarget('POST', '/api/v3/GraphQL/', '')).toBeNull();
    expect(brokerTarget('POST', '/api/v3/%67raphql', '')).toBeNull();
    expect(brokerTarget('GET', '/api/v3/%E0%A4%A', '')).toBeNull();
  });

  it('never reads /api as a repository owner', () => {
    expect(brokerTarget('GET', '/api/v3/info/refs', '?service=git-upload-pack')).toEqual({ kind: 'api', logPath: '/info/refs' });
    expect(brokerTarget('POST', '/api/x/git-upload-pack', '')).toBeNull();
  });

  it('forwards nothing else', () => {
    expect(brokerTarget('GET', '/o/r/info/refs', '')).toBeNull();
    expect(brokerTarget('GET', '/o/r/info/refs', '?service=git-evil')).toBeNull();
    expect(brokerTarget('GET', '/o/r/git-upload-pack', '')).toBeNull();
    expect(brokerTarget('POST', '/o/r/objects/info/packs', '')).toBeNull();
    expect(brokerTarget('GET', '/o/../r/info/refs', '?service=git-upload-pack')).toBeNull();
    expect(brokerTarget('GET', '/o%2F/r/info/refs', '?service=git-upload-pack')).toBeNull();
    expect(brokerTarget('GET', '/api/v3//user', '')).toBeNull();
    expect(brokerTarget('GET', '/api/graphql', '')).toBeNull();
    expect(brokerTarget('GET', '/login/oauth/access_token', '')).toBeNull();
  });
});

describe('blockedApiReason', () => {
  it('blocks credential minting and admin endpoints for every method', () => {
    expect(blockedApiReason('POST', '/user/keys', '')).toMatch(/credential/);
    expect(blockedApiReason('GET', '/user/keys', '')).toMatch(/credential/);
    expect(blockedApiReason('POST', '/authorizations', '')).toMatch(/credential/);
    expect(blockedApiReason('POST', '/applications/abc/token', '')).toMatch(/credential/);
    expect(blockedApiReason('PUT', '/admin/users/x', '')).toMatch(/admin/);
    expect(blockedApiReason('POST', '/USER/GPG_KEYS/', '')).toMatch(/credential/);
  });

  it('blocks deploy keys, hooks, access grants, protection changes and repo deletion', () => {
    expect(blockedApiReason('POST', '/repos/o/r/keys', '')).not.toBeNull();
    expect(blockedApiReason('POST', '/repos/o/r/hooks', '')).not.toBeNull();
    expect(blockedApiReason('PUT', '/repos/o/r/collaborators/eve', '')).not.toBeNull();
    expect(blockedApiReason('DELETE', '/repos/o/r/branches/main/protection', '')).not.toBeNull();
    expect(blockedApiReason('PUT', '/orgs/o/memberships/eve', '')).not.toBeNull();
    expect(blockedApiReason('DELETE', '/repos/o/r', '')).toBe('repository deletion');
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"private": false}')).toBe('repository visibility change');
  });

  it('matches encoded and cased spellings of a blocked path', () => {
    expect(blockedApiReason('POST', '/user/%6Beys', '')).toMatch(/credential/);
    expect(blockedApiReason('DELETE', '/repos/o/r%2F', '')).toBe('repository deletion');
    expect(blockedApiReason('DELETE', '/Repos/O/R', '')).toBe('repository deletion');
  });

  it('refuses a repository PATCH that arrives without the body the check needs', () => {
    expect(blockedApiReason('PATCH', '/repos/o/r%2F', '')).toBe('repository update the broker cannot check');
    expect(blockedApiReason('PATCH', '/repos/o/r', '  ')).toBe('repository update the broker cannot check');
  });

  it("applies every repository and org rule to GitHub's ID aliases", () => {
    expect(blockedApiReason('PATCH', '/repositories/123456789', '{"private":false}')).toBe('repository visibility change');
    expect(blockedApiReason('PATCH', '/Repositories/123456789/', '{"visibility":"public"}')).toBe('repository visibility change');
    expect(blockedApiReason('PATCH', '/repositories/123456789', '')).toBe('repository update the broker cannot check');
    expect(blockedApiReason('DELETE', '/repositories/123456789', '')).toBe('repository deletion');
    expect(blockedApiReason('POST', '/repositories/123456789/hooks', '')).not.toBeNull();
    expect(blockedApiReason('POST', '/repositories/123456789/transfer', '')).not.toBeNull();
    expect(blockedApiReason('PUT', '/organizations/42/memberships/eve', '')).not.toBeNull();
    expect(blockedApiReason('PATCH', '/organizations/42', '{}')).not.toBeNull();
    expect(blockedApiReason('GET', '/repositories/123456789', '')).toBeNull();
    expect(blockedApiReason('PATCH', '/repositories/123456789', '{"description":"x"}')).toBeNull();
  });

  it('forwards ordinary work', () => {
    expect(blockedApiReason('GET', '/user', '')).toBeNull();
    expect(blockedApiReason('GET', '/repos/o/r/keys', '')).toBeNull();
    expect(blockedApiReason('POST', '/repos/o/r/pulls', '{"title":"x"}')).toBeNull();
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"description":"x"}')).toBeNull();
    expect(blockedApiReason('POST', '/repos/o/r/issues/1/comments', '{"body":"keys"}')).toBeNull();
  });
});

describe('blockedGraphqlReason', () => {
  it('blocks key, admin and destructive mutations wherever they appear', () => {
    expect(blockedGraphqlReason('{"query":"mutation { addDeployKey(input: {}) { clientMutationId } }"}')).toMatch(/DeployKey/);
    expect(blockedGraphqlReason('{"query":"mutation { x: deleteBranchProtectionRule (input:{}) { clientMutationId } }"}')).toMatch(/BranchProtectionRule/);
    expect(blockedGraphqlReason('{"query":"mutation { updateEnterpriseOwnerOrganizationRole(input:{}) { x } }"}')).toMatch(/Enterprise/);
  });

  it('forwards queries and ordinary mutations', () => {
    expect(blockedGraphqlReason('{"query":"query { viewer { login } }"}')).toBeNull();
    expect(blockedGraphqlReason('{"query":"mutation { createPullRequest(input:{}) { pullRequest { url } } }"}')).toBeNull();
    expect(blockedGraphqlReason(gql('query { repository(owner:"o", name:"r") { deployKeys(first:1) { totalCount } } }'))).toBeNull();
  });

  const gql = (query: string) => JSON.stringify({ query });

  it('blocks a mutation GraphQL ignored tokens would hide from a substring match', () => {
    expect(blockedGraphqlReason(gql('mutation { deleteRepository,(input:{repositoryId:"R"}) { clientMutationId } }'))).toBe('graphql deleteRepository');
    expect(blockedGraphqlReason(gql('mutation { addDeployKey #x\n(input:{}) { clientMutationId } }'))).toBe('graphql addDeployKey');
  });

  it('blocks a mutation spelled with JSON escapes in the request body', () => {
    expect(blockedGraphqlReason('{"query":"mutation { addDeployKey\\u0028input:{}) { clientMutationId } }"}')).toBe('graphql addDeployKey');
    expect(blockedGraphqlReason('{"query":"mutation { \\u0061ddDeployKey(input:{}) { clientMutationId } }"}')).toBe('graphql addDeployKey');
  });

  it('blocks updateRepository and transfer mutations, by field name not alias', () => {
    expect(blockedGraphqlReason(gql('mutation { updateRepository(input:{repositoryId:"R"}) { clientMutationId } }'))).toBe('graphql updateRepository');
    expect(blockedGraphqlReason(gql('mutation { safe: updateRepository(input:{repositoryId:"R"}) { clientMutationId } }'))).toBe('graphql updateRepository');
    expect(blockedGraphqlReason(gql('mutation { transferRepository(input:{}) { clientMutationId } }'))).toBe('graphql transferRepository');
  });

  it('blocks a mutation reached through a fragment or inline fragment', () => {
    expect(blockedGraphqlReason(gql('mutation { ...F } fragment F on Mutation { addDeployKey(input:{}) { clientMutationId } }'))).toBe('graphql addDeployKey');
    expect(blockedGraphqlReason(gql('mutation { ... on Mutation { updateRepository(input:{}) { clientMutationId } } }'))).toBe('graphql updateRepository');
    expect(blockedGraphqlReason(gql('mutation { ...Missing }'))).toMatch(/undefined fragment/);
  });

  it('refuses a body it cannot read or parse, or one that is too large', () => {
    expect(blockedGraphqlReason('not json')).toMatch(/cannot read/);
    expect(blockedGraphqlReason('[{"query":"query { viewer { login } }"}]')).toMatch(/cannot read/);
    expect(blockedGraphqlReason('{"query":42}')).toMatch(/cannot read/);
    expect(blockedGraphqlReason(gql('mutation { addDeployKey('))).toMatch(/cannot parse/);
    expect(blockedGraphqlReason(gql(`query { viewer { login } } #${'x'.repeat(MAX_CHECKED_BODY_BYTES)}`))).toMatch(/cannot read/);
  });
});

describe('blockedApiReason: repository PATCH body', () => {
  it('reads the decoded keys, so JSON escapes do not hide a visibility change', () => {
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"\\u0070rivate":false}')).toBe('repository visibility change');
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"vis\\u0069bility":"public"}')).toBe('repository visibility change');
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"archived":true}')).toBe('repository visibility change');
  });

  it('refuses a body it cannot read', () => {
    expect(blockedApiReason('PATCH', '/repos/o/r', '{"private": fal')).toBe('repository update the broker cannot read');
    expect(blockedApiReason('PATCH', '/repos/o/r', '[{"private":false}]')).toBe('repository update the broker cannot read');
    expect(blockedApiReason('PATCH', '/repos/o/r', JSON.stringify({ description: 'x'.repeat(MAX_CHECKED_BODY_BYTES) }))).toBe('repository update the broker cannot read');
  });
});

describe('boxTokenFrom', () => {
  const T = 'tmag_abcdef0123456789';
  it("reads git's Basic password and gh's token/Bearer header", () => {
    expect(boxTokenFrom(`Basic ${Buffer.from(`termag-box:${T}`).toString('base64')}`)).toBe(T);
    expect(boxTokenFrom(`token ${T}`)).toBe(T);
    expect(boxTokenFrom(`Bearer ${T}`)).toBe(T);
  });
  it('is null without one', () => {
    expect(boxTokenFrom(undefined)).toBeNull();
    expect(boxTokenFrom('Basic ' + Buffer.from('user-only').toString('base64'))).toBeNull();
    expect(boxTokenFrom('Basic ' + Buffer.from('user:').toString('base64'))).toBeNull();
    expect(boxTokenFrom('Digest abc')).toBeNull();
  });
});

describe('ownerAuthorization', () => {
  it("is git's Basic x-access-token for git and a Bearer token for the API", () => {
    expect(ownerAuthorization('git', 'gho_owner')).toBe(`Basic ${Buffer.from('x-access-token:gho_owner').toString('base64')}`);
    expect(ownerAuthorization('api', 'gho_owner')).toBe('Bearer gho_owner');
    expect(ownerAuthorization('graphql', 'gho_owner')).toBe('Bearer gho_owner');
  });
});

describe('getGithubBrokerUrl', () => {
  it("is GITHUB_BROKER_URL, the gateway's GitHub host, always on 443", () => {
    expect(getGithubBrokerUrl({ GITHUB_BROKER_URL: 'https://b.example/' })).toBe('https://b.example');
    expect(getGithubBrokerUrl({ GITHUB_BROKER_URL: 'https://b.example:443' })).toBe('https://b.example');
  });

  it('is off without it: the orchestrator no longer serves the broker', () => {
    expect(getGithubBrokerUrl({})).toBeNull();
  });

  it('refuses a port gh cannot use, and plain http', () => {
    expect(getGithubBrokerUrl({ GITHUB_BROKER_URL: 'https://b.example:3443' })).toBeNull();
    expect(getGithubBrokerUrl({ GITHUB_BROKER_URL: 'http://plain' })).toBeNull();
  });
});

describe('cachedTokenSource', () => {
  it('caches per user for a minute and forgets on demand', async () => {
    let now = 0;
    let loads = 0;
    const src = cachedTokenSource(async u => { loads += 1; return `t-${u}-${loads}`; }, () => now);
    expect(await src('u')).toBe('t-u-1');
    expect(await src('u')).toBe('t-u-1');
    now = 61_000;
    expect(await src('u')).toBe('t-u-2');
    src.forget('u');
    expect(await src('u')).toBe('t-u-3');
  });
});
