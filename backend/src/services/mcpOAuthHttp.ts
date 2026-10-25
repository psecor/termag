/**
 * The one HTTP client the orchestrator uses to talk to an MCP server's OAuth
 * endpoints. Every URL it is handed came from a
 * third party (protected-resource metadata, authorization-server metadata), so
 * it is the SSRF boundary: https only, no redirects, and the address it
 * actually connects to must be public. The check is in the socket's DNS lookup,
 * so a name that resolved to a public address when it was validated and to a
 * private one now is still refused.
 */

import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isPublicAddress, McpConnectorError, upstreamTestAllow } from './mcpConnectors';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface HttpRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export type OAuthHttp = (url: string, req?: HttpRequest) => Promise<HttpResponse>;

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 8000;

/** Throws unless `raw` is an https URL on a host name (or the e2e allow-list), port 443. */
export function checkOAuthUrl(raw: string, allow: Set<string> = upstreamTestAllow()): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpConnectorError(`${raw.slice(0, 200)} is not a URL`);
  }
  if (u.protocol !== 'https:') throw new McpConnectorError(`${u.origin} is not https`);
  if (u.username || u.password) throw new McpConnectorError(`${u.origin} carries a user name or password`);
  const host = u.hostname.toLowerCase();
  if (allow.has(`${host}:${u.port || '443'}`)) return u;
  if (u.port && u.port !== '443') throw new McpConnectorError(`${u.origin} is not on the default https port`);
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) throw new McpConnectorError(`${u.origin} names an IP address`);
  return u;
}

function publicOnlyLookup(allowed: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      const ok = allowed ? list : list.filter(a => isPublicAddress(a.address));
      if (ok.length === 0) {
        return callback(Object.assign(new Error(`${hostname} resolves only to private or reserved addresses`), { code: 'EMCPPRIVATE' }), '', 0);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, ok);
      callback(null, ok[0].address, ok[0].family);
    });
  };
}

export function safeOAuthHttp(allow: Set<string> = upstreamTestAllow()): OAuthHttp {
  return (raw, req = {}) => new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = checkOAuthUrl(raw, allow);
    } catch (err) {
      reject(err);
      return;
    }
    const allowed = allow.has(`${u.hostname.toLowerCase()}:${u.port || '443'}`);
    const r = https.request(u, {
      method: req.method ?? 'GET',
      headers: { accept: 'application/json', 'user-agent': 'termag-mcp-broker', ...req.headers },
      lookup: publicOnlyLookup(allowed),
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          r.destroy(new McpConnectorError(`${u.origin} answered with more than ${MAX_BODY} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new McpConnectorError(`${u.origin} did not answer in time`)));
    r.on('error', err => reject(err instanceof McpConnectorError ? err
      : new McpConnectorError(`${u.origin} could not be reached (${(err as NodeJS.ErrnoException).code ?? err.message})`)));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}
