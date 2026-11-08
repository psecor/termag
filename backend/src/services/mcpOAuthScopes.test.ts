import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredOAuth, PreregisteredClient } from './mcpOAuth';
import { GOOGLE_OAUTH } from './apiBroker';
import { authorizeUrl } from './mcpOAuth';
import { connectorScopes, grantedScopesFrom, offlineScope, parseScopeLabels, scopeChoice, scopeLabel, scopesToRequest } from './mcpOAuthScopes';

// What the flag serves while it doesn't exist: null, so the built-in Slack table.
const BUILT_IN = parseScopeLabels(null);

// Scopes from https://mcp.slack.com's protected-resource metadata, cut down.
const SLACK_SCOPES = [
  'search:read.public', 'search:read.private', 'channels:history', 'groups:history', 'im:history', 'channels:read',
  'users:read', 'users:read.email', 'emoji:read', 'chat:write', 'canvases:write', 'reactions:write', 'files:write',
];
const SLACK: DiscoveredOAuth = {
  resource: 'https://mcp.slack.com', scopes: SLACK_SCOPES, issuer: 'https://mcp.slack.com',
  authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize', tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
  registrationEndpoint: null, revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: ['client_secret_post'],
};
// https://mcp.newrelic.com/mcp's protected-resource metadata: one permission,
// and the two scopes its Ory Hydra server takes to issue a refresh token.
const NEW_RELIC: DiscoveredOAuth = {
  resource: 'https://mcp.newrelic.com/mcp/', scopes: ['observability:read', 'offline', 'offline_access'], issuer: 'https://oauth2.service.newrelic.com',
  authorizationEndpoint: 'https://oauth2.service.newrelic.com/oauth2/auth', tokenEndpoint: 'https://oauth2.service.newrelic.com/oauth2/token',
  registrationEndpoint: 'https://dcr.service.newrelic.com/register', revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: ['none'],
};
const PRE: PreregisteredClient = { issuer: SLACK.issuer, resource: SLACK.resource, clientId: '1.2', clientSecret: 's', tokenTypes: ['user'] };

describe('scope labels', () => {
  it("gives Slack's scopes plain labels from the built-in table and shows any other scope by its raw name", () => {
    expect(scopeLabel(BUILT_IN, SLACK.issuer, 'search:read.public')).toBe('Search messages in public channels');
    expect(scopeLabel(BUILT_IN, SLACK.issuer, 'channels:history')).toBe('Read public channel history');
    expect(scopeLabel(BUILT_IN, `${SLACK.issuer}/`, 'chat:write')).toBe('Send messages');
    expect(scopeLabel(BUILT_IN, SLACK.issuer, 'something:new')).toBe('something:new');
    // The labels are keyed by issuer: another server's chat:write is shown as itself.
    expect(scopeLabel(BUILT_IN, 'https://auth.example.test', 'chat:write')).toBe('chat:write');
  });

});

describe('the mcp-oauth-scope-labels flag', () => {
  afterEach(() => vi.restoreAllMocks());
  const LINEAR = 'https://mcp.linear.app';

  it('replaces the built-in table with its labels, keyed by issuer', () => {
    const labels = parseScopeLabels({
      [LINEAR]: [{ scope: 'read', label: 'Read issues and projects' }, { scope: 'write', label: 'Create and edit issues' }],
      [SLACK.issuer]: [{ scope: 'chat:write', label: 'Post as you' }],
    });
    expect(scopeLabel(labels, LINEAR, 'read')).toBe('Read issues and projects');
    expect(scopeLabel(labels, SLACK.issuer, 'chat:write')).toBe('Post as you');
    // A scope the flag leaves out shows its raw name: the built-in labels are not merged in.
    expect(scopeLabel(labels, SLACK.issuer, 'channels:history')).toBe('channels:history');
    expect(scopeChoice({ ...SLACK, issuer: LINEAR, scopes: ['read', 'write'] }, null, labels)?.options).toEqual([
      { name: 'read', label: 'Read issues and projects' },
      { name: 'write', label: 'Create and edit issues' },
    ]);
  });

  it('skips malformed issuers and entries with a warning and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const labels = parseScopeLabels({
      [LINEAR]: [{ scope: 'read', label: 'Read', readOnly: true }, { scope: 'write' }, 'admin', { scope: ' ', label: 'blank' }, { scope: 'x', label: 7 }],
      'https://bad.example': { scope: 'read', label: 'Read' },
    });
    expect([...labels.get(LINEAR)!]).toEqual([['read', 'Read']]);
    expect(labels.has('https://bad.example')).toBe(false);
    const said = warn.mock.calls.flat().join('\n');
    expect(said).toMatch(/mcp-oauth-scope-labels: https:\/\/mcp\.linear\.app: entry 1 needs a string scope and label/);
    expect(said).toMatch(/https:\/\/bad\.example: not a list/);
    // A key other than scope and label (readOnly included) is ignored, with a warning.
    expect(said).toMatch(/entry 0: ignoring readOnly/);
  });

  it('uses the built-in Slack table when the value is null or not an object', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of [null, undefined, [], 'labels', 3]) {
      expect(scopeLabel(parseScopeLabels(raw), SLACK.issuer, 'chat:write'), JSON.stringify(raw)).toBe('Send messages');
    }
  });
});

describe('scopeChoice', () => {
  it('lists every advertised scope with its label', () => {
    const choice = scopeChoice(SLACK, null, BUILT_IN);
    expect(choice?.options.map(o => o.name)).toEqual(SLACK_SCOPES);
    expect(choice?.options.find(o => o.name === 'chat:write')).toEqual({ name: 'chat:write', label: 'Send messages' });
  });

  it('offers no choice for a server with fewer than two scopes, or a pre-registered client that pins them', () => {
    expect(scopeChoice({ ...SLACK, scopes: [] }, null, BUILT_IN)).toBeNull();
    expect(scopeChoice({ ...SLACK, scopes: ['default'] }, null, BUILT_IN)).toBeNull();
    expect(scopeChoice(SLACK, { ...PRE, scopes: ['search:read.public'] }, BUILT_IN)).toBeNull();
    // A pre-registered client without pinned scopes still lets the person choose.
    expect(scopeChoice(SLACK, PRE, BUILT_IN)).not.toBeNull();
  });
});

describe('scopesToRequest', () => {
  it('asks for exactly the ticked scopes, in the order the server lists them, once each', () => {
    expect(scopesToRequest(SLACK, ['chat:write', 'search:read.public', 'chat:write'], null)).toEqual(['search:read.public', 'chat:write']);
  });

  it('asks for every advertised scope when the request names none', () => {
    expect(scopesToRequest(SLACK, undefined, null)).toEqual(SLACK_SCOPES);
    expect(scopesToRequest({ ...SLACK, scopes: [] }, undefined, null)).toEqual([]);
  });

  it('refuses a scope the server does not advertise, an empty choice, or a list that is not strings', () => {
    expect(() => scopesToRequest(SLACK, ['admin'], null)).toThrow(/does not offer the scope "admin"/);
    expect(() => scopesToRequest(SLACK, [], null)).toThrow(/at least one/);
    expect(() => scopesToRequest(SLACK, 'chat:write', null)).toThrow(/list of scope names/);
    expect(() => scopesToRequest(SLACK, [1], null)).toThrow(/list of scope names/);
  });

  it("asks for a pre-registered client's pinned scopes, and refuses a choice for it", () => {
    const pinned = { ...PRE, scopes: ['search:read.public', 'channels:history'] };
    expect(scopesToRequest(SLACK, undefined, pinned)).toEqual(['search:read.public', 'channels:history']);
    expect(() => scopesToRequest(SLACK, ['chat:write'], pinned)).toThrow(/set by this orchestrator/);
  });
});

describe('the offline scope', () => {
  it('prefers offline_access, takes offline only when it is all the server offers, and is null for a server with neither', () => {
    expect(offlineScope(NEW_RELIC)).toBe('offline_access');
    expect(offlineScope({ ...NEW_RELIC, scopes: ['observability:read', 'offline'] })).toBe('offline');
    expect(offlineScope(SLACK)).toBeNull();
    // Google asks for a refresh token with access_type=offline on the authorize URL, not a scope.
    expect(offlineScope(GOOGLE_OAUTH)).toBeNull();
  });

  it('keeps offline and offline_access off the checklist', () => {
    // New Relic has one scope left to choose, so no checklist.
    expect(scopeChoice(NEW_RELIC, null, BUILT_IN)).toBeNull();
    const two = { ...NEW_RELIC, scopes: ['read', 'offline_access', 'write', 'offline'] };
    expect(scopeChoice(two, null, BUILT_IN)?.options.map(o => o.name)).toEqual(['read', 'write']);
  });

  it('adds exactly one offline scope to every sign-in to a server that advertises one', () => {
    expect(scopesToRequest(NEW_RELIC, undefined, null)).toEqual(['observability:read', 'offline_access']);
    expect(scopesToRequest({ ...NEW_RELIC, scopes: ['observability:read', 'offline'] }, undefined, null)).toEqual(['observability:read', 'offline']);
    const two = { ...NEW_RELIC, scopes: ['read', 'offline_access', 'write', 'offline'] };
    expect(scopesToRequest(two, ['write'], null)).toEqual(['write', 'offline_access']);
    // A choice that names an offline scope still asks for the preferred one, once.
    expect(scopesToRequest(two, ['write', 'offline', 'offline_access'], null)).toEqual(['write', 'offline_access']);
    // A pre-registered client's pinned scopes get it too, unless they name one already.
    expect(scopesToRequest(NEW_RELIC, undefined, { ...PRE, scopes: ['observability:read'] })).toEqual(['observability:read', 'offline_access']);
    expect(scopesToRequest(NEW_RELIC, undefined, { ...PRE, scopes: ['observability:read', 'offline'] })).toEqual(['observability:read', 'offline']);
    // A server that advertises neither gets nothing added.
    expect(scopesToRequest(SLACK, ['chat:write'], null)).toEqual(['chat:write']);
  });

  it("puts it on New Relic's authorize URL", () => {
    const client = { clientId: 'nr', redirectUri: 'http://localhost:53682/callback' } as Parameters<typeof authorizeUrl>[1];
    const u = new URL(authorizeUrl(NEW_RELIC, client, { state: 's', challenge: 'c', scopes: scopesToRequest(NEW_RELIC, undefined, null) }));
    expect(u.searchParams.get('scope')).toBe('observability:read offline_access');
  });
});

describe('granted scopes', () => {
  it("reads the token response's scope, space- or comma-separated, and says when it named none", () => {
    expect(grantedScopesFrom('search:read.public channels:history')).toEqual(['search:read.public', 'channels:history']);
    expect(grantedScopesFrom('search:read.public,channels:history')).toEqual(['search:read.public', 'channels:history']);
    expect(grantedScopesFrom(undefined)).toBeNull();
  });

  it('reads what a connector stored, and ignores anything malformed', () => {
    expect(connectorScopes({ requested: ['a', 'b'], granted: ['a'] })).toEqual({ requested: ['a', 'b'], granted: ['a'] });
    expect(connectorScopes({ requested: ['a'], granted: null })).toEqual({ requested: ['a'], granted: null });
    expect(connectorScopes(null)).toBeNull();
    expect(connectorScopes({ requested: 'a' })).toBeNull();
  });
});
