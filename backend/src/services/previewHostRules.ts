/**
 * Pure rules for the preview host ("Host
 * dispatch", "Opening a link" and "The relay"): which host a request is
 * for, the session cookie and its HMAC, the one-time codes and tickets, the
 * `next` path, and every header, path and origin rule the relay applies on
 * the way to the app and back. No prisma, no sockets: services/previewHost.ts
 * and services/previewRelay.ts apply them, and previewHostRules.test.ts pins
 * each one.
 *
 * The cross-site guard and the ALB cookie stripping are ported from #167
 * (`services/appProxy.ts`, by its author), onto the preview domain's
 * same-origin rule (I4).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';
import { normalisePreviewDomain, PREVIEW_HOST_LABEL_RE } from './previewHostGrammar';
import { parseHostLabel } from './previewLinkRules';
import { sessionCookieOptions } from '../auth/sessionCookie';

/** Set by nginx's preview server block only; termag-proxy.conf clears it everywhere else. */
export const PREVIEW_HOST_HEADER = 'x-termag-preview-host';
/** The name nginx captured from the host, checked again here. */
export const PREVIEW_NAME_HEADER = 'x-termag-preview-name';
/** The viewer's session on one preview host. `__Host-`: no sibling can set or overwrite it (SR12). */
export const PREVIEW_COOKIE = '__Host-termag-preview';
/** Where termag's own pages and the code exchange live on a preview host; never relayed. */
export const TERMAG_PREFIX = '/__termag/';

/** A code from the landing page lives 60 s, once (SR10). A reverify ticket too. */
export const CODE_TTL_MS = 60_000;
/** A session lasts at most 8 h, never past its link's expiry (SR12). */
export const SESSION_MAX_MS = 8 * 3600_000;
/** Past this since the last landing check, a navigation goes back through it (A2). */
export const REVERIFY_AFTER_MS = 3600_000;
/** Past this, nothing but a navigation is served: 401 (SR18). */
export const REVERIFY_HARD_MS = 2 * 3600_000;
/** U1: the largest request body the relay carries. nginx's client_max_body_size says the same. */
export const PREVIEW_BODY_LIMIT = 100 * 1024 * 1024;
const NEXT_MAX = 2048;

// ── Host dispatch ─────────────────────────────────────────────────────────

export type HostVerdict =
  /** termag's own host: carry on with termag's middleware. */
  | { kind: 'main' }
  /**
   * A preview host, for this name. `suffix` is the host's link suffix (`<name>--<suffix>`, SR19), null on
   * the bare name: only a suffix that is the live link's own is served, anything else goes to the landing page.
   */
  | { kind: 'preview'; name: string; suffix: string | null }
  /** Looks like a preview host but isn't one nginx vouched for, or doesn't add up: a bare 404, never termag. */
  | { kind: 'refuse'; reason: 'no_marker' | 'no_domain' | 'bad_name' | 'host_mismatch' };

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/** The Host header's name, lowercased, without a port or a trailing dot. */
export function hostName(raw: string): string {
  const h = raw.trim().toLowerCase();
  const bare = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d*$/, '');
  return bare.replace(/\.$/, '');
}

/**
 * Which world a request belongs to (SR3). The marker decides; `Host` is
 * checked as well, so a request that reaches the backend without nginx (or
 * with nginx misconfigured) is never served as termag for a preview host,
 * nor as a preview for anything but `<name>.<domain>` exactly.
 */
export function classifyHost(headers: IncomingHttpHeaders, domain: string | null): HostVerdict {
  const marker = first(headers[PREVIEW_HOST_HEADER]);
  const host = hostName(first(headers.host));
  const d = normalisePreviewDomain(domain);
  const inDomain = d !== null && (host === d || host.endsWith(`.${d}`));
  if (!marker) return inDomain ? { kind: 'refuse', reason: 'no_marker' } : { kind: 'main' };
  // nginx says preview host: never termag, whatever else is wrong.
  if (!d) return { kind: 'refuse', reason: 'no_domain' };
  // nginx sends the whole host label, `<name>` or `<name>--<suffix>`.
  const label = first(headers[PREVIEW_NAME_HEADER]).trim();
  const parsed = PREVIEW_HOST_LABEL_RE.test(label) ? parseHostLabel(label) : null;
  if (!parsed) return { kind: 'refuse', reason: 'bad_name' };
  if (host !== `${label}.${d}`) return { kind: 'refuse', reason: 'host_mismatch' };
  return { kind: 'preview', ...parsed };
}

/** `https://<label>.<domain>`: the link's own origin, the only one its mutations and sockets may come from. */
export function previewOrigin(label: string, domain: string): string {
  return `https://${label}.${domain}`;
}

// ── Secrets: codes, tickets and the session cookie ────────────────────────

/** 256 random bits, base64url (43 characters): a code, a ticket or a session id. */
export function newSecret(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url');
}

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export type CodeKind = 'code' | 'ticket';

/**
 * How a code or ticket is stored (PreviewLinkCode.codeHash). Each kind hashes
 * under its own prefix, so a reverify ticket the preview host minted can only
 * be redeemed at the main host's reverify route, which goes back through Okta,
 * and never at `/__termag/auth` as if it were a code.
 */
export function codeHash(kind: CodeKind, raw: string): string | null {
  if (!SECRET_RE.test(raw)) return null;
  return createHash('sha256').update(`termag-preview-${kind}:${raw}`).digest('hex');
}

/** PreviewLinkSession.idHash. */
export function sessionIdHash(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

function cookieMac(secret: Buffer, name: string, id: string): string {
  return createHmac('sha256', secret).update(`termag-preview-session:v1:${name}:${id}`).digest('base64url');
}

/** The cookie value for a session on `name`: `<id>.<hmac>`, the HMAC binding it to this host. */
export function signSessionCookie(secret: Buffer, name: string, id: string): string {
  return `${id}.${cookieMac(secret, name, id)}`;
}

/** The session id in a cookie value, when its HMAC is this host's; null otherwise. Constant time. */
export function verifySessionCookie(secret: Buffer, name: string, value: string): string | null {
  const dot = value.indexOf('.');
  if (dot !== 43) return null;
  const id = value.slice(0, dot);
  if (!SECRET_RE.test(id)) return null;
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(cookieMac(secret, name, id));
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

/** PREVIEW_LINKS_COOKIE_SECRET as a key: base64 of at least 32 bytes, else null (preview hosts stay off). */
export function cookieSecretFrom(raw: string | undefined): Buffer | null {
  const s = raw?.trim();
  if (!s) return null;
  const key = Buffer.from(s, 'base64');
  return key.length >= 32 ? key : null;
}

/** The session cookie's value in a Cookie header, the first of that name. */
export function sessionCookieValue(cookieHeader: string | undefined): string | null {
  return cookieValue(cookieHeader, PREVIEW_COOKIE);
}

/** A cookie's value in a Cookie header, the first of that name. */
function cookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === cookieName) return pair.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Which link this browser was last cleared for, on this origin (SR19): `<linkId>.<hmac>`, HttpOnly so an
 * earlier app's Service Worker or script can neither read nor forge it for a new link. A session made in
 * a browser without it, or with one naming another link, gets Clear-Site-Data. Per browser, not per user:
 * a code an old worker took and redeemed elsewhere marks that other browser, never this one.
 */
export const PREVIEW_LINK_MARKER = '__Host-termag-preview-link';
/**
 * 400 days, the most browsers keep (tech spec, "A reused name"): far past any link's 30-day cap, so a
 * viewer back after their 8 h session ended keeps the same app's storage.
 */
const MARKER_MAX_AGE_SEC = 400 * 24 * 3600;

function markerMac(secret: Buffer, name: string, linkId: string): string {
  return createHmac('sha256', secret).update(`termag-preview-link-marker:v1:${name}:${linkId}`).digest('base64url');
}

/** The marker's Set-Cookie for `linkId` on `name`. */
export function linkMarkerSetCookie(secret: Buffer, name: string, linkId: string): string {
  return `${PREVIEW_LINK_MARKER}=${linkId}.${markerMac(secret, name, linkId)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${MARKER_MAX_AGE_SEC}`;
}

/** Whether the browser's marker says it was cleared for this very link already. Constant time on the MAC. */
export function markerNamesLink(secret: Buffer, name: string, cookieHeader: string | undefined, linkId: string): boolean {
  const value = cookieValue(cookieHeader, PREVIEW_LINK_MARKER);
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 0 || value.slice(0, dot) !== linkId) return false;
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(markerMac(secret, name, linkId));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The Set-Cookie for a new session: host-only, Secure, HttpOnly, Lax, until the session ends. */
export function sessionSetCookie(value: string, maxAgeSec: number): string {
  return `${PREVIEW_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

/** A session's expiry: 8 h from its start, never past its link's. */
export function sessionExpiry(now: Date, linkExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + SESSION_MAX_MS, linkExpiresAt.getTime()));
}

export type ReverifyState = 'fresh' | 'due' | 'overdue';

/** Where a session stands against its last landing check (A2, SR18). */
export function reverifyState(verifiedAt: Date, now: Date): ReverifyState {
  const age = now.getTime() - verifiedAt.getTime();
  if (age < REVERIFY_AFTER_MS) return 'fresh';
  return age < REVERIFY_HARD_MS ? 'due' : 'overdue';
}

/** A top-level navigation, the only request a reverify may redirect: a cross-origin 302 would turn a POST into a GET. */
export function isNavigation(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return (m === 'GET' || m === 'HEAD') && first(headers['sec-fetch-mode']).toLowerCase() === 'navigate';
}

// ── The `next` path (SR16) ────────────────────────────────────────────────

/**
 * The app path to land on: origin-form only (a `/`, but not `//` or `/\`),
 * no control characters, at most 2 KiB, and never termag's own pages there;
 * anything else is `/`.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > NEXT_MAX) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  if (raw.toLowerCase().startsWith(TERMAG_PREFIX)) return '/';
  return raw;
}

// ── The request (SR3, SR7, SR8, SR9, I1, I4) ──────────────────────────────

/** A request target the relay never sends on: absolute-form, authority-form or `*` (SR8). */
export function targetRefusal(url: string | undefined): 'not_origin_form' | null {
  return typeof url === 'string' && url.startsWith('/') ? null : 'not_origin_form';
}

/** The path, without its query or fragment. */
export function pathOf(url: string): string {
  const q = url.search(/[?#]/);
  return q < 0 ? url : url.slice(0, q);
}

/** The query, `?…`, or ''. Logs never carry it (SR21). */
export function searchOf(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? '' : url.slice(q).replace(/#.*$/, '');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The cross-site guard (I4, from #167): a request that may change something
 * must come from the preview's own origin. `Sec-Fetch-Site` decides when the
 * browser sends it (`same-origin` or `none`, a typed URL; `same-site`, a
 * sibling preview, is refused, SR13); without it, `Origin` must be absent or
 * exactly the preview's. Any other value fails closed.
 */
export function crossSiteRefusal(method: string | undefined, headers: IncomingHttpHeaders, origin: string): boolean {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return false;
  const site = first(headers['sec-fetch-site']).trim().toLowerCase();
  if (site) return site !== 'same-origin' && site !== 'none';
  const sent = first(headers.origin);
  return sent !== '' && sent !== origin;
}

/**
 * Same-site siblings (security-review.md SR13). Every preview host is
 * same-site to every other until the preview domain is on the Public Suffix
 * List and browsers ship it, so the viewer's preview cookie (`SameSite=Lax`)
 * rides along on a sibling's fetches, iframes and preflights. Refused, for
 * every method, unless it is a top-level navigation (`Sec-Fetch-Mode:
 * navigate` and `Sec-Fetch-Dest: document`), which is the viewer following a
 * link. A request without fetch metadata is judged by the rules that follow,
 * as before: safe methods are served, a mutation needs no `Origin` or the
 * preview's own (crossSiteRefusal).
 */
export function sameSiteRefusal(headers: IncomingHttpHeaders): boolean {
  if (first(headers['sec-fetch-site']).trim().toLowerCase() !== 'same-site') return false;
  const mode = first(headers['sec-fetch-mode']).trim().toLowerCase();
  const dest = first(headers['sec-fetch-dest']).trim().toLowerCase();
  return !(mode === 'navigate' && dest === 'document');
}

/** SR7: framing only Node's strict parser would accept, and never both lengths. */
export function framingRefusal(headers: IncomingHttpHeaders): boolean {
  const te = first(headers['transfer-encoding']).trim().toLowerCase();
  if (te && headers['content-length'] !== undefined) return true;
  return te !== '' && te !== 'chunked';
}

/** RFC 9110 §7.6.1 hop-by-hop headers, the proxy-only ones, and Expect (this process answers 100-continue itself). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
]);

function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const list = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return new Set(list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** Never to the app: termag's, the edge's and every forwarding header but the three the relay sets itself. */
function droppedToApp(name: string): boolean {
  return HOP_BY_HOP.has(name)
    || name === 'host' || name === 'forwarded' || name === 'x-real-ip'
    || name.startsWith('x-forwarded-') || name.startsWith('x-amzn-') || name.startsWith('x-termag-');
}

/**
 * A Cookie header without termag's session pair (I1, SR12) and, as #167 did,
 * without the ALB's authenticate-oidc session cookies (`AWSELBAuthSessionCookie-N`,
 * a bearer for the viewer's Okta session at the edge). The preview domain's
 * ALB rule has no Okta action, so none should come; if one did, the app
 * must not see it. Every other cookie is the app's own and passes.
 */
/**
 * Cookie names an app never gets: termag's preview session, and termag's own
 * session under both its names, production's `__Host-termag.sid` and the
 * plain-http `termag.sid` (auth/sessionCookie.ts). The preview domain is a
 * site of its own, so neither should ever arrive; if a misconfigured domain
 * let one through, it still stops here.
 */
const NEVER_TO_APP = new Set([PREVIEW_COOKIE, PREVIEW_LINK_MARKER, sessionCookieOptions(true).name, sessionCookieOptions(false).name].map(n => n.toLowerCase()));

export function cookiesForApp(cookie: string | undefined): string | null {
  const kept = (cookie ?? '').split(';').map(p => p.trim()).filter(p => {
    if (!p) return false;
    const eq = p.indexOf('=');
    const name = (eq < 0 ? p : p.slice(0, eq)).trim();
    return !NEVER_TO_APP.has(name.toLowerCase()) && !/^AWSELBAuthSessionCookie/i.test(name);
  });
  return kept.length ? kept.join('; ') : null;
}

export interface RelayTarget {
  /** The host label, `<name>--<suffix>`: the app's public Host and its redirects' origin. */
  name: string;
  domain: string;
  port: number;
  hostMode: 'localhost' | 'public';
  /** The viewer's address, for X-Forwarded-For. */
  viewerIp: string | null;
}

/**
 * The headers the app gets. `websocket`: also drops the handshake's own
 * `sec-websocket-*`, which the relay's client to the app makes anew.
 */
export function previewRequestHeaders(incoming: IncomingHttpHeaders, target: RelayTarget, opts: { websocket?: boolean } = {}): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [raw, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = raw.toLowerCase();
    if (droppedToApp(name) || listed.has(name)) continue;
    if (opts.websocket && name.startsWith('sec-websocket-')) continue;
    if (name === 'cookie') {
      const kept = cookiesForApp(Array.isArray(value) ? value.join('; ') : value);
      if (kept) out.cookie = kept;
      continue;
    }
    out[name] = value;
  }
  const publicHost = `${target.name}.${target.domain}`;
  out.host = target.hostMode === 'public' ? publicHost : `localhost:${target.port}`;
  out['x-forwarded-host'] = publicHost;
  out['x-forwarded-proto'] = 'https';
  if (target.viewerIp) out['x-forwarded-for'] = target.viewerIp;
  return out;
}

// ── The response (I5, I7, SR12, SR16) ─────────────────────────────────────

/**
 * One Set-Cookie as the browser may get it: without a `Domain` attribute
 * (I7), so an app's server can't set a cookie for its sibling previews; null
 * for one named after termag's session cookie, which the app can't overwrite.
 */
export function setCookieForBrowser(line: string): string | null {
  const parts = line.split(';');
  const pair = parts[0] ?? '';
  const eq = pair.indexOf('=');
  const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
  if (!name || name.toLowerCase() === PREVIEW_COOKIE.toLowerCase() || name.toLowerCase() === PREVIEW_LINK_MARKER.toLowerCase()) return null;
  const attrs = parts.slice(1).filter(a => a.split('=')[0].trim().toLowerCase() !== 'domain');
  return [pair.trim(), ...attrs.map(a => a.trim()).filter(Boolean)].join('; ');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A `Location` to the app's own loopback address on the link's port becomes
 * the preview host, path kept (hostMode `localhost`). Any other passes
 * untouched: a relative one stays on the preview host anyway, and a
 * redirect elsewhere is the app's own (SR16).
 */
export function rewriteLocation(location: string, target: Pick<RelayTarget, 'name' | 'domain' | 'port' | 'hostMode'>): string {
  if (target.hostMode !== 'localhost') return location;
  let u: URL;
  try { u = new URL(location); } catch { return location; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return location;
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return location;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== target.port) return location;
  return `${previewOrigin(target.name, target.domain)}${u.pathname}${u.search}${u.hash}`;
}

/** The app's response headers, as the browser gets them. */
export function previewResponseHeaders(incoming: IncomingHttpHeaders, target: Pick<RelayTarget, 'name' | 'domain' | 'port' | 'hostMode'>): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [raw, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = raw.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name)) continue;
    // An app may clear its own storage, never termag's preview cookie (SR12).
    if (name === 'clear-site-data') continue;
    if (name === 'set-cookie') {
      const lines = (Array.isArray(value) ? value : [value]).map(setCookieForBrowser).filter((l): l is string => l !== null);
      if (lines.length) out['set-cookie'] = lines;
      continue;
    }
    if (name === 'location') {
      out.location = rewriteLocation(String(value), target);
      continue;
    }
    out[name] = value;
  }
  // I5: a preview is never indexed, and never leaks its URL onward, unless the app says otherwise.
  if (out['x-robots-tag'] === undefined) out['x-robots-tag'] = 'noindex';
  if (out['referrer-policy'] === undefined) out['referrer-policy'] = 'no-referrer';
  return out;
}

/**
 * The viewer's address: the one the ALB saw. The ALB appends the client to
 * X-Forwarded-For and nginx appends the ALB, so it is the second from the
 * right; with one entry (nginx reached from inside the VPC) the only one; the
 * socket's without nginx. What a client wrote further left is never read.
 */
export function viewerIp(headers: IncomingHttpHeaders, socketAddress: string | undefined): string | null {
  const xff = first(headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length >= 2) return xff[xff.length - 2];
  return xff[0] ?? socketAddress ?? null;
}
