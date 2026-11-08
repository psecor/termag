/**
 * Which OAuth scopes an MCP connector's sign-in asks for.
 * A server that advertises two or more scopes in its
 * protected-resource metadata (`scopes_supported`) gets a checklist in
 * Settings before the redirect, because some consent screens (Slack's) grant
 * all or nothing. A pre-registered client whose MCP_OAUTH_CLIENTS entry lists
 * `scopes` always asks for those, with no checklist. The scope that asks for a
 * refresh token (`offline_access`, or `offline` where that is all the server
 * offers) is never on the checklist: every sign-in asks for it when the server
 * advertises it. Labels come from the
 * mcp-oauth-scope-labels flag per authorization server issuer, with Slack's
 * table as the fallback.
 */

import { McpConnectorError } from './mcpConnectors';
import type { DiscoveredOAuth, PreregisteredClient } from './mcpOAuth';

export interface ScopeOption {
  name: string;
  // The label from the mcp-oauth-scope-labels table, else the raw name.
  label: string;
}

export interface ScopeChoice {
  options: ScopeOption[];
}

/** What a connector's sign-in asked for and what the token response said it got. */
export interface ConnectorScopes {
  requested: string[];
  // null: the token response named no scope (RFC 6749 §5.1 allows that when
  // the grant is what was asked for).
  granted: string[] | null;
}

export const MCP_SCOPE_LABELS_FLAG = 'mcp-oauth-scope-labels';

/** One entry of the mcp-oauth-scope-labels flag: a scope and its label. */
export interface ScopeLabelEntry {
  scope: string;
  label: string;
}

/** The flag's value: authorization server issuer → its scopes' labels. */
export type ScopeLabelsFlag = Record<string, ScopeLabelEntry[]>;

/** The parsed table: issuer (no trailing slash) → scope → its label. */
export type ScopeLabels = Map<string, Map<string, string>>;

// Slack's user scopes (https://api.slack.com/scopes): what the scope checklist
// shows while the mcp-oauth-scope-labels flag serves nothing (it doesn't exist,
// the flag source can't answer, or its value is not an object).
const slack = (scope: string, label: string): ScopeLabelEntry => ({ scope, label });
export const SCOPE_LABELS_FALLBACK: ScopeLabelsFlag = {
  'https://mcp.slack.com': [
    slack('search:read', 'Search messages'),
    slack('search:read.public', 'Search messages in public channels'),
    slack('search:read.private', 'Search messages in private channels'),
    slack('search:read.im', 'Search direct messages'),
    slack('search:read.mpim', 'Search group direct messages'),
    slack('search:read.files', 'Search files'),
    slack('search:read.users', 'Search people'),
    slack('channels:history', 'Read public channel history'),
    slack('groups:history', 'Read private channel history'),
    slack('im:history', 'Read direct message history'),
    slack('mpim:history', 'Read group direct message history'),
    slack('channels:read', 'See public channels'),
    slack('groups:read', 'See private channels'),
    slack('im:read', 'See direct messages'),
    slack('mpim:read', 'See group direct messages'),
    slack('channels:write', 'Manage public channels'),
    slack('groups:write', 'Manage private channels'),
    slack('im:write', 'Start direct messages'),
    slack('mpim:write', 'Start group direct messages'),
    slack('chat:write', 'Send messages'),
    slack('users:read', 'See people'),
    slack('users:read.email', "See people's email addresses"),
    slack('users.profile:read', 'See profiles'),
    slack('canvases:read', 'Read canvases'),
    slack('canvases:write', 'Create and edit canvases'),
    slack('lists:read', 'Read lists'),
    slack('lists:write', 'Create and edit lists'),
    slack('files:read', 'Read files'),
    slack('files:write', 'Upload and edit files'),
    slack('reactions:read', 'See reactions'),
    slack('reactions:write', 'Add and remove reactions'),
    slack('emoji:read', 'See custom emoji'),
  ],
};

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const warned = new Set<string>();
const warnOnce = (msg: string) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[MCP] ${MCP_SCOPE_LABELS_FLAG}: ${msg}`);
};

/**
 * The label table from the flag's value. Not an object (null included): the
 * Slack fallback. An issuer whose value is not a list, and an entry without a
 * string `scope` and `label`, is skipped with a warning; the rest of the value
 * still counts. Other keys on an entry are ignored with a warning.
 */
export function parseScopeLabels(raw: unknown): ScopeLabels {
  if (raw !== null && raw !== undefined && !isObj(raw)) warnOnce('not a JSON object; using the built-in labels');
  const value = isObj(raw) ? raw : SCOPE_LABELS_FALLBACK;
  const out: ScopeLabels = new Map();
  for (const [issuer, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      warnOnce(`${issuer.slice(0, 100)}: not a list; skipped`);
      continue;
    }
    const table = new Map<string, string>();
    entries.forEach((e, i) => {
      if (!isObj(e) || typeof e.scope !== 'string' || !e.scope.trim() || typeof e.label !== 'string' || !e.label.trim()) {
        warnOnce(`${issuer.slice(0, 100)}: entry ${i} needs a string scope and label; skipped`);
        return;
      }
      const extra = Object.keys(e).filter(k => k !== 'scope' && k !== 'label');
      if (extra.length) warnOnce(`${issuer.slice(0, 100)}: entry ${i}: ignoring ${extra.join(', ').slice(0, 100)}`);
      table.set(e.scope.trim(), e.label.trim());
    });
    out.set(trimSlash(issuer), table);
  }
  return out;
}

/** The scope's label for this issuer, or its raw name. */
export function scopeLabel(labels: ScopeLabels, issuer: string, scope: string): string {
  return labels.get(trimSlash(issuer))?.get(scope) ?? scope;
}

// The scopes that ask the authorization server for a refresh token
// (OpenID Connect's offline_access; Ory Hydra, New Relic's server, also takes
// offline), in order of preference. A server that supports refresh_token can
// still issue none unless the authorize request names one of them.
const OFFLINE_SCOPES = ['offline_access', 'offline'];
const isOffline = (s: string) => OFFLINE_SCOPES.includes(s);

/**
 * The scope every sign-in to this server adds so that its token comes with a
 * refresh token: `offline_access` when advertised, else `offline`, else null.
 * Google's equivalent is not a scope but `access_type=offline` on the
 * authorize URL (services/apiBroker.ts GOOGLE_OAUTH authorizeParams).
 */
export function offlineScope(meta: DiscoveredOAuth): string | null {
  return OFFLINE_SCOPES.find(s => meta.scopes.includes(s)) ?? null;
}

/** The advertised scopes a person chooses from: all but the offline ones. */
const choosable = (meta: DiscoveredOAuth) => meta.scopes.filter(s => !isOffline(s));

/**
 * The checklist Settings shows before the redirect, or null when there is
 * nothing to choose: fewer than two advertised scopes besides the offline
 * ones, or a pre-registered client that pins its scopes.
 */
export function scopeChoice(meta: DiscoveredOAuth, pre: PreregisteredClient | null, labels: ScopeLabels): ScopeChoice | null {
  const names = choosable(meta);
  if (pre?.scopes || names.length < 2) return null;
  return { options: names.map(name => ({ name, label: scopeLabel(labels, meta.issuer, name) })) };
}

/**
 * The scopes the authorize URL asks for. `chosen` is the request's `scopes`:
 * absent asks for every advertised scope,
 * a list asks for exactly those, each of which the server must advertise. A
 * pre-registered client that pins scopes asks for them and takes no choice.
 * Each adds the server's offline scope (offlineScope) unless the list already
 * names an offline scope, and asks for at most one of them.
 */
export function scopesToRequest(meta: DiscoveredOAuth, chosen: unknown, pre: PreregisteredClient | null): string[] {
  const offline = offlineScope(meta);
  const withOffline = (list: string[]) => (offline && !list.some(isOffline) ? [...list, offline] : list);
  if (pre?.scopes) {
    if (chosen !== undefined) throw new McpConnectorError("this server's scopes are set by this orchestrator (MCP_OAUTH_CLIENTS) and cannot be chosen");
    return withOffline([...pre.scopes]);
  }
  if (chosen === undefined) return withOffline(choosable(meta));
  if (!Array.isArray(chosen) || !chosen.every(s => typeof s === 'string')) throw new McpConnectorError('scopes must be a list of scope names');
  if (chosen.length === 0) throw new McpConnectorError('choose at least one scope');
  for (const s of chosen) {
    if (!meta.scopes.includes(s)) throw new McpConnectorError(`the server does not offer the scope "${s.slice(0, 100)}"`);
  }
  return withOffline(choosable(meta).filter(s => chosen.includes(s)));
}

/** The token response's `scope` as a list (Slack separates them with commas), or null when it named none. */
export function grantedScopesFrom(scope: string | undefined): string[] | null {
  if (scope === undefined) return null;
  return scope.split(/[\s,]+/).filter(Boolean);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');

/** A connector's stored `oauthScopes`, or null when there is none or it is malformed. */
export function connectorScopes(v: unknown): ConnectorScopes | null {
  if (!v || typeof v !== 'object') return null;
  const { requested, granted } = v as Record<string, unknown>;
  if (!isStrings(requested) || !(granted === null || isStrings(granted))) return null;
  return { requested, granted };
}
