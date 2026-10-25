/**
 * MCP connectors: a user's MCP servers, reached from
 * their boxes through the MCP broker at <MCP_BROKER_URL>/c/<connector id>.
 *
 * The row holds the upstream and, for `static`, header templates that name
 * secrets as {{secret.<name>}}; the secret values are a user_credentials row
 * (provider `mcp-<id>`), so the connector row carries nothing secret. This
 * module is pure apart from the DNS lookup `validateUpstream` is handed.
 */

import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export const MCP_BROKER_FLAG = 'mcp-broker-enabled';

export const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,40}$/;
export const SECRET_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HEADERS = 16;
const MAX_SECRETS = 16;
const MAX_TEMPLATE = 4096;
const MAX_SECRET = 8192;
const MAX_UPSTREAM = 2048;
// Envoy refuses a request whose headers pass 60 KiB in all; the box's own
// headers and the x-termag-* ones share that budget.
const MAX_RENDERED_HEADER = 8192;
const MAX_RENDERED_HEADERS = 32768;
const PLACEHOLDER = /\{\{\s*secret\.([A-Za-z0-9_-]{1,40})\s*\}\}/g;

// Headers a connector may not set: the broker's own, hop-by-hop ones, and
// those that would change how Envoy frames or routes the request.
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
  'expect', 'via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-request-id', 'x-envoy-original-path', 'mcp-session-id', 'mcp-protocol-version',
]);

/**
 * The broker's base URL (MCP_BROKER_URL), or null when there is none or it is
 * not https://<host>[:port]: connectors live at /c/<id> at the broker's root,
 * and boxes refuse a broker with a path, user info or brackets.
 */
export function getMcpBrokerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MCP_BROKER_URL?.trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || raw.includes('?') || raw.includes('#')) return null;
  const url = `https://${u.host}`;
  return /^https:\/\/[A-Za-z0-9.:-]+$/.test(url) ? url : null;
}

export class McpConnectorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type McpAuthType = 'static' | 'oauth';

/** The credential row's provider for a connector's secrets. */
export function mcpCredentialProvider(connectorId: string): string {
  return `mcp-${connectorId}`;
}

export function validateConnectorName(name: unknown): string {
  if (typeof name !== 'string' || !CONNECTOR_NAME.test(name)) {
    throw new McpConnectorError('name must start with a letter and use only lowercase letters, digits and dashes (at most 41)');
  }
  return name;
}

// Private, loopback, link-local (the instance metadata address among them),
// CGNAT, benchmark, documentation, 6to4 relay anycast, AS112, multicast and
// reserved ranges; ULA, IPv4-compatible, NAT64, Teredo, 6to4 and the other v6
// equivalents. The VPC's own CIDRs are RFC 1918 and so already in here.
const DENIED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) DENIED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001::', 32], ['2001:db8::', 32],
  ['2001:4:112::', 48], ['2620:4f:8000::', 48], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2002::', 16],
] as const) DENIED.addSubnet(net, prefix, 'ipv6');

// Canonical lowercase compressed form, so ::ffff:10.0.0.1, ::ffff:a00:1 and
// 0:0:0:0:0:ffff:0a00:0001 all read the same.
function canonicalV6(address: string): string {
  return new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !DENIED.check(address, 'ipv4');
  if (family !== 6) return false;
  const v6 = canonicalV6(address);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !DENIED.check(v6, 'ipv6');
}

export type Resolve = (host: string) => Promise<string[]>;

export const resolveHost: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map(a => a.address);

/**
 * Exact `host:port` pairs the e2e stack allows past the address and port
 * checks (its fake upstream listens on loopback). Never set in production.
 */
export function upstreamTestAllow(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.MCP_UPSTREAM_TEST_ALLOW ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export interface UpstreamTarget {
  // Normalised URL, as stored: https://host[:port]/path, no userinfo, query or fragment.
  url: string;
  // What the broker's ext_authz allow names: always with the port.
  envoyTarget: string;
}

/** Parse and normalise without DNS; throws McpConnectorError. */
export function parseUpstream(raw: unknown, allow: Set<string> = new Set()): UpstreamTarget {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_UPSTREAM) throw new McpConnectorError('upstream must be an https URL');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new McpConnectorError('upstream must be an https URL');
  }
  if (u.protocol !== 'https:') throw new McpConnectorError('upstream must be an https URL');
  if (u.username || u.password) throw new McpConnectorError('upstream must not carry a user name or password; put credentials in a header');
  if (u.search) throw new McpConnectorError('upstream must not carry a query string; put credentials in a header');
  const host = u.hostname.toLowerCase();
  const port = u.port || '443';
  const allowed = allow.has(`${host}:${port}`);
  if (!allowed) {
    if (isIP(host.replace(/^\[|\]$/g, ''))) throw new McpConnectorError('upstream must be a host name, not an IP address');
    if (port !== '443') throw new McpConnectorError('upstream must use the default https port (443)');
    if (!host.includes('.')) throw new McpConnectorError('upstream must be a fully qualified host name');
  }
  // URL resolves dot-segments, encoded ones too; an encoded slash or
  // backslash stays encoded, and Envoy only normalises the box's half of the
  // path, so they are refused.
  const path = u.pathname === '/' ? '' : u.pathname;
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c/i.test(path)) throw new McpConnectorError('upstream path must not contain dot-segments or encoded slashes');
  const authority = u.port ? `${host}:${u.port}` : host;
  return { url: `https://${authority}${path}`, envoyTarget: `https://${host}:${port}${path}` };
}

/**
 * The registration-time SSRF check: https, a host name, and every address it
 * resolves to public. Envoy checks the address it actually connects to again
 * on every request, so this is the early, friendly refusal, not the only one.
 */
export async function validateUpstream(raw: unknown, deps: { resolve?: Resolve; allow?: Set<string> } = {}): Promise<UpstreamTarget> {
  const allow = deps.allow ?? upstreamTestAllow();
  const target = parseUpstream(raw, allow);
  const { hostname, port } = new URL(target.envoyTarget);
  if (allow.has(`${hostname}:${port}`)) return target;
  let addresses: string[];
  try {
    addresses = await (deps.resolve ?? resolveHost)(hostname);
  } catch {
    throw new McpConnectorError(`upstream host ${hostname} does not resolve`);
  }
  if (addresses.length === 0) throw new McpConnectorError(`upstream host ${hostname} does not resolve`);
  if (!addresses.every(isPublicAddress)) throw new McpConnectorError(`upstream host ${hostname} resolves to a private or reserved address`);
  return target;
}

export type HeaderTemplates = Record<string, string>;

/** Check a static connector's header templates; returns them with lowercase names. */
export function validateHeaderTemplates(raw: unknown): HeaderTemplates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpConnectorError('headers must be an object of header name to template');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new McpConnectorError('a static connector needs at least one header');
  if (entries.length > MAX_HEADERS) throw new McpConnectorError(`at most ${MAX_HEADERS} headers`);
  const out: HeaderTemplates = {};
  for (const [rawName, template] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) throw new McpConnectorError(`"${rawName}" is not a valid header name`);
    if (RESERVED_HEADERS.has(name) || name.startsWith('x-termag-') || name.startsWith('x-envoy-')) {
      throw new McpConnectorError(`header "${name}" cannot be set by a connector`);
    }
    if (name in out) throw new McpConnectorError(`header "${name}" is given twice`);
    if (typeof template !== 'string' || template.length > MAX_TEMPLATE) throw new McpConnectorError(`header "${name}" must be a string`);
    if (/[\r\n\0]/.test(template)) throw new McpConnectorError(`header "${name}" must be one line`);
    if (template.replace(PLACEHOLDER, '').includes('{{')) {
      throw new McpConnectorError(`header "${name}": the only placeholder is {{secret.<name>}}`);
    }
    out[name] = template;
  }
  return out;
}

/** The secret names a set of templates refers to. */
export function referencedSecrets(templates: HeaderTemplates): string[] {
  const names = new Set<string>();
  for (const t of Object.values(templates)) for (const m of t.matchAll(PLACEHOLDER)) names.add(m[1]);
  return [...names].sort();
}

export type Secrets = Record<string, string>;

/** Check a write of secret values; an empty string or null deletes that secret. */
export function validateSecretsPatch(raw: unknown): Record<string, string | null> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpConnectorError('secrets must be an object of secret name to value');
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SECRET_NAME.test(name)) throw new McpConnectorError(`"${name}" is not a valid secret name`);
    if (value === null || value === '') { out[name] = null; continue; }
    if (typeof value !== 'string' || value.length > MAX_SECRET) throw new McpConnectorError(`secret "${name}" must be a string`);
    if (/[\r\n\0]/.test(value)) throw new McpConnectorError(`secret "${name}" must be one line`);
    out[name] = value;
  }
  return out;
}

/** A PATCH body may only set headers or secrets on a static connector; an oauth one refuses them instead of ignoring them. */
export function assertPatchFitsAuth(authType: string, body: { secrets?: unknown; auth?: unknown } | undefined): void {
  if (authType === 'static') return;
  if (body?.secrets !== undefined || (body?.auth as { headers?: unknown } | undefined)?.headers !== undefined) {
    throw new McpConnectorError('an OAuth connector has no headers or secrets to set');
  }
}

export function applySecretsPatch(current: Secrets, patch: Record<string, string | null>): Secrets {
  const next: Secrets = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  if (Object.keys(next).length > MAX_SECRETS) throw new McpConnectorError(`at most ${MAX_SECRETS} secrets`);
  return next;
}

/**
 * Throws when a template names a secret that is not set (never an empty
 * value), or when the filled-in headers are longer than Envoy takes.
 */
export function renderHeaders(templates: HeaderTemplates, secrets: Secrets): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const [name, template] of Object.entries(templates)) {
    out[name] = template.replace(PLACEHOLDER, (_, secret: string) => {
      const value = secrets[secret];
      if (typeof value !== 'string' || value === '') throw new McpConnectorError(`secret "${secret}" is not set`);
      return value;
    });
    if (out[name].length > MAX_RENDERED_HEADER) {
      throw new McpConnectorError(`header "${name}" is longer than ${MAX_RENDERED_HEADER} characters once its secrets are filled in`);
    }
    total += name.length + out[name].length;
  }
  if (total > MAX_RENDERED_HEADERS) throw new McpConnectorError(`the headers are longer than ${MAX_RENDERED_HEADERS} characters in all once their secrets are filled in`);
  return out;
}

/** Secrets as stored: a JSON object of string values, anything else is empty. */
export function asSecrets(stored: unknown): Secrets {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Secrets;
}

export function relinkMessage(name: string, connectorId: string, termagUrl: string | null): string {
  const where = termagUrl ? `${termagUrl}/settings/mcp?server=${encodeURIComponent(connectorId)}` : 'the termag Settings page, MCP section';
  return `MCP server "${name}" is not linked. Link it at ${where}`;
}
