/**
 * The allowlist of MCP server URLs: the
 * mcp-upstream-allowlist flag, read for the connector's owner, is a JSON
 * array of URL strings, and every MCP server not on it is refused. Its
 * fallback is [], which allows nothing. The server SDK keeps serving the last
 * value it received while the flag source is unreachable, so the fallback is
 * served only when the orchestrator has never loaded the flag: no SDK key,
 * the SDK not yet initialised, or the flag missing from the source. That
 * case is `loaded: false`, refused with its own reason.
 *
 * An entry is https://host[:port][/path]. A connector URL matches when scheme,
 * host (lowercased) and port (443 when absent) are equal and its path equals
 * the entry's path or continues it after a `/`. Trailing slashes are ignored on
 * both sides, so https://api.example.com allows every path on that host and
 * /mcp and /mcp/ are one entry. No wildcards. An entry that doesn't parse is
 * ignored, with one log line per distinct entry.
 *
 * Only the MCP URL is checked: the OAuth discovery, registration and token
 * endpoints belong to the authorization server and are not.
 *
 * Pure apart from that log line: the flag value is handed in.
 */

export const MCP_UPSTREAM_ALLOWLIST_FLAG = 'mcp-upstream-allowlist';

export const NOT_ON_ALLOWLIST = "This MCP server isn't on termag's allowlist";
export const ALLOWLIST_NOT_LOADED = "termag couldn't load its MCP server allowlist";

/** A parsed entry, or a parsed connector URL: what matching compares. */
export interface AllowlistEntry {
  host: string;
  port: string;
  // No trailing slash; '' for the root.
  path: string;
}

export interface UpstreamAllowlist {
  // False when the flag's value was never loaded and the fallback stands in.
  loaded: boolean;
  entries: AllowlistEntry[];
}

/** What stands in when the orchestrator never loaded the flag: nothing is allowed. */
export const UNLOADED_ALLOWLIST: UpstreamAllowlist = { loaded: false, entries: [] };

const warned = new Set<string>();

function warnOnce(entry: unknown, why: string): void {
  const key = typeof entry === 'string' ? entry.slice(0, 200) : JSON.stringify(entry)?.slice(0, 200) ?? String(entry);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[MCP] ${MCP_UPSTREAM_ALLOWLIST_FLAG}: ignoring ${JSON.stringify(key)} (${why})`);
}

/** An https URL's scheme-less parts for matching; null for anything else, or one with credentials, a query or a fragment. */
export function parseAllowlistUrl(raw: unknown): AllowlistEntry | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  return { host: u.hostname.toLowerCase(), port: u.port || '443', path: u.pathname.replace(/\/+$/, '') };
}

/** A value the flag source served as entries. Anything but an array allows nothing, with a log line. */
export function parseUpstreamAllowlist(flagValue: unknown): UpstreamAllowlist {
  if (!Array.isArray(flagValue)) {
    warnOnce(flagValue, 'the value is not an array, so no MCP server is allowed');
    return { loaded: true, entries: [] };
  }
  const entries: AllowlistEntry[] = [];
  for (const entry of flagValue) {
    const parsed = parseAllowlistUrl(entry);
    if (parsed) entries.push(parsed);
    else warnOnce(entry, typeof entry === 'string' ? 'not an https://host[:port][/path] URL' : 'not a string');
  }
  return { loaded: true, entries };
}

/** Whether `upstream` (a connector's URL) is on `list`. */
export function upstreamAllowed(list: UpstreamAllowlist, upstream: string): boolean {
  const want = parseAllowlistUrl(upstream);
  if (!want) return false;
  return list.entries.some(e => e.host === want.host && e.port === want.port
    && (e.path === '' || want.path === e.path || want.path.startsWith(`${e.path}/`)));
}

/** Why `upstream` is refused under `list`, or null when it is allowed. */
export function upstreamRefusal(list: UpstreamAllowlist, upstream: string): string | null {
  if (upstreamAllowed(list, upstream)) return null;
  return list.loaded ? NOT_ON_ALLOWLIST : ALLOWLIST_NOT_LOADED;
}
