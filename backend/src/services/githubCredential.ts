/**
 * The per-user GitHub credential: the user's `gh`
 * token, held only on the orchestrator. Boxes never receive it; the GitHub
 * broker (githubBroker.ts) spends it on their behalf. The token never reaches
 * logs or HTTP responses, and the database holds it only encrypted
 * (credentialStore.ts).
 */

import type { GithubSecret } from './credentialStore';
import { githubTokenPrefix, probeOrgAccess, TOKEN_TYPE_SENTENCE } from './githubRepos';

export const GITHUB_API = 'https://api.github.com';

export const GITHUB_REJECTED_SENTENCE =
  'GitHub rejected that token. Run `gh auth login` on your laptop and try again.';

const NOT_A_TOKEN = 'That is not a GitHub token (paste the output of `gh auth token`).';

export function looksLikeGithubToken(value: unknown): value is string {
  const prefix = githubTokenPrefix(value);
  return prefix === 'gho' || prefix === 'ghp';
}

/**
 * The scopes a classic or OAuth token (what `gh auth token` prints) lacks:
 * `repo` to reach private repositories, and `read:org` (or a broader org
 * scope), which gh on the box needs to log in to the broker. Matches gh's own
 * check. Fine-grained tokens report no scopes; their access is whatever the
 * user granted.
 */
export function missingScopes(scopes: string[]): string[] {
  if (scopes.length === 0) return [];
  const missing: string[] = [];
  if (!scopes.includes('repo')) missing.push('repo');
  if (!['read:org', 'write:org', 'admin:org'].some(s => scopes.includes(s))) missing.push('read:org');
  return missing;
}

function scopeError(missing: string[]): CredentialInputError {
  return new CredentialInputError(
    `The token is missing the ${missing.join(' and ')} scope${missing.length > 1 ? 's' : ''}. ` +
    `Run \`gh auth refresh -h github.com -s ${missing.join(',')}\`, then paste \`gh auth token\` again.`,
  );
}

/** github_pat_ and ghu_ throw the one-owner sentence. */
function usableToken(token: unknown): string {
  if (typeof token !== 'string') throw new CredentialInputError(NOT_A_TOKEN);
  const prefix = githubTokenPrefix(token);
  if (prefix === 'github_pat' || prefix === 'ghu') throw new CredentialInputError(TOKEN_TYPE_SENTENCE);
  if (prefix !== 'gho' && prefix !== 'ghp') throw new CredentialInputError(NOT_A_TOKEN);
  return token;
}

// ── GitHub API ───────────────────────────────────────────────────────────────

type Fetch = typeof fetch;

const RESPONSE_HEADERS = ['etag', 'link', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-github-sso', 'x-oauth-scopes'] as const;

function githubApiHeaders(token: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'termag',
    Authorization: `Bearer ${token}`,
  };
  if (etag) headers['If-None-Match'] = etag;
  return headers;
}

function pickHeaders(headers: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value != null) out[name] = value;
  }
  return out;
}

export class GithubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface GithubHttpResponse {
  readonly status: number;
  readonly etag: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Plain header object, not Headers.
 * 304 returns body null and does not throw. Does not classify.
 */
export async function githubGet(
  url: string,
  token: string,
  opts?: { etag?: string; fetchImpl?: Fetch },
): Promise<GithubHttpResponse> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const headers = githubApiHeaders(token, opts?.etag);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  timer.unref();
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    const picked = pickHeaders(res.headers);
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 304, etag: picked.etag ?? null, headers: picked, body: null };
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { status: res.status, etag: picked.etag ?? null, headers: picked, body };
  } finally {
    clearTimeout(timer);
  }
}

export interface GithubIdentity {
  login: string;
  id: number;
  scopes: string[];
}

export async function fetchGithubIdentity(token: string, fetchImpl: Fetch = fetch): Promise<GithubIdentity> {
  const res = await githubGet(`${GITHUB_API}/user`, token, { fetchImpl });
  if (res.status !== 200) throw new GithubApiError(`GitHub rejected the token (HTTP ${res.status})`, res.status);
  const body = res.body;
  if (!body || typeof body !== 'object') throw new GithubApiError('GitHub returned no user for the token', 502);
  const login = (body as { login?: unknown }).login;
  const id = (body as { id?: unknown }).id;
  if (typeof login !== 'string' || typeof id !== 'number') {
    throw new GithubApiError('GitHub returned no user for the token', 502);
  }
  const scopes = (res.headers['x-oauth-scopes'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return { login, id, scopes };
}

async function identityOrReject(token: string, fetchImpl: Fetch | undefined): Promise<GithubIdentity> {
  try {
    return await fetchGithubIdentity(token, fetchImpl);
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 401) throw new CredentialInputError(GITHUB_REJECTED_SENTENCE);
    throw err;
  }
}

// ── Connect ──────────────────────────────────────────────────────────────────

export interface GithubStoreDeps {
  write: (secret: GithubSecret) => Promise<void>;
  fetchImpl?: Fetch;
}

export interface GithubRecheckDeps {
  readSnapshot: () => Promise<{ secret: GithubSecret; ciphertext: Uint8Array } | null>;
  replaceIfUnchanged: (ciphertext: Uint8Array, secret: GithubSecret) => Promise<boolean>;
  fetchImpl?: Fetch;
}

export class CredentialInputError extends Error {
  readonly status = 400;
}

export interface GithubConnected {
  login: string;
  label: string;
}

export function githubLabel(login: string): string {
  return `@${login}`;
}

/** Store a pasted gh token, replacing any stored one. Errors never carry the token. */
export async function connectGithub(token: unknown, deps: GithubStoreDeps): Promise<GithubConnected> {
  const usable = usableToken(token);
  const identity = await identityOrReject(usable, deps.fetchImpl);
  const missing = missingScopes(identity.scopes);
  if (missing.length) throw scopeError(missing);
  const orgs = await probeOrgAccess(usable, { fetchImpl: deps.fetchImpl });
  await deps.write({ login: identity.login, githubUserId: identity.id, token: usable, orgs });
  return { login: identity.login, label: githubLabel(identity.login) };
}

/** No row, a one-owner prefix, or a 401 leaves the row as it was. A row deleted during the probe stays deleted. */
export async function recheckGithub(deps: GithubRecheckDeps): Promise<void> {
  const loaded = await deps.readSnapshot();
  if (!loaded) throw new CredentialInputError('Connect GitHub in Settings.');
  const usable = usableToken(loaded.secret.token);
  const identity = await identityOrReject(usable, deps.fetchImpl);
  const missing = missingScopes(identity.scopes);
  if (missing.length) throw scopeError(missing);
  const orgs = await probeOrgAccess(usable, { fetchImpl: deps.fetchImpl });
  await deps.replaceIfUnchanged(loaded.ciphertext, {
    login: identity.login, githubUserId: identity.id, token: usable, orgs,
  });
}
