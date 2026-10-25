// Pure helpers for the MCP section of Settings (McpSection.tsx).

const PLACEHOLDER = /\{\{\s*secret\.([A-Za-z0-9_-]{1,40})\s*\}\}/g;

/** "Name: template" lines into header templates; blank lines are skipped. */
export function parseHeaderLines(text: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) return { headers, error: `"${line}" is not "Header-Name: value"` };
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, error: null };
}

export function formatHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** The secret names the templates refer to, in first-use order. */
export function referencedSecretNames(headers: Record<string, string>): string[] {
  const names: string[] = [];
  for (const t of Object.values(headers)) {
    for (const m of t.matchAll(PLACEHOLDER)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * ?server= on /settings/mcp: a connector id (from a box's "not linked" error)
 * picks that row; an https URL pre-fills the add form.
 */
export function serverParam(search: string): { connectorId: string | null; upstream: string | null } {
  const v = new URLSearchParams(search).get('server')?.trim() ?? '';
  if (/^https:\/\//i.test(v)) return { connectorId: null, upstream: v };
  if (/^[a-z0-9]{1,40}$/.test(v)) return { connectorId: v, upstream: null };
  return { connectorId: null, upstream: null };
}

/** A connector name suggested from an upstream URL: mcp.figma.com → figma. */
export function suggestName(upstream: string): string {
  let host: string;
  try {
    host = new URL(upstream).hostname.toLowerCase();
  } catch {
    return '';
  }
  const parts = host.split('.').filter(p => !['mcp', 'www', 'api'].includes(p));
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? '';
  const name = base.replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 41);
  return name;
}

/** What the OAuth callback said on its way back to /settings/mcp (?linked=1 or ?error=). */
export function linkResult(search: string): { linked: boolean; error: string | null } {
  const q = new URLSearchParams(search);
  const error = q.get('error')?.trim().slice(0, 300) || null;
  return { linked: !error && q.get('linked') === '1', error };
}

export type ConnectorTone = 'good' | 'warn' | 'bad';

/** The status pill on a server's row. */
export function connectorStatus(c: {
  authType: 'static' | 'oauth';
  missingSecrets: string[];
  secretNames: string[] | null;
  linkStatus?: 'linked' | 'needs_link';
}): { label: string; tone: ConnectorTone } {
  if (c.authType === 'oauth') return c.linkStatus === 'linked' ? { label: 'linked', tone: 'good' } : { label: 'not linked', tone: 'warn' };
  if (c.secretNames === null) return { label: 'secrets unreadable', tone: 'bad' };
  if (c.missingSecrets.length > 0) return { label: `missing ${c.missingSecrets.map(n => `secret.${n}`).join(', ')}`, tone: 'warn' };
  return { label: 'ready', tone: 'good' };
}
