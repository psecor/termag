/**
 * What termag says when an authorization server refuses the sign-in's
 * redirect URI.
 * Two places see it: dynamic client registration, which some servers refuse
 * for a redirect their admin hasn't allowed (Glean), and the authorize
 * request, which some servers check before login (New Relic, Ory Hydra,
 * answers with a redirect to its own error page). termag pre-flights the
 * authorize URL so the person sees the refusal in Settings, with the URL an
 * admin would allow-list, instead of on the provider's error page. Servers
 * that check after login (Datadog, Atlassian) look fine here and are
 * unaffected.
 *
 * Pure apart from the HTTP client preflightAuthorize is handed.
 */

import { McpConnectorError } from './mcpConnectors';
import type { OAuthHttp } from './mcpOAuthHttp';

type Answer = { status: number; headers: Record<string, string>; text: string };

/**
 * A refusal of the redirect URI: one line for Settings, the refused URL, which
 * Settings shows under it with a Copy button, and the provider's own reason,
 * for the log.
 */
export class RedirectRefusedError extends McpConnectorError {
  constructor(message: string, readonly redirectUri: string, readonly reason: string) {
    super(message);
  }
}

const NAMES_REDIRECT = /redirect[_\s-]?ur[il]/i;
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** A JSON error body's code (`error`) and its reason (the description, else the code or `message`), or null. */
function errorOf(text: string): { code: string | null; why: string } | null {
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      const code = typeof b.error === 'string' ? b.error : null;
      const why = [b.error_description, b.error, b.message].find((v): v is string => typeof v === 'string');
      if (why) return { code, why };
    }
  } catch { /* not JSON */ }
  return null;
}

/**
 * The server's reason when an authorize answer refuses the redirect URI, or
 * null. A refusal is a redirect somewhere other than `redirectUri` carrying an
 * `error` (code or description) that names the redirect URI, or a 4xx whose
 * error code or reason names it (`invalid_redirect_uri` counts either way). A login
 * page (any 200), a redirect to one, and an error sent back to `redirectUri`
 * itself (the server accepted the redirect) are not refusals.
 */
export function authorizeRefusal(res: Answer, redirectUri: string): string | null {
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.location;
    if (!location) return null;
    let u: URL;
    try {
      u = new URL(location, 'https://authorization-server.invalid/');
    } catch {
      return null;
    }
    if (trimSlash(`${u.origin}${u.pathname}`) === trimSlash(redirectUri.split('?')[0])) return null;
    const error = u.searchParams.get('error');
    if (!error) return null;
    const why = u.searchParams.get('error_description') ?? error;
    return NAMES_REDIRECT.test(why) || NAMES_REDIRECT.test(error) ? why.slice(0, 300) : null;
  }
  if (res.status >= 400 && res.status < 500) {
    const err = errorOf(res.text) ?? { code: null, why: res.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
    return NAMES_REDIRECT.test(err.why) || (err.code !== null && NAMES_REDIRECT.test(err.code)) ? err.why.slice(0, 300) : null;
  }
  return null;
}

// What an admin does at each known provider, by the issuer's host (a suffix
// match, so every Glean tenant and Datadog site is covered).
const HINTS: Array<{ hosts: string[]; hint: string }> = [
  {
    hosts: ['datadoghq.com', 'datadoghq.eu', 'ddog-gov.com'],
    hint: 'A Datadog org admin adds it under Organization Settings → MCP → MCP OAuth Redirect URLs.',
  },
  {
    hosts: ['newrelic.com'],
    hint: 'New Relic has no allow-list and accepts only localhost: use an API key, or ask a termag admin to list it for pasting the redirect.',
  },
  {
    hosts: ['glean.com'],
    hint: 'A Glean admin adds it under Admin console → Third-party access (OAuth) → Dynamic Client Registration.',
  },
];

/** The known provider's admin steps for `issuer`, or null. */
export function issuerHint(issuer: string): string | null {
  let host: string;
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    return null;
  }
  return HINTS.find(h => h.hosts.some(d => host === d || host.endsWith(`.${d}`)))?.hint ?? null;
}

/**
 * The one line Settings shows for a refusal: the provider's admin step when
 * the issuer is a known one, else that an admin allow-lists the URL.
 */
export function redirectRefusedError(p: { providerMessage: string; redirectUri: string; issuer: string }): RedirectRefusedError {
  const step = issuerHint(p.issuer) ?? 'An admin needs to allow-list it at the provider.';
  return new RedirectRefusedError(`The server refused termag's redirect URI. ${step}`, p.redirectUri, p.providerMessage.slice(0, 300));
}

/**
 * Fetches the authorize URL without following redirects and throws a
 * RedirectRefusedError when the server refuses the redirect URI before
 * login. Anything else, a network failure included, lets the sign-in go on:
 * the browser would see the same answer.
 */
export async function preflightAuthorize(url: string, p: { redirectUri: string; issuer: string }, http: OAuthHttp): Promise<void> {
  let res: Answer;
  try {
    res = await http(url, { headers: { accept: 'text/html,application/json' } });
  } catch {
    return;
  }
  const why = authorizeRefusal(res, p.redirectUri);
  if (why) throw redirectRefusedError({ providerMessage: why, redirectUri: p.redirectUri, issuer: p.issuer });
}
