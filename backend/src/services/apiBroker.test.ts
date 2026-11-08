import { describe, expect, it } from 'vitest';
import type { AuthzBox } from './gatewayAuthz';
import {
  apiCatalog, decideApiRequest, GOOGLE_OAUTH, grantConnector, isApiBrokerPath, pathAllowed, providerHosts, type ApiBrokerDeps, type ApiConnector,
} from './apiBroker';
import { McpNeedsLinkError } from './mcpOAuth';

const BOX: AuthzBox = { userId: 'u1', instanceId: 'i1', managed: true };
const GOOGLE: ApiConnector = {
  id: 'cg', userId: 'u1', name: 'google', upstream: 'https://www.googleapis.com', authType: 'oauth', linkStatus: 'linked',
  oauthMetadata: { ...GOOGLE_OAUTH },
};
const SLACK: ApiConnector = {
  id: 'cs', userId: 'u1', name: 'slack', upstream: 'https://mcp.slack.com', authType: 'oauth', linkStatus: 'linked',
  oauthMetadata: { issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com' },
};
// Claims Slack's issuer for its own resource: not a Slack grant.
const FAKE_SLACK: ApiConnector = { ...SLACK, id: 'cf', name: 'fake', upstream: 'https://evil.example/mcp', oauthMetadata: { issuer: 'https://mcp.slack.com', resource: 'https://evil.example' } };

function deps(over: Partial<ApiBrokerDeps> = {}, connectors: ApiConnector[] = [GOOGLE, SLACK]): ApiBrokerDeps {
  return {
    boxForToken: async t => (t === 'tmag_good' ? BOX : null),
    flagOn: async () => true,
    connectors: async userId => connectors.filter(c => c.userId === userId),
    accessToken: async c => `tok-${c.id}`,
    termagUrl: 'https://termag.example/termag',
    ...over,
  };
}

const AUTH = 'Bearer tmag_good';
const ask = (path: string, d = deps(), authorization: string | null = AUTH) => decideApiRequest({ path, authorization: authorization ?? undefined }, d);

describe('isApiBrokerPath', () => {
  it('is the /c/<provider>@<host> form only', () => {
    expect(isApiBrokerPath('/c/google@www.googleapis.com/drive/v3/files')).toBe(true);
    expect(isApiBrokerPath('/c/slack@slack.com')).toBe(true);
    expect(isApiBrokerPath('/c/ckxyz123/mcp')).toBe(false);
    expect(isApiBrokerPath('/c/ckxyz123/a@b')).toBe(false);
  });
});

describe('pathAllowed', () => {
  it('matches a prefix at a segment or method boundary', () => {
    expect(pathAllowed(['/v1/documents'], '/v1/documents')).toBe(true);
    expect(pathAllowed(['/v1/documents'], '/v1/documents/abc:batchUpdate')).toBe(true);
    expect(pathAllowed(['/v1/people'], '/v1/people:searchContacts')).toBe(true);
    expect(pathAllowed(['/v1/documents'], '/v1/documentsX')).toBe(false);
    expect(pathAllowed(['/api/'], '/api/chat.postMessage')).toBe(true);
    expect(pathAllowed(['/api/'], '/apix')).toBe(false);
  });

  it('refuses dot segments, encoded slashes and backslashes whatever the prefix', () => {
    for (const p of ['/api/../oauth', '/api/./x', '/api/a%2Fb', '/api/a%2fb', '/api/a%5Cb', '/api/a\\b', '/api/%2e%2e/x']) {
      expect(pathAllowed(['/api/'], p)).toBe(false);
    }
  });
});

describe('grantConnector', () => {
  it("finds Google by the api marker termag wrote, and Slack by the MCP server's issuer and resource", () => {
    expect(grantConnector('google', [SLACK, GOOGLE])?.id).toBe('cg');
    expect(grantConnector('slack', [GOOGLE, SLACK])?.id).toBe('cs');
  });

  it("never takes a connector that only names Slack's issuer for another resource", () => {
    expect(grantConnector('slack', [FAKE_SLACK])).toBeNull();
  });

  it('prefers a linked connector', () => {
    const stale = { ...SLACK, id: 'old', linkStatus: 'needs_link' };
    expect(grantConnector('slack', [stale, SLACK])?.id).toBe('cs');
    expect(grantConnector('slack', [stale])?.id).toBe('old');
  });
});

describe('decideApiRequest', () => {
  it("forwards a Google call to its host with the owner's token in place of the box token", async () => {
    expect(await ask('/c/google@www.googleapis.com/drive/v3/files')).toEqual({
      allow: true,
      audit: 'user=u1 instance=i1 api=google www.googleapis.com/drive/v3/files connector=cg allowed',
      headers: {
        'x-termag-user': 'u1',
        'x-termag-instance': 'i1',
        'x-termag-mcp-connector': 'cg',
        'x-termag-mcp-relink': 'MCP server "google" is not linked. Link it at https://termag.example/termag/settings/mcp?server=cg',
        'x-termag-mcp-upstream': 'https://www.googleapis.com:443',
        'x-termag-mcp-h-authorization': 'Bearer tok-cg',
      },
    });
  });

  it("forwards Slack's Web API with the Slack MCP connector's token", async () => {
    const d = await ask('/c/slack@slack.com/api/conversations.history');
    expect(d.allow && d.headers['x-termag-mcp-upstream']).toBe('https://slack.com:443');
    expect(d.allow && d.headers['x-termag-mcp-h-authorization']).toBe('Bearer tok-cs');
  });

  it('sends the upstream the deps name (the e2e stubs), never one from the path', async () => {
    const d = await ask('/c/slack@slack.com/api/auth.test', deps({ upstreamOf: () => 'https://localhost:9443' }));
    expect(d.allow && d.headers['x-termag-mcp-upstream']).toBe('https://localhost:9443');
  });

  it('refuses a host the provider does not list, before any token is read', async () => {
    let read = false;
    const d = await ask('/c/google@evil.example/drive/v3/files', deps({ accessToken: async () => { read = true; return 'x'; } }));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('does not forward to evil.example') });
    expect(read).toBe(false);
    // A Slack host is not a Google one.
    expect(await ask('/c/google@slack.com/api/auth.test')).toMatchObject({ allow: false, status: 403 });
  });

  it('refuses a path outside the allowlist on a listed host', async () => {
    expect(await ask('/c/google@www.googleapis.com/batch/gmail/v1')).toMatchObject({
      allow: false, status: 403, message: expect.stringContaining('does not allow www.googleapis.com/batch/gmail/v1'),
    });
    expect(await ask('/c/slack@slack.com/')).toMatchObject({ allow: false, status: 403 });
  });

  it('answers 404 for a provider it does not know', async () => {
    expect(await ask('/c/jira@example.atlassian.net/rest/api/3/myself')).toMatchObject({ allow: false, status: 404 });
  });

  it('needs a box token, a managed box and the flag, in that order', async () => {
    expect(await ask('/c/slack@slack.com/api/auth.test', deps(), null)).toMatchObject({ allow: false, status: 403, audit: 'no box token' });
    expect(await ask('/c/slack@slack.com/api/auth.test', deps(), 'Bearer tmag_bad')).toMatchObject({ allow: false, status: 403, audit: 'unknown box token' });
    expect(await ask('/c/slack@slack.com/api/auth.test', deps({ boxForToken: async () => ({ ...BOX, managed: false }) })))
      .toMatchObject({ allow: false, status: 403 });
    expect(await ask('/c/slack@slack.com/api/auth.test', deps({ flagOn: async () => false })))
      .toMatchObject({ allow: false, status: 403, message: expect.stringContaining('api-broker-enabled') });
  });

  it('says where to link when the owner has no grant for the provider', async () => {
    const d = await ask('/c/slack@slack.com/api/auth.test', deps({}, [GOOGLE]));
    expect(d).toMatchObject({ allow: false, status: 403, message: expect.stringContaining('https://termag.example/termag/settings/mcp') });
  });

  it("never uses another user's connector", async () => {
    const d = await ask('/c/slack@slack.com/api/auth.test', deps({}, [{ ...SLACK, userId: 'u2' }]));
    expect(d).toMatchObject({ allow: false, status: 403 });
  });

  it('asks for a new link when the grant can no longer be refreshed, and keeps the reason out of the message', async () => {
    const d = await ask('/c/google@www.googleapis.com/drive/v3/about', deps({ accessToken: async () => { throw new McpNeedsLinkError('invalid_grant'); } }));
    expect(d).toMatchObject({ allow: false, status: 403, message: 'MCP server "google" is not linked. Link it at https://termag.example/termag/settings/mcp?server=cg' });
  });

  it('puts no query string in the audit line', async () => {
    const d = await ask('/c/google@www.googleapis.com/drive/v3/files?q=secret');
    expect(d).toMatchObject({ allow: false, status: 404 });
    const ok = await decideApiRequest({ path: '/c/google@www.googleapis.com/drive/v3/files', authorization: AUTH }, deps());
    expect(ok.audit).not.toContain('?');
  });
});

describe('apiCatalog', () => {
  const env = {
    MCP_OAUTH_CLIENTS: JSON.stringify([{ issuer: 'https://accounts.google.com', resource: 'https://www.googleapis.com', clientId: 'gid', clientSecretEnv: 'G_SECRET' }]),
    G_SECRET: 's',
  };

  it("offers Google once the orchestrator has a Google client, and nothing that rides an MCP server's grant", () => {
    expect(apiCatalog(env)).toEqual([{ name: 'google', upstream: 'https://www.googleapis.com', kind: 'api' }]);
    expect(apiCatalog({})).toEqual([]);
  });
});

describe('providerHosts', () => {
  it('lists every host and its prefixes, for the broker contract', () => {
    const hosts = providerHosts();
    expect(hosts.slack['slack.com']).toEqual(['/api/']);
    expect(Object.keys(hosts.google)).toContain('sheets.googleapis.com');
  });
});
