/**
 * Which headers cross the desktop app's box relay.
 * The desktop's local proxy moves the t3
 * client's own Authorization, Origin and forwarding headers into X-T3-*, so
 * the termag credential can ride in Authorization through the ALB; the relay
 * checks that credential and puts the t3 ones back. Nothing termag-, ALB- or
 * cookie-shaped reaches the box, and no cookie comes back.
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';

/** RFC 9110 §7.6.1 hop-by-hop headers, plus the ones only a proxy should see. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** The client's t3 headers, by the name the box's t3 server reads them under. */
const T3_HEADER_MAP: Record<string, string> = {
  'x-t3-authorization': 'authorization',
  'x-t3-origin': 'origin',
  'x-t3-forwarded-host': 'x-forwarded-host',
  'x-t3-forwarded-proto': 'x-forwarded-proto',
};

/**
 * t3's own `x-t3-*` request headers (`x-t3-orchestration-protocol` on every
 * snapshot request) pass through; only the moved ones above, which are put
 * back under their real names, and t3's relay trust headers (`x-t3-relay-*`,
 * which only T3 Connect's relay may set) stop here.
 */
function dropped(name: string): boolean {
  return HOP_BY_HOP.has(name)
    || name === 'host' || name === 'authorization' || name === 'cookie' || name === 'origin'
    || name === 'forwarded' || name === 'x-real-ip'
    || name.startsWith('x-forwarded-') || name.startsWith('x-amzn-')
    || name.startsWith('x-termag-') || name in T3_HEADER_MAP || name.startsWith('x-t3-relay-');
}

/** Header names the Connection header lists, which are hop-by-hop for this request. */
function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const list = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return new Set(list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The request headers to send the box's t3 server. `websocket`: also drops
 * the handshake's own headers, which the relay's client to the box makes anew.
 */
export function requestHeadersToBox(
  incoming: IncomingHttpHeaders,
  t3Port: number | null,
  opts: { websocket?: boolean } = {},
): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (dropped(name) || listed.has(name)) continue;
    if (opts.websocket && name.startsWith('sec-websocket-')) continue;
    out[name] = value;
  }
  for (const [from, to] of Object.entries(T3_HEADER_MAP)) {
    const v = first(incoming[from]);
    if (v !== undefined && v !== '') out[to] = v;
  }
  out.host = t3Port ? `127.0.0.1:${t3Port}` : '127.0.0.1';
  return out;
}

/** The box's response headers to give the desktop: no hop-by-hop headers, no cookies. */
export function responseHeadersFromBox(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name) || name === 'set-cookie') continue;
    out[name] = value;
  }
  return out;
}
