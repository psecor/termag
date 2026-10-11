/**
 * The GitHub broker: boxes
 * hold no GitHub credential. Their git and gh talk to the gateway's GitHub
 * listener (Envoy) with the box token; Envoy asks the orchestrator about each
 * request (routes/githubAuthz.ts) and forwards it to github.com or
 * api.github.com with the owner's token the orchestrator hands back.
 *
 * gh treats the broker as a GitHub Enterprise host, so it is addressed in the
 * GHES layout at the root: `/<owner>/<repo>/<git smart-HTTP>`, `/api/v3/*` and
 * `/api/graphql`.
 *
 * The owner's token scopes are the real boundary; the blocklist is defence in
 * depth against a box minting persistent credentials or doing admin damage.
 */

import { Kind, OperationTypeNode, parse } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, SelectionNode } from 'graphql';

export interface BrokerTarget {
  kind: 'git' | 'api' | 'graphql';
  // The upstream path GitHub sees, without a query string (git's service aside).
  logPath: string;
}

const GIT_SUFFIXES = new Set(['info/refs', 'git-upload-pack', 'git-receive-pack']);
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Maps a GHES-layout path (e.g. `/o/r.git/info/refs`, `/api/v3/user`,
 * `/api/graphql`) to what it reaches upstream, or null for anything the broker
 * does not forward. /api comes first: on a GHES host it is never a repository.
 */
export function brokerTarget(method: string, path: string, search: string): BrokerTarget | null {
  if (path.includes('..') || path.includes('//')) return null;
  if (path === '/api/graphql') {
    return method === 'POST' ? { kind: 'graphql', logPath: '/graphql' } : null;
  }
  const api = /^\/api\/v3(\/.*)?$/.exec(path);
  if (api) {
    const logPath = api[1] ?? '/';
    // GitHub serves GraphQL here too; only /api/graphql gets its body checked.
    const canonical = canonicalRestPath(logPath);
    if (canonical === null || /^\/graphql(\/|$)/.test(canonical)) return null;
    return { kind: 'api', logPath };
  }
  if (path.startsWith('/api/')) return null;
  const git = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!git) return null;
  const [, owner, repo, suffix] = git;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo) || !GIT_SUFFIXES.has(suffix)) return null;
  if (suffix === 'info/refs') {
    const service = new URLSearchParams(search).get('service');
    if (method !== 'GET' || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) return null;
    return { kind: 'git', logPath: `/${owner}/${repo}/info/refs?service=${service}` };
  }
  if (method !== 'POST') return null;
  return { kind: 'git', logPath: `/${owner}/${repo}/${suffix}` };
}

// Credential minting and persistence, access grants, and admin or destructive
// operations. Matched on the upstream REST path, case-insensitively.
const ALWAYS_BLOCKED: RegExp[] = [
  /^\/authorizations(\/|$)/,
  /^\/applications\//,
  /^\/admin(\/|$)/,
  /^\/enterprises\//,
  /^\/user\/keys(\/|$)/,
  /^\/user\/gpg_keys(\/|$)/,
  /^\/user\/ssh_signing_keys(\/|$)/,
];
const WRITE_BLOCKED: RegExp[] = [
  /^\/repos\/[^/]+\/[^/]+\/keys(\/|$)/,
  /^\/repos\/[^/]+\/[^/]+\/hooks(\/|$)/,
  /^\/orgs\/[^/]+\/hooks(\/|$)/,
  /^\/repos\/[^/]+\/[^/]+\/transfer$/,
  /^\/repos\/[^/]+\/[^/]+\/collaborators\//,
  /^\/repos\/[^/]+\/[^/]+\/branches\/[^/]+\/protection(\/|$)/,
  /^\/repos\/[^/]+\/[^/]+\/rulesets(\/|$)/,
  /^\/orgs\/[^/]+\/(members|memberships|outside_collaborators|rulesets)(\/|$)/,
  /^\/orgs\/[^/]+$/,
];

/**
 * The REST path the blocklist matches: percent-decoded, lower-cased, without
 * a trailing slash, so an encoded or cased variant of a blocked path is the
 * same path. GitHub's ID aliases, /repositories/<id> and /organizations/<id>,
 * are mapped onto the /repos/<owner>/<repo> and /orgs/<org> shapes, so every
 * rule covers them too. Null for a path that doesn't decode.
 */
export function canonicalRestPath(restPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(restPath).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
  return path
    .replace(/^\/repositories\/([^/]+)(?=\/|$)/, '/repos/~id/$1')
    .replace(/^\/organizations\/([^/]+)(?=\/|$)/, '/orgs/$1');
}

/** Why the broker refuses this API request, or null to forward it. */
export function blockedApiReason(method: string, restPath: string, body: string): string | null {
  const path = canonicalRestPath(restPath);
  if (path === null) return 'undecodable path';
  const m = method.toUpperCase();
  if (ALWAYS_BLOCKED.some(r => r.test(path))) return 'credential or admin endpoint';
  if (m === 'GET' || m === 'HEAD') return null;
  if (WRITE_BLOCKED.some(r => r.test(path))) return 'access, protection or admin change';
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
    if (m === 'DELETE') return 'repository deletion';
    if (m === 'PATCH') {
      // Envoy sends the body for /repos/<owner>/<repo> and /repositories/<id>,
      // in any case; any other spelling arrives without one, and can't be checked.
      if (!body.trim()) return 'repository update the broker cannot check';
      // Decoded keys, so a JSON escape (`\u0070rivate`) is the key it spells.
      const update = jsonObject(body);
      if (!update) return 'repository update the broker cannot read';
      if (REPO_PATCH_BLOCKED.some(k => Object.prototype.hasOwnProperty.call(update, k))) return 'repository visibility change';
    }
  }
  return null;
}

// GitHub's REST and GraphQL bodies are far smaller; Envoy sends at most 4 MiB.
export const MAX_CHECKED_BODY_BYTES = 4 * 1024 * 1024;

// Repository fields a box may not change: visibility, and archiving.
const REPO_PATCH_BLOCKED = ['private', 'visibility', 'archived'];

function jsonObject(body: string): Record<string, unknown> | null {
  if (Buffer.byteLength(body, 'utf8') > MAX_CHECKED_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// Matched against the field name of each root mutation, never the alias, after
// the document is parsed: comments, commas and escapes can't hide one.
const GRAPHQL_BLOCKED = /^(\w*Enterprise\w*|\w*IpAllowList\w*|\w*DeployKey\w*|\w*PublicKey\w*|\w*SshKey\w*|\w*GpgKey\w*|\w*SigningKey\w*|updateRepository|deleteRepository|transferRepository|archiveRepository|\w*BranchProtectionRule|\w*RepositoryRuleset|\w*Collaborator\w*)$/;

/**
 * Why the broker refuses this GraphQL request body, or null to forward it. The
 * body must be one JSON object with a `query` string that parses as GraphQL;
 * every mutation's root fields, through fragments, are checked by name.
 */
export function blockedGraphqlReason(body: string): string | null {
  const request = jsonObject(body);
  if (!request || typeof request.query !== 'string') return 'graphql request the broker cannot read';
  let doc: DocumentNode;
  try {
    doc = parse(request.query, { noLocation: true });
  } catch {
    return 'graphql document the broker cannot parse';
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
  for (const d of doc.definitions) {
    if (d.kind !== Kind.OPERATION_DEFINITION || d.operation !== OperationTypeNode.MUTATION) continue;
    const blocked = blockedRootField(d.selectionSet.selections, fragments, new Set());
    if (blocked) return `graphql ${blocked}`;
  }
  return null;
}

function blockedRootField(
  selections: readonly SelectionNode[],
  fragments: Map<string, FragmentDefinitionNode>,
  seen: Set<string>,
): string | null {
  for (const s of selections) {
    if (s.kind === Kind.FIELD) {
      if (GRAPHQL_BLOCKED.test(s.name.value)) return s.name.value;
    } else if (s.kind === Kind.INLINE_FRAGMENT) {
      const found = blockedRootField(s.selectionSet.selections, fragments, seen);
      if (found) return found;
    } else if (s.kind === Kind.FRAGMENT_SPREAD) {
      const name = s.name.value;
      const fragment = fragments.get(name);
      // An undefined fragment is an error GitHub would reject; refuse it here too.
      if (!fragment) return `undefined fragment ${name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const found = blockedRootField(fragment.selectionSet.selections, fragments, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The box token from git's Basic auth (the credential helper sends it as the
 * password) or gh's `token`/`Bearer` header. Never logged.
 */
export function boxTokenFrom(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, value] = authorization.trim().split(/\s+/, 2);
  if (!value) return null;
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i >= 0 && decoded.length > i + 1 ? decoded.slice(i + 1) : null;
  }
  return /^(token|bearer)$/i.test(scheme) ? value : null;
}

/** The Authorization header Envoy sends GitHub in place of the box token. */
export function ownerAuthorization(kind: BrokerTarget['kind'], ownerToken: string): string {
  return kind === 'git'
    ? `Basic ${Buffer.from(`x-access-token:${ownerToken}`).toString('base64')}`
    : `Bearer ${ownerToken}`;
}

/**
 * The broker's base URL as boxes see it: GITHUB_BROKER_URL, the gateway's
 * GitHub hostname. gh accepts only a bare hostname as a GitHub Enterprise
 * host, so a URL on any port but 443 is refused.
 */
export function getGithubBrokerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GITHUB_BROKER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.port !== '' && url.port !== '443') return null;
    return `https://${url.hostname}`;
  } catch {
    return null;
  }
}

// ── Token source ─────────────────────────────────────────────────────────────

/**
 * Where the broker gets an owner's GitHub token. Today the stored `gh` token;
 * a GitHub App user-to-server token can replace it without touching callers.
 */
export type GithubTokenSource = (userId: string) => Promise<string | null>;

const CACHE_MS = 60_000;

/** Caches each owner's token briefly, since one clone is several requests. */
export function cachedTokenSource(load: GithubTokenSource, now = () => Date.now()): GithubTokenSource & { forget(userId: string): void } {
  const cache = new Map<string, { token: string | null; at: number }>();
  const source = async (userId: string) => {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < CACHE_MS) return hit.token;
    const token = await load(userId);
    cache.set(userId, { token, at: now() });
    return token;
  };
  return Object.assign(source, { forget: (userId: string) => { cache.delete(userId); } });
}
