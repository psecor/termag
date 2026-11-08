/**
 * Linking an OAuth MCP server by pasting the redirect.
 * Some authorization servers accept only a loopback
 * redirect for a client they don't list (New Relic's DCR hands every client
 * one client id that allows only http://localhost:<port>/callback). For the
 * servers the mcp-oauth-loopback-servers flag lists for the user, termag
 * registers and signs in with LOOPBACK_REDIRECT_URI instead of its own
 * callback. Nothing listens there: the browser lands on a page that doesn't
 * load, the person pastes its address into Settings, and the orchestrator
 * finishes the sign-in from the pasted query as its callback would.
 *
 * Pure: the flag value is handed in.
 */

export const LOOPBACK_SERVERS_FLAG = 'mcp-oauth-loopback-servers';

// Fixed, so a server that matches redirects exactly sees the same URI on
// every registration, authorize request and token request.
export const LOOPBACK_PORT = 53682;
export const LOOPBACK_REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/callback`;

// A pasted address longer than this is not a redirect termag asked for.
const MAX_PASTE = 8192;

/**
 * A server URL as the flag lists it and Settings stores it: scheme, host
 * (with a non-default port) and path, trailing slashes dropped; query and
 * fragment ignored. null for anything that isn't an http(s) URL.
 */
export function normaliseServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** Whether the flag's value (a JSON array of server URLs) lists `upstream`. Anything but an array lists nothing. */
export function loopbackAllowed(flagValue: unknown, upstream: string): boolean {
  if (!Array.isArray(flagValue)) return false;
  const want = normaliseServerUrl(upstream);
  return !!want && flagValue.some(entry => normaliseServerUrl(entry) === want);
}

export type PastedRedirect = { ok: true; query: Record<string, string> } | { ok: false; error: string };

const WRONG_ADDRESS = `That is not the address the server sent you to after signing in. It starts with ${LOOPBACK_REDIRECT_URI}; copy the whole address of the page that didn't load.`;

/**
 * The callback query from a pasted address: `state` with `code` or `error`
 * (and `iss`, `error_description` when present). The address must be the
 * loopback redirect, on localhost or 127.0.0.1, with or without its http://.
 * An error message never repeats what was pasted.
 */
export function parsePastedRedirect(pasted: unknown): PastedRedirect {
  const text = typeof pasted === 'string' ? pasted.trim() : '';
  if (!text) return { ok: false, error: 'Paste the address of the page your browser opened after you signed in.' };
  if (text.length > MAX_PASTE) return { ok: false, error: WRONG_ADDRESS };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { ok: false, error: WRONG_ADDRESS };
  }
  const want = new URL(LOOPBACK_REDIRECT_URI);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== want.port || u.pathname !== want.pathname) {
    return { ok: false, error: WRONG_ADDRESS };
  }
  const query: Record<string, string> = {};
  for (const key of ['code', 'state', 'iss', 'error', 'error_description']) {
    const v = u.searchParams.get(key);
    if (v !== null) query[key] = v;
  }
  if (!query.state || (!query.code && !query.error)) {
    return { ok: false, error: 'That address is missing part of the sign-in. Copy the whole address, including everything after the "?".' };
  }
  return { ok: true, query };
}
