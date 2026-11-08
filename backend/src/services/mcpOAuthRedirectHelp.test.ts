import { describe, expect, it } from 'vitest';
import { authorizeRefusal, issuerHint, preflightAuthorize, RedirectRefusedError, redirectRefusedError } from './mcpOAuthRedirectHelp';
import { registerClient, type DiscoveredOAuth } from './mcpOAuth';

const CALLBACK = 'https://termag.example.test/api/mcp-connectors/oauth/callback';
// New Relic's authorization server (Ory Hydra) answers a redirect its client
// doesn't list with a 302 to its own error page, before login.
const NEW_RELIC_REFUSAL = {
  status: 302,
  headers: {
    location: 'https://oauth2.service.newrelic.com/error?error=invalid_request&error_description=The+request+is+missing+a+required+parameter%2C+includes+an+invalid+parameter+value%2C+includes+a+parameter+more+than+once%2C+or+is+otherwise+malformed.+The+%27redirect_uri%27+parameter+does+not+match+any+of+the+OAuth+2.0+Client%27s+pre-registered+redirect+urls.',
  },
  text: '<a href="…">Found</a>.',
};

describe('authorizeRefusal', () => {
  it('reads a redirect to the server\'s own error page that names the redirect URI (New Relic)', () => {
    expect(authorizeRefusal(NEW_RELIC_REFUSAL, CALLBACK)).toMatch(/The 'redirect_uri' parameter does not match any of the OAuth 2.0 Client's pre-registered redirect urls/);
  });

  it('reads a 4xx whose error names the redirect URI, as JSON or as text', () => {
    expect(authorizeRefusal({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri is not registered' }) }, CALLBACK))
      .toBe('redirect_uri is not registered');
    expect(authorizeRefusal({ status: 400, headers: {}, text: '<html><body>Invalid redirect URI for this client</body></html>' }, CALLBACK))
      .toMatch(/redirect URI/i);
  });

  it('reads a 4xx whose error code is invalid_redirect_uri, whatever its description says', () => {
    expect(authorizeRefusal({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'Not allowed for this client' }) }, CALLBACK))
      .toBe('Not allowed for this client');
    expect(authorizeRefusal({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_redirect_uri' }) }, CALLBACK))
      .toBe('invalid_redirect_uri');
  });

  it('lets through a server that sends the browser on to its login page and checks after login (Datadog, Atlassian)', () => {
    expect(authorizeRefusal({ status: 307, headers: { location: '/account/login?next=%2Foauth2%2Fv1%2Fauthorize%3Fredirect_uri%3Dx' }, text: '' }, CALLBACK)).toBeNull();
    expect(authorizeRefusal({ status: 302, headers: { location: 'https://id.atlassian.com/login?continue=…' }, text: '' }, CALLBACK)).toBeNull();
  });

  it('lets through a login page that mentions redirect_uri in its markup', () => {
    expect(authorizeRefusal({ status: 200, headers: {}, text: '<form><input type=hidden name=redirect_uri value=x></form>' }, CALLBACK)).toBeNull();
  });

  it('lets through an error sent back to the redirect URI itself: the server accepted it', () => {
    const location = `${CALLBACK}?error=invalid_scope&error_description=bad+redirect_uri+scope&state=s`;
    expect(authorizeRefusal({ status: 302, headers: { location }, text: '' }, CALLBACK)).toBeNull();
  });

  it('lets through errors that are about something else', () => {
    expect(authorizeRefusal({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_scope', error_description: 'unknown scope' }) }, CALLBACK)).toBeNull();
    expect(authorizeRefusal({ status: 302, headers: { location: 'https://as.example/error?error=invalid_request&error_description=missing+state' }, text: '' }, CALLBACK)).toBeNull();
  });
});

describe('issuerHint', () => {
  it('knows Datadog, New Relic and Glean by the issuer\'s host, Glean on any tenant', () => {
    expect(issuerHint('https://mcp.datadoghq.com/v1/mcp')).toMatch(/Organization Settings → MCP → MCP OAuth Redirect URLs/);
    expect(issuerHint('https://mcp.us5.datadoghq.com/v1/mcp')).toMatch(/MCP OAuth Redirect URLs/);
    expect(issuerHint('https://oauth2.service.newrelic.com')).toMatch(/no allow-list/);
    expect(issuerHint('https://acme-be.glean.com/oauth')).toMatch(/Third-party access \(OAuth\)/);
  });

  it('has nothing for other servers, or a lookalike host', () => {
    expect(issuerHint('https://auth.example.test')).toBeNull();
    expect(issuerHint('https://notdatadoghq.com/x')).toBeNull();
    expect(issuerHint('not a url')).toBeNull();
  });
});

describe('redirectRefusedError', () => {
  it('is one line with the provider\'s admin step, carrying the refused URL and the provider\'s reason apart', () => {
    const err = redirectRefusedError({ providerMessage: 'not permitted', redirectUri: CALLBACK, issuer: 'https://acme-be.glean.com/oauth' });
    expect(err.message).toBe('The server refused termag\'s redirect URI. A Glean admin adds it under Admin console → Third-party access (OAuth) → Dynamic Client Registration.');
    expect(err.redirectUri).toBe(CALLBACK);
    expect(err.reason).toBe('not permitted');
  });

  it('says an admin allow-lists the URL at a provider it knows nothing about', () => {
    const err = redirectRefusedError({ providerMessage: 'bad redirect_uri', redirectUri: CALLBACK, issuer: 'https://auth.example.test' });
    expect(err.message).toBe('The server refused termag\'s redirect URI. An admin needs to allow-list it at the provider.');
    expect(err.message).not.toContain(CALLBACK);
  });
});

describe('preflightAuthorize', () => {
  const at = (res: { status: number; headers: Record<string, string>; text: string } | Error) =>
    async () => { if (res instanceof Error) throw res; return res; };

  it('throws a RedirectRefusedError with the message when the server refuses the redirect before login', async () => {
    const err = await preflightAuthorize('https://oauth2.service.newrelic.com/oauth2/auth?x', { redirectUri: CALLBACK, issuer: 'https://oauth2.service.newrelic.com' }, at(NEW_RELIC_REFUSAL))
      .catch(e => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(err.status).toBe(400);
    expect(err.redirectUri).toBe(CALLBACK);
    expect(err.message).toMatch(/no allow-list/);
  });

  it('does nothing when the server goes on to login, or cannot be reached', async () => {
    await expect(preflightAuthorize('https://as/authorize', { redirectUri: CALLBACK, issuer: 'https://as' }, at({ status: 302, headers: { location: '/login' }, text: '' }))).resolves.toBeUndefined();
    await expect(preflightAuthorize('https://as/authorize', { redirectUri: CALLBACK, issuer: 'https://as' }, at(new Error('timeout')))).resolves.toBeUndefined();
  });
});

describe('a DCR refusal of the redirect URI (Glean)', () => {
  const GLEAN: DiscoveredOAuth = {
    resource: 'https://acme-be.glean.com/mcp/default', scopes: ['mcp'], issuer: 'https://acme-be.glean.com/oauth',
    authorizationEndpoint: 'https://acme-be.glean.com/oauth/authorize', tokenEndpoint: 'https://acme-be.glean.com/oauth/token',
    registrationEndpoint: 'https://acme-be.glean.com/oauth/register', revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: [],
  };
  const refused = async () => ({
    status: 403, headers: {},
    text: JSON.stringify({ error: 'invalid_redirect_uri', error_description: `redirect_uri ${CALLBACK} is not permitted by administrator policy.` }),
  });

  it('is a RedirectRefusedError carrying the callback and Glean\'s reason, saying Glean\'s admin setting', async () => {
    const err = await registerClient(GLEAN, { http: refused, cimdClientId: null, redirectUri: CALLBACK, preregistered: null }).catch(e => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(err.redirectUri).toBe(CALLBACK);
    expect(err.reason).toMatch(/not permitted by administrator policy/);
    expect(err.message).toMatch(/Dynamic Client Registration/);
  });

  it('leaves other registration failures as they were', async () => {
    const other = async () => ({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_client_metadata', error_description: 'bad grant_types' }) });
    const err = await registerClient(GLEAN, { http: other, cimdClientId: null, redirectUri: CALLBACK, preregistered: null }).catch(e => e);
    expect(err).not.toBeInstanceOf(RedirectRefusedError);
    expect(err.message).toBe('client registration failed: bad grant_types');
  });
});
