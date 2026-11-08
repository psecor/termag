/**
 * The API broker: a box calls a
 * provider's REST API, https://<host><path>, as
 * <MCP broker>/c/<provider>@<host><path> with its own agent token, and the
 * MCP broker's ext_authz check (routes/mcpAuthz.ts) answers here. An allow
 * names the upstream (https://<host>:443) and the owner's token for that
 * provider; the MCP broker's Envoy route, unchanged, swaps the box token for
 * it and forwards. The box never holds a provider token.
 *
 * The token comes from one of the owner's MCP connectors, through the same
 * OAuth store, refresh and revoke as MCP calls (services/mcpOAuth.ts):
 * - a provider with an MCP server whose grant also works on its REST API
 *   (Slack) uses the owner's connector for that server;
 * - a provider with no MCP server (Google) is a connector of kind "api":
 *   created from Settings → MCP servers like a catalog server, with fixed
 *   OAuth metadata here instead of discovery, never delivered to a box as
 *   an MCP server, and refused on its own /c/<id> route.
 *
 * Every request must be on the provider's allowlist (host and path prefix);
 * anything else is refused before a token is read.
 */

import { boxTokenFrom } from './githubBroker';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';
import { relinkMessage } from './mcpConnectors';
import { McpNeedsLinkError, preregisteredClientFor, type DiscoveredOAuth } from './mcpOAuth';

export const API_BROKER_FLAG = 'api-broker-enabled';

/** What the check reads of a connector: the mcp_connectors row. */
export interface ApiConnector {
  id: string;
  userId: string;
  name: string;
  upstream: string;
  authType: string;
  linkStatus?: string | null;
  oauthMetadata?: unknown;
}

/**
 * Google's endpoints, in place of discovery: Google has no MCP server. Its
 * client is a "Web application" client an admin registers, with termag's MCP
 * callback as its redirect URI, listed in MCP_OAUTH_CLIENTS under this issuer
 * and resource. Google takes no RFC 8707 resource, and hands out a refresh
 * token only with access_type=offline (prompt=consent: on every link, not
 * only the first). The scopes are the ones a desktop Google client asks for.
 */
export const GOOGLE_OAUTH: DiscoveredOAuth = {
  api: 'google',
  resource: 'https://www.googleapis.com',
  sendsResource: false,
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  scopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.activity.readonly',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/forms.body',
    'https://www.googleapis.com/auth/forms.responses.readonly',
  ],
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  registrationEndpoint: null,
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  cimdSupported: false,
  tokenAuthMethods: ['client_secret_post', 'client_secret_basic'],
  // Google's metadata says it sends iss on the callback.
  issParameterSupported: true,
};

interface ApiProvider {
  label: string;
  // Host → the path prefixes forwarded there.
  hosts: Record<string, string[]>;
  // Where the grant comes from: a connector of kind "api" with this
  // metadata, or the owner's connector for this MCP server (its OAuth
  // issuer and resource, as discovered).
  grant: { api: DiscoveredOAuth } | { mcp: { issuer: string; resource: string } };
}

/** The allowlist: every host and path prefix the broker forwards, per provider. */
const PROVIDERS: Record<string, ApiProvider> = {
  google: {
    label: 'Google',
    grant: { api: GOOGLE_OAUTH },
    hosts: {
      'www.googleapis.com': ['/drive/v3/', '/upload/drive/v3/', '/calendar/v3/'],
      'gmail.googleapis.com': ['/gmail/v1/users/me/'],
      'sheets.googleapis.com': ['/v4/spreadsheets'],
      'docs.googleapis.com': ['/v1/documents'],
      'slides.googleapis.com': ['/v1/presentations'],
      'forms.googleapis.com': ['/v1/forms'],
      'people.googleapis.com': ['/v1/people'],
      'script.googleapis.com': ['/v1/projects', '/v1/scripts/'],
      'driveactivity.googleapis.com': ['/v2/activity:query'],
      // The exportLinks of an old Doc or Sheet revision (a Docs client's revisions).
      'docs.google.com': ['/feeds/download/'],
    },
  },
  slack: {
    label: 'Slack',
    // The Slack MCP server's sign-in is Slack's own user OAuth for the termag
    // app (oauth.v2.user.access), so its token is an ordinary user token,
    // limited to the scopes the user granted when linking the MCP server.
    grant: { mcp: { issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com' } },
    hosts: {
      'slack.com': ['/api/'],
      // url_private downloads take the same bearer token.
      'files.slack.com': ['/files-pri/'],
    },
  },
};

/** Every provider's hosts and prefixes. */
export function providerHosts(): Record<string, Record<string, string[]>> {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.hosts]));
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const meta = (c: ApiConnector) => (c.oauthMetadata ?? {}) as Partial<DiscoveredOAuth>;

/** The owner's connector holding the provider's grant, a linked one first; null when there is none. */
export function grantConnector(providerId: string, connectors: ApiConnector[]): ApiConnector | null {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const matches = connectors.filter(c => {
    if (c.authType !== 'oauth') return false;
    const m = meta(c);
    if ('api' in p.grant) return m.api === providerId;
    return !m.api && trimSlash(m.issuer ?? '') === p.grant.mcp.issuer && trimSlash(m.resource ?? '') === p.grant.mcp.resource;
  });
  return matches.find(c => c.linkStatus === 'linked') ?? matches[0] ?? null;
}

/**
 * Whether `path` is under one of `prefixes`: equal to one, or continuing it
 * at a `/` or `:` (Google's custom methods) unless the prefix ends in `/`.
 * A segment that is, once decoded, `.` or `..` or holds a slash or backslash
 * is refused whatever the prefix (Envoy normalises paths first; this does not
 * rely on it).
 */
export function pathAllowed(prefixes: string[], path: string): boolean {
  const unsafe = path.split('/').some(seg => {
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return true;
    }
    return s === '.' || s === '..' || /[/\\]/.test(s);
  });
  if (unsafe) return false;
  return prefixes.some(p => path === p || (path.startsWith(p) && (p.endsWith('/') || '/:'.includes(path[p.length]))));
}

/** The API form of a broker path: /c/<provider>@<host>[<path>]. An MCP connector id never has an @. */
export const isApiBrokerPath = (path: string) => /^\/c\/[^/?]*@/.test(path);
const API_PATH = /^\/c\/([a-z][a-z0-9-]{0,39})@([a-z0-9.-]{1,253})(\/[^?#]*)?$/;

export interface ApiBrokerRequest {
  // Without the query.
  path: string;
  authorization: string | undefined;
}

export interface ApiBrokerDeps {
  boxForToken: BoxForToken;
  // api-broker-enabled for the box's owner and the box.
  flagOn: (box: AuthzBox) => Promise<boolean>;
  connectors: (userId: string) => Promise<ApiConnector[]>;
  // The connector's access token, refreshed if it is about to expire; throws
  // McpNeedsLinkError when the user has to link (again).
  accessToken: (connector: ApiConnector) => Promise<string>;
  termagUrl: string | null;
  // Where a host's requests go: https://<host>:443, except in the e2e test's
  // stubs (scripts/e2e/api-broker-envoy.test.sh).
  upstreamOf?: (host: string) => string;
}

function deny(status: number, message: string, audit: string): AuthzDecision {
  return { allow: false, status, message, audit };
}

/**
 * Order: the path's form, the box token and a managed box, the flag, the
 * provider, its allowlist (host, then path), then the owner's grant. Refusals
 * are 403 or 404 with a JSON {message}, never 401. No token and no query
 * reaches an audit line.
 */
export async function decideApiRequest(req: ApiBrokerRequest, deps: ApiBrokerDeps): Promise<AuthzDecision> {
  const m = API_PATH.exec(req.path);
  if (!m) return deny(404, 'Not a path the termag API broker forwards: /c/<provider>@<host>/<path>', 'not an API broker path');
  const [, providerId, host] = m;
  const rest = m[3] ?? '/';
  const token = boxTokenFrom(req.authorization);
  if (!token) return deny(403, "The termag API broker needs this box's agent token (termag-mcp-headers)", 'no box token');
  const box = await deps.boxForToken(token);
  if (!box) return deny(403, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the API broker', `instance=${box.instanceId} not a managed box`);
  const who = `user=${box.userId} instance=${box.instanceId}`;
  if (!await deps.flagOn(box)) {
    return deny(403, 'The termag API broker is not enabled for you (flag api-broker-enabled)', `${who} flag off`);
  }
  const p = PROVIDERS[providerId];
  if (!p) return deny(404, `The termag API broker has no provider "${providerId}"`, `${who} unknown provider ${providerId}`);
  const at = `${who} api=${providerId} ${host}${rest.slice(0, 200)}`;
  const prefixes = p.hosts[host];
  if (!prefixes) return deny(403, `The termag API broker does not forward to ${host} for ${p.label}`, `${at} host not listed`);
  if (!pathAllowed(prefixes, rest)) {
    return deny(403, `The termag API broker does not allow ${host}${rest.slice(0, 200)} for ${p.label}`, `${at} path not listed`);
  }
  const connector = grantConnector(providerId, (await deps.connectors(box.userId)).filter(c => c.userId === box.userId));
  const settings = deps.termagUrl ? `${deps.termagUrl}/settings/mcp` : 'the termag Settings page, MCP section';
  if (!connector) {
    const how = 'api' in p.grant ? `connect ${p.label} under Available to connect` : `link the ${p.label} MCP server`;
    return deny(403, `No ${p.label} sign-in in termag for this box's owner: ${how} at ${settings}`, `${at} no grant`);
  }
  const relink = relinkMessage(connector.name, connector.id, deps.termagUrl);
  let bearer: string;
  try {
    bearer = await deps.accessToken(connector);
  } catch (err) {
    if (err instanceof McpNeedsLinkError) return deny(403, relink, `${at} connector=${connector.id} needs link (${err.message.slice(0, 200)})`);
    return deny(403, `${p.label}: termag could not get a token; try again, or link it again at ${settings}`,
      `${at} connector=${connector.id} token error ${(err as Error).message.slice(0, 200)}`);
  }
  return {
    allow: true,
    audit: `${at} connector=${connector.id} allowed`,
    headers: {
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      'x-termag-mcp-connector': connector.id,
      'x-termag-mcp-relink': relink,
      'x-termag-mcp-upstream': deps.upstreamOf ? deps.upstreamOf(host) : `https://${host}:443`,
      'x-termag-mcp-h-authorization': `Bearer ${bearer}`,
    },
  };
}

export interface ApiCatalogEntry {
  name: string;
  upstream: string;
  kind: 'api';
}

/**
 * The "api" connectors Settings offers under Available to connect: each
 * provider with no MCP server whose client this orchestrator has
 * (MCP_OAUTH_CLIENTS). Its name is the provider id.
 */
export function apiCatalog(env: NodeJS.ProcessEnv = process.env): ApiCatalogEntry[] {
  return Object.entries(PROVIDERS).flatMap(([name, p]) =>
    'api' in p.grant && preregisteredClientFor(p.grant.api, env) ? [{ name, upstream: p.grant.api.resource, kind: 'api' as const }] : []);
}

/** The fixed OAuth metadata of an api catalog entry, or null for any other name. */
export function apiOAuthMetadata(name: string): DiscoveredOAuth | null {
  const p = PROVIDERS[name];
  return p && 'api' in p.grant ? p.grant.api : null;
}

/** Whether a connector is of kind "api": termag wrote its metadata from a provider here. */
export const isApiConnector = (c: { oauthMetadata?: unknown }) => typeof (c.oauthMetadata as { api?: unknown } | null)?.api === 'string';
