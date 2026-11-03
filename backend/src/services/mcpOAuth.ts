/**
 * OAuth for MCP connectors: the orchestrator is
 * the OAuth client and the only holder of the tokens. From the server's URL
 * alone it discovers the authorization server (RFC 9728 protected-resource
 * metadata, then RFC 8414 / OIDC metadata), registers itself (a Client ID
 * Metadata Document when the server supports it and the orchestrator serves
 * one, else RFC 7591 dynamic registration), and runs the code flow with PKCE
 * S256 and the RFC 8707 `resource` parameter. A server that offers neither
 * (Slack) is used with a client an admin registered there, named in
 * MCP_OAUTH_CLIENTS; its secret stays in the orchestrator's environment.
 *
 * Pure apart from the HTTP client it is handed (mcpOAuthHttp.ts), which is
 * the SSRF boundary for every URL a third party names.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpConnectorError } from './mcpConnectors';
import type { OAuthHttp } from './mcpOAuthHttp';

export interface DiscoveredOAuth {
  // RFC 8707 resource indicator: the protected resource's own identifier.
  resource: string;
  scopes: string[];
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  cimdSupported: boolean;
  tokenAuthMethods: string[];
  // RFC 9207: the server puts iss on its authorization response. Absent on
  // connectors discovered before termag read it.
  issParameterSupported?: boolean;
}

/**
 * Why a callback's iss rules the code out (RFC 9207), or null. Runs before
 * the token request: by the time exchangeCode returns, the PKCE verifier has
 * already gone to the connector's token endpoint, so a code another
 * authorization server minted would be usable by whoever runs that endpoint.
 * A missing iss is refused only when the connector's server advertises
 * sending it (RFC 9207 §2.4). That trusts the connector's own metadata, so a
 * malicious connector that claims no iss can still receive a code from an
 * honest server that never sends one (RFC 9207 only protects codes from
 * servers that do); accepted so servers without iss can be linked at all.
 */
export function callbackIssuerProblem(meta: DiscoveredOAuth, iss: unknown): string | null {
  if (iss === undefined) {
    return meta.issParameterSupported ? 'the server did not say who issued the code' : null;
  }
  if (typeof iss !== 'string' || trimSlash(iss) !== trimSlash(meta.issuer)) {
    return 'the code came from a different authorization server than this server uses';
  }
  return null;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  // A 'preregistered' client is stored without its secret, which is read
  // from MCP_OAUTH_CLIENTS for each request.
  via: 'cimd' | 'dcr' | 'preregistered';
  redirectUri: string;
  // The issuer it was registered with: a new one needs a new registration.
  issuer: string;
  // A pre-registered client's pinned resource: its token goes to no upstream
  // outside it.
  resource?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  // ms since the epoch; null when the server gave no lifetime.
  expiresAt: number | null;
  scope?: string;
}

/** What the connector's user_credentials row holds for an oauth connector. */
export interface StoredOAuth {
  client?: OAuthClient;
  tokens?: OAuthTokens;
}

export class OAuthGrantError extends Error {}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function getJson(http: OAuthHttp, url: string): Promise<Record<string, unknown> | null> {
  const res = await http(url);
  if (res.status !== 200) return null;
  const body = json(res.text);
  return isObj(body) ? body : null;
}

/** `resource_metadata` from a 401's WWW-Authenticate, if any. */
export function resourceMetadataFrom(wwwAuthenticate: string | undefined): string | null {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate ?? '') ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate ?? '');
  return m ? m[1] : null;
}

/** RFC 9728 §3.1 and RFC 8414 §3.1: the well-known segment goes between host and path. */
export function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const path = trimSlash(u.pathname);
  const out = [`${u.origin}/.well-known/${name}${path}`];
  if (path) out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = trimSlash(u.pathname);
  const out = [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`];
  if (path) out.push(`${trimSlash(issuer)}/.well-known/openid-configuration`);
  return out;
}

/** The resource identifier must be the upstream or a path prefix of it, same origin. */
export function resourceCovers(resource: string, upstream: string): boolean {
  let r: URL; let u: URL;
  try {
    r = new URL(resource); u = new URL(upstream);
  } catch {
    return false;
  }
  if (r.origin !== u.origin || r.search || r.hash) return false;
  const rp = trimSlash(r.pathname); const up = trimSlash(u.pathname);
  return rp === '' || up === rp || up.startsWith(`${rp}/`);
}

/**
 * Discover how to get a token for `upstream`. `check` is called on every URL
 * the server names before it is fetched or stored (the http client checks
 * again when it connects). Throws McpConnectorError with what went wrong.
 */
export async function discoverOAuth(upstream: string, deps: { http: OAuthHttp; check: (url: string) => void }): Promise<DiscoveredOAuth> {
  const { http, check } = deps;
  const prmUrls: string[] = [];
  // The server's own pointer first (the MCP authorization spec), then the well-known paths.
  try {
    const probe = await http(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
    const pointer = probe.status === 401 ? resourceMetadataFrom(probe.headers['www-authenticate']) : null;
    if (pointer) prmUrls.push(pointer);
  } catch (err) {
    if (!(err instanceof McpConnectorError)) throw err;
    throw new McpConnectorError(`could not reach ${upstream}: ${err.message}`);
  }
  for (const u of wellKnown(upstream, 'oauth-protected-resource')) if (!prmUrls.includes(u)) prmUrls.push(u);

  let prm: Record<string, unknown> | null = null;
  for (const url of prmUrls) {
    check(url);
    prm = await getJson(http, url);
    if (prm) break;
  }
  if (!prm) throw new McpConnectorError(`${upstream} publishes no OAuth protected-resource metadata; add it with static headers instead`);
  const resource = typeof prm.resource === 'string' ? prm.resource : '';
  if (!resourceCovers(resource, upstream)) {
    throw new McpConnectorError(`the server's metadata names resource "${resource.slice(0, 200)}", which is not ${upstream}`);
  }
  const servers = strings(prm.authorization_servers);
  if (servers.length === 0) throw new McpConnectorError('the server\'s metadata names no authorization server');

  const reasons: string[] = [];
  for (const issuer of servers.slice(0, 4)) {
    try {
      check(issuer);
      let meta: Record<string, unknown> | null = null;
      for (const url of asMetadataUrls(issuer)) {
        meta = await getJson(http, url);
        if (meta) break;
      }
      if (!meta) { reasons.push(`${issuer}: no authorization server metadata`); continue; }
      if (typeof meta.issuer !== 'string' || trimSlash(meta.issuer) !== trimSlash(issuer)) {
        reasons.push(`${issuer}: its metadata names a different issuer`);
        continue;
      }
      if (!strings(meta.code_challenge_methods_supported).includes('S256')) {
        reasons.push(`${issuer}: does not support PKCE S256`);
        continue;
      }
      const authz = meta.authorization_endpoint; const token = meta.token_endpoint;
      if (typeof authz !== 'string' || typeof token !== 'string') { reasons.push(`${issuer}: metadata lacks an endpoint`); continue; }
      check(authz); check(token);
      const optional = (v: unknown) => {
        if (typeof v !== 'string') return null;
        check(v);
        return v;
      };
      return {
        resource,
        scopes: strings(prm.scopes_supported),
        issuer: meta.issuer,
        authorizationEndpoint: authz,
        tokenEndpoint: token,
        registrationEndpoint: optional(meta.registration_endpoint),
        revocationEndpoint: optional(meta.revocation_endpoint),
        cimdSupported: meta.client_id_metadata_document_supported === true,
        tokenAuthMethods: strings(meta.token_endpoint_auth_methods_supported),
        issParameterSupported: meta.authorization_response_iss_parameter_supported === true,
      };
    } catch (err) {
      if (!(err instanceof McpConnectorError)) throw err;
      reasons.push(`${issuer}: ${err.message}`);
    }
  }
  throw new McpConnectorError(`no usable authorization server (${reasons.join('; ')})`);
}

/** A client an admin registered at an authorization server (MCP_OAUTH_CLIENTS). */
export interface PreregisteredClient {
  issuer: string;
  // The protected resource the client was registered for. The client is used
  // only for that resource, so a connector naming the same issuer for its own
  // resource cannot borrow it (and have the token sent to its upstream).
  resource: string;
  clientId: string;
  clientSecret: string;
  // token_type values the server answers that termag sends as a bearer token
  // anyway (Slack's user tokens say "user"); "bearer" is always accepted.
  tokenTypes: string[];
}

const warned = new Set<string>();
const warnOnce = (msg: string) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[MCP] MCP_OAUTH_CLIENTS: ${msg}`);
};

/**
 * MCP_OAUTH_CLIENTS: a JSON array of
 * `{ "issuer", "resource", "clientId", "clientSecretEnv", "tokenTypes"? }`. The secret is
 * read from the variable `clientSecretEnv` names, so the list itself holds
 * none. An entry that is malformed or whose secret is unset is skipped with a
 * warning that names the issuer and the variable, never a value.
 */
export function preregisteredClients(env: NodeJS.ProcessEnv = process.env): PreregisteredClient[] {
  const raw = env.MCP_OAUTH_CLIENTS?.trim();
  if (!raw) return [];
  const list = json(raw);
  if (!Array.isArray(list)) {
    warnOnce('not a JSON array; no pre-registered clients');
    return [];
  }
  const out: PreregisteredClient[] = [];
  for (const e of list) {
    const issuer = isObj(e) && typeof e.issuer === 'string' ? e.issuer.trim() : '';
    const resource = isObj(e) && typeof e.resource === 'string' ? e.resource.trim() : '';
    const clientId = isObj(e) && typeof e.clientId === 'string' ? e.clientId.trim() : '';
    const secretEnv = isObj(e) && typeof e.clientSecretEnv === 'string' ? e.clientSecretEnv.trim() : '';
    if (!/^https:\/\//.test(issuer) || !/^https:\/\//.test(resource) || !clientId || !/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
      warnOnce(`skipped an entry without an https issuer and resource, a clientId and a clientSecretEnv variable name (${issuer.slice(0, 100) || 'no issuer'})`);
      continue;
    }
    const clientSecret = env[secretEnv]?.trim();
    if (!clientSecret) {
      warnOnce(`${issuer}: ${secretEnv} is unset, so its client is skipped`);
      continue;
    }
    out.push({ issuer, resource, clientId, clientSecret, tokenTypes: strings((e as Record<string, unknown>).tokenTypes).map(t => t.toLowerCase()) });
  }
  return out;
}

/** The client registered for this issuer and this resource, both. */
export function preregisteredClientFor(d: { issuer: string; resource: string }, env: NodeJS.ProcessEnv = process.env): PreregisteredClient | null {
  return preregisteredClients(env).find(c => trimSlash(c.issuer) === trimSlash(d.issuer) && trimSlash(c.resource) === trimSlash(d.resource)) ?? null;
}

/** How a pre-registered client authenticates, from what the server advertises (RFC 8414: basic when it says nothing). */
export function preregisteredAuthMethod(d: DiscoveredOAuth): 'client_secret_basic' | 'client_secret_post' {
  const m = d.tokenAuthMethods;
  if (m.length === 0 || m.includes('client_secret_basic')) return 'client_secret_basic';
  if (m.includes('client_secret_post')) return 'client_secret_post';
  throw new McpConnectorError(`the authorization server takes neither client_secret_basic nor client_secret_post (${m.join(', ').slice(0, 100)}), which a pre-registered client needs`);
}

/** How termag would register with this server, or why it can't. */
export function registrationPath(
  d: DiscoveredOAuth,
  cimdClientId: string | null,
  pre: PreregisteredClient | null = preregisteredClientFor(d),
): 'preregistered' | 'cimd' | 'dcr' {
  if (pre) {
    preregisteredAuthMethod(d);
    return 'preregistered';
  }
  if (d.cimdSupported && cimdClientId) return 'cimd';
  if (d.registrationEndpoint) return 'dcr';
  throw new McpConnectorError(d.cimdSupported
    ? 'this server only accepts a client ID metadata document, which this orchestrator does not publish (MCP_OAUTH_CIMD), and has no dynamic client registration'
    : `this server supports neither dynamic client registration nor client ID metadata documents, and this orchestrator has no pre-registered client for ${d.issuer.slice(0, 200)} (MCP_OAUTH_CLIENTS)`);
}

/** The Client ID Metadata Document termag serves at its client id URL. */
export function clientMetadataDocument(clientId: string, redirectUri: string) {
  return {
    client_id: clientId,
    client_name: 'termag',
    client_uri: clientId.replace(/\/oauth\/client-metadata\.json$/, '/'),
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export async function registerClient(
  d: DiscoveredOAuth,
  opts: { http: OAuthHttp; cimdClientId: string | null; redirectUri: string; preregistered?: PreregisteredClient | null },
): Promise<OAuthClient> {
  const pre = opts.preregistered === undefined ? preregisteredClientFor(d) : opts.preregistered;
  const path = registrationPath(d, opts.cimdClientId, pre);
  if (path === 'preregistered') {
    return { clientId: pre!.clientId, authMethod: preregisteredAuthMethod(d), via: 'preregistered', redirectUri: opts.redirectUri, issuer: d.issuer, resource: pre!.resource };
  }
  if (path === 'cimd') return { clientId: opts.cimdClientId!, authMethod: 'none', via: 'cimd', redirectUri: opts.redirectUri, issuer: d.issuer };
  const body = {
    client_name: 'termag',
    redirect_uris: [opts.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(d.scopes.length ? { scope: d.scopes.join(' ') } : {}),
  };
  const res = await opts.http(d.registrationEndpoint!, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const reg = json(res.text);
  if (res.status !== 201 && res.status !== 200) {
    const why = isObj(reg) && typeof reg.error_description === 'string' ? reg.error_description : isObj(reg) && typeof reg.error === 'string' ? reg.error : `HTTP ${res.status}`;
    throw new McpConnectorError(`client registration failed: ${why.slice(0, 200)}`);
  }
  if (!isObj(reg) || typeof reg.client_id !== 'string' || !reg.client_id) throw new McpConnectorError('client registration returned no client_id');
  const secret = typeof reg.client_secret === 'string' && reg.client_secret ? reg.client_secret : undefined;
  const method = reg.token_endpoint_auth_method;
  const authMethod = method === 'client_secret_post' || method === 'client_secret_basic' || method === 'none'
    ? method : secret ? 'client_secret_basic' : 'none';
  if (authMethod !== 'none' && !secret) throw new McpConnectorError(`client registration asked for ${authMethod} without a client secret`);
  return { clientId: reg.client_id, ...(secret ? { clientSecret: secret } : {}), authMethod, via: 'dcr', redirectUri: opts.redirectUri, issuer: d.issuer };
}

/**
 * Whether the stored client must be replaced before a sign-in: none yet, a
 * changed redirect URI or issuer, a CIMD id this orchestrator no longer
 * publishes, or a pre-registered client added, changed or removed in
 * MCP_OAUTH_CLIENTS.
 */
export function clientIsStale(
  client: OAuthClient | undefined,
  d: DiscoveredOAuth,
  opts: { redirectUri: string; cimdClientId: string | null; preregistered: PreregisteredClient | null },
): boolean {
  if (!client || client.redirectUri !== opts.redirectUri || client.issuer !== d.issuer) return true;
  if (opts.preregistered) {
    return client.via !== 'preregistered' || client.clientId !== opts.preregistered.clientId || client.resource !== opts.preregistered.resource;
  }
  if (client.via === 'preregistered') return true;
  return client.via === 'cimd' && client.clientId !== opts.cimdClientId;
}

/**
 * Puts the client's authentication on a token or revocation request. A
 * pre-registered client's secret comes from MCP_OAUTH_CLIENTS here, and goes
 * nowhere but that request. Returns the token types the client accepts.
 */
function authenticate(d: DiscoveredOAuth, client: OAuthClient, form: URLSearchParams, headers: Record<string, string>): string[] {
  let secret = client.clientSecret;
  const tokenTypes = ['bearer'];
  if (client.via === 'preregistered') {
    const pre = preregisteredClientFor(d);
    if (!pre || pre.clientId !== client.clientId || client.resource !== pre.resource || trimSlash(client.issuer) !== trimSlash(d.issuer)) {
      throw new McpConnectorError('this orchestrator no longer has the pre-registered client this server was linked with; link it again');
    }
    secret = pre.clientSecret;
    tokenTypes.push(...pre.tokenTypes);
  }
  if (client.authMethod === 'client_secret_basic') {
    const enc = (s: string) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(secret ?? '')}`).toString('base64')}`;
  } else {
    form.set('client_id', client.clientId);
    if (client.authMethod === 'client_secret_post') form.set('client_secret', secret ?? '');
  }
  return tokenTypes;
}

// Error codes that mean the code or refresh token itself is no good: RFC 6749's,
// and the ones Slack's oauth.v2.user.access answers instead.
const GRANT_ERRORS = new Set(['invalid_grant', 'invalid_code', 'code_already_used', 'code_expired', 'invalid_refresh_token', 'token_expired', 'token_revoked']);

const b64url = (b: Buffer) => b.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function newStateNonce(): string {
  return b64url(randomBytes(18));
}

function stateMac(secret: string, nonce: string, userId: string, connectorId: string): string {
  return b64url(createHmac('sha256', secret).update(`mcp-oauth|${nonce}|${userId}|${connectorId}`).digest());
}

/** `state` is the nonce of a stored, single-use row plus a MAC binding it to the user and connector. */
export function signState(secret: string, nonce: string, userId: string, connectorId: string): string {
  return `${nonce}.${stateMac(secret, nonce, userId, connectorId)}`;
}

export function stateNonce(state: unknown): string | null {
  if (typeof state !== 'string') return null;
  const m = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(state);
  return m ? m[1] : null;
}

export function verifyState(secret: string, state: string, userId: string, connectorId: string): boolean {
  const nonce = stateNonce(state);
  if (!nonce) return false;
  const want = Buffer.from(stateMac(secret, nonce, userId, connectorId));
  const got = Buffer.from(state.slice(nonce.length + 1));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function authorizeUrl(d: DiscoveredOAuth, client: OAuthClient, p: { state: string; challenge: string }): string {
  const u = new URL(d.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', client.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state);
  u.searchParams.set('resource', d.resource);
  if (d.scopes.length) u.searchParams.set('scope', d.scopes.join(' '));
  return u.toString();
}

async function tokenRequest(d: DiscoveredOAuth, client: OAuthClient, params: Record<string, string>, http: OAuthHttp, now: number): Promise<OAuthTokens> {
  const form = new URLSearchParams({ ...params, resource: d.resource });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const tokenTypes = authenticate(d, client, form, headers);
  const res = await http(d.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  const body = json(res.text);
  // Slack's Web API answers a refusal with 200 and {"ok": false, "error": …}.
  if (res.status !== 200 || (isObj(body) && body.ok === false)) {
    const code = isObj(body) && typeof body.error === 'string' ? body.error : '';
    const why = isObj(body) && typeof body.error_description === 'string' ? `${code}: ${body.error_description}` : code || `HTTP ${res.status}`;
    if (GRANT_ERRORS.has(code)) throw new OAuthGrantError(why.slice(0, 200));
    throw new McpConnectorError(`the token endpoint refused: ${why.slice(0, 200)}`);
  }
  if (!isObj(body) || typeof body.access_token !== 'string' || !body.access_token) throw new McpConnectorError('the token endpoint returned no access_token');
  // It goes upstream as a header value.
  if (!/^[\x21-\x7e]{1,8192}$/.test(body.access_token)) throw new McpConnectorError('the token endpoint returned an access token termag cannot send as a header');
  if (typeof body.token_type === 'string' && !tokenTypes.includes(body.token_type.toLowerCase())) {
    throw new McpConnectorError(`the token endpoint returned a ${body.token_type.slice(0, 20)} token, not a bearer token`);
  }
  const ttl = typeof body.expires_in === 'number' ? body.expires_in : typeof body.expires_in === 'string' ? Number(body.expires_in) : NaN;
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : null,
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

export function exchangeCode(d: DiscoveredOAuth, client: OAuthClient, p: { code: string; verifier: string }, http: OAuthHttp, now = Date.now()): Promise<OAuthTokens> {
  return tokenRequest(d, client, { grant_type: 'authorization_code', code: p.code, code_verifier: p.verifier, redirect_uri: client.redirectUri }, http, now);
}

export function refreshTokens(d: DiscoveredOAuth, client: OAuthClient, refreshToken: string, http: OAuthHttp, now = Date.now()): Promise<OAuthTokens> {
  return tokenRequest(d, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, http, now);
}

/** RFC 7009, best effort: false when there is no endpoint or it refused. */
export async function revokeToken(d: DiscoveredOAuth, client: OAuthClient, tokens: OAuthTokens, http: OAuthHttp): Promise<boolean> {
  if (!d.revocationEndpoint) return false;
  const [token, hint] = tokens.refreshToken ? [tokens.refreshToken, 'refresh_token'] : [tokens.accessToken, 'access_token'];
  const form = new URLSearchParams({ token, token_type_hint: hint });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  try {
    authenticate(d, client, form, headers);
    return (await http(d.revocationEndpoint, { method: 'POST', headers, body: form.toString() })).status === 200;
  } catch {
    return false;
  }
}

export class McpNeedsLinkError extends Error {}

// Refresh this long before the token runs out, so a request never carries one
// that expires on the way.
export const REFRESH_SKEW_MS = 60_000;

export const isFresh = (t: OAuthTokens, now: number) => t.expiresAt === null || t.expiresAt - now > REFRESH_SKEW_MS;

/** The credential row as seen while holding the connector's lock. */
export interface OAuthLockIo {
  read: () => Promise<StoredOAuth | null>;
  write: (v: StoredOAuth) => Promise<void>;
  remove: () => Promise<void>;
  linked: () => Promise<void>;
  // Mark the connector as needing a new link. null: there were no tokens to
  // begin with, so only a connector still marked linked changes, and an
  // earlier reason stays.
  needsLink: (reason: string | null) => Promise<void>;
}

// Runs `fn` holding the connector's lock (a Postgres advisory lock). Every
// read and write in `fn` goes through `io`, on the lock's own transaction: a
// write on another connection would wait on a second pool connection while
// this one holds the lock, and commit apart from the credential row. Every
// write to an oauth connector's credential row goes through it, so none can
// land in the middle of a refresh.
export type OAuthWithLock = <T>(fn: (io: OAuthLockIo) => Promise<T>) => Promise<T>;

/** Whether `client`'s tokens may go to `upstream`: a pre-registered client's only within its pinned resource. */
export function clientServes(client: OAuthClient, upstream: string | undefined): boolean {
  if (client.via !== 'preregistered') return true;
  return !!client.resource && !!upstream && resourceCovers(client.resource, upstream);
}

export interface FreshTokenDeps {
  read: () => Promise<StoredOAuth | null>;
  // The connector's upstream, where the token is going.
  upstream?: string;
  withLock: OAuthWithLock;
  refresh: (client: OAuthClient, refreshToken: string) => Promise<OAuthTokens>;
  now: () => number;
}

/**
 * The access token to send upstream, refreshed under the connector's lock when
 * it is about to expire. The lock is taken and the row read again, since
 * another process may have rotated it meanwhile; the rotated refresh token is
 * stored before the new access token is used. Any refresh failure drops the
 * tokens and asks for a new link: a refresh token is never sent twice.
 */
export async function freshAccessToken(deps: FreshTokenDeps): Promise<string> {
  const first = await deps.read();
  if (first?.client && !clientServes(first.client, deps.upstream)) {
    throw new McpNeedsLinkError('this server\'s sign-in is registered for another resource; link it again');
  }
  if (first?.client && first.tokens && isFresh(first.tokens, deps.now())) return first.tokens.accessToken;
  const outcome: { failure: string | null } = { failure: null };
  const token = await deps.withLock(async io => {
    const cur = await io.read();
    if (!cur?.client || !cur.tokens) {
      await io.needsLink(null);
      return null;
    }
    if (!clientServes(cur.client, deps.upstream)) throw new McpNeedsLinkError('this server\'s sign-in is registered for another resource; link it again');
    if (isFresh(cur.tokens, deps.now())) return cur.tokens.accessToken;
    const { client, tokens } = cur;
    if (!tokens.refreshToken) {
      outcome.failure = 'the access token expired and the server gave no refresh token';
    } else {
      try {
        const next = await deps.refresh(client, tokens.refreshToken);
        await io.write({ client, tokens: { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken } });
        return next.accessToken;
      } catch (err) {
        outcome.failure = err instanceof OAuthGrantError ? `the server refused the refresh (${err.message})` : `refresh failed: ${(err as Error).message}`;
      }
    }
    await io.write({ client });
    await io.needsLink(outcome.failure);
    return null;
  });
  if (token) return token;
  throw new McpNeedsLinkError(outcome.failure ?? 'not linked');
}

/**
 * Unlink: revoke (best effort) and delete the credential row under the lock,
 * so a refresh in flight either finishes first, and its rotated tokens are the
 * ones revoked, or finds the row gone and writes nothing.
 */
export async function forgetOAuth(deps: {
  withLock: OAuthWithLock;
  revoke: (client: OAuthClient, tokens: OAuthTokens) => Promise<unknown>;
}): Promise<void> {
  await deps.withLock(async io => {
    const cur = await io.read();
    if (cur?.client && cur.tokens) await deps.revoke(cur.client, cur.tokens);
    await io.remove();
  });
}

/**
 * The row after a new registration, given the row now. Tokens are bound to the
 * client they were issued to, so they stay only when the server handed back
 * the same client id for the same issuer (a CIMD client is its own URL).
 */
export function registeredRow(cur: StoredOAuth | null, client: OAuthClient): { row: StoredOAuth; droppedTokens: boolean } {
  const same = !!cur?.client && cur.client.clientId === client.clientId && cur.client.issuer === client.issuer;
  if (same && cur?.tokens) return { row: { client, tokens: cur.tokens }, droppedTokens: false };
  return { row: { client }, droppedTokens: !!cur?.tokens };
}

/**
 * Stores the tokens a callback got, under the lock, only while the row still
 * holds the client they were issued to: false when the connector was unlinked
 * or registered again since the sign-in started.
 */
export async function commitLink(io: OAuthLockIo, client: OAuthClient, tokens: OAuthTokens): Promise<boolean> {
  const cur = await io.read();
  if (!cur?.client || cur.client.clientId !== client.clientId || cur.client.issuer !== client.issuer) return false;
  await io.write({ client: cur.client, tokens });
  return true;
}

/** Where the authorization server sends the browser back. */
export function oauthRedirectUri(termagUrl: string): string {
  return `${termagUrl}/api/mcp-connectors/oauth/callback`;
}

/**
 * termag's client id as a Client ID Metadata Document URL, or null when this
 * orchestrator does not publish one. Off unless MCP_OAUTH_CIMD=on: the
 * authorization server fetches the document itself, so it must be reachable
 * from the internet past the sign-in in front of termag.
 */
export function cimdClientId(termagUrl: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!termagUrl || env.MCP_OAUTH_CIMD?.trim().toLowerCase() !== 'on') return null;
  return `${termagUrl}/oauth/client-metadata.json`;
}
