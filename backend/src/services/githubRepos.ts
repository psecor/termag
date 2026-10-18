import { CredentialInputError, GITHUB_API, GITHUB_REJECTED_SENTENCE, githubGet } from './githubCredential';

export const TOKEN_TYPE_SENTENCE =
  'This token type sees one owner only; paste the output of `gh auth token`';

export const RECONNECT_SENTENCE = 'Reconnect GitHub in Settings';

export const MAX_REPO_PAGES = 50;

// No orgs unless GITHUB_REPO_ORGS names them (comma-separated).
const DEFAULT_ORGS: readonly string[] = [];
const ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DEFAULT_TTL_MS = 600_000;

export type GithubTokenPrefix = 'gho' | 'ghp' | 'ghu' | 'github_pat';

const TOKEN_RE = /^(github_pat|ghu|ghp|gho)_([A-Za-z0-9_]{20,255})$/;

export function githubTokenPrefix(value: unknown): GithubTokenPrefix | null {
  if (typeof value !== 'string') return null;
  const match = TOKEN_RE.exec(value);
  if (!match) return null;
  return match[1] as GithubTokenPrefix;
}

export type UserAccess =
  | { readonly status: 'ok' }
  | { readonly status: 'rate-limited'; readonly retryAfter: string | null }
  | { readonly status: 'error'; readonly retryAfter: string | null };

export type OrgAccess =
  | { readonly status: 'ok' }
  | { readonly status: 'sso-required'; readonly ssoUrl: string | null }
  | { readonly status: 'app-policy' }
  | { readonly status: 'rate-limited'; readonly retryAfter: string | null }
  | { readonly status: 'error'; readonly retryAfter: string | null };

export interface RepoEntry {
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly pushedAt: string | null;
  readonly sizeKb: number;
}

export type RepoGroup =
  | ({ readonly owner: string; readonly kind: 'user'; readonly repos: readonly RepoEntry[] } & UserAccess)
  | { readonly owner: string; readonly kind: 'org'; readonly status: 'ok'; readonly repos: readonly RepoEntry[] }
  | { readonly owner: string; readonly kind: 'org'; readonly status: 'sso-required'; readonly ssoUrl: string | null; readonly repos: readonly [] }
  | { readonly owner: string; readonly kind: 'org'; readonly status: 'app-policy'; readonly repos: readonly [] }
  | { readonly owner: string; readonly kind: 'org'; readonly status: 'rate-limited'; readonly retryAfter: string | null; readonly repos: readonly RepoEntry[] }
  | { readonly owner: string; readonly kind: 'org'; readonly status: 'error'; readonly retryAfter: string | null; readonly repos: readonly RepoEntry[] };

export type Reconnect =
  | { readonly code: 'token-type'; readonly sentence: typeof TOKEN_TYPE_SENTENCE }
  | { readonly code: 'unauthorized'; readonly sentence: typeof RECONNECT_SENTENCE };

export type RepoList =
  | { readonly status: 'ok'; readonly groups: readonly RepoGroup[] }
  | { readonly status: 'reconnect'; readonly reconnect: Reconnect; readonly groups: readonly [] };

export type ClassifyResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not-modified' }
  | { readonly kind: 'reconnect'; readonly code: 'unauthorized' | 'token-type' }
  | { readonly kind: 'rate-limited'; readonly retryAfter: string | null }
  | { readonly kind: 'sso-required'; readonly ssoUrl: string | null }
  | { readonly kind: 'app-policy' }
  | { readonly kind: 'error'; readonly retryAfter: string | null };

export interface ClassifyInput {
  readonly status: number;
  /** Keys may be any case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Not read: GitHub's error prose must not become a sentence or a branch. */
  readonly body: unknown;
  readonly tokenPrefix: GithubTokenPrefix | null;
  readonly group: 'user' | 'org';
  /** Epoch milliseconds. */
  readonly now: number;
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return value;
  }
  return undefined;
}

function parseRetryAfter(value: string, now: number): string | null {
  if (/^\d+$/.test(value)) return new Date(now + Number(value) * 1000).toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Prefer retry-after (delta seconds or HTTP date), else x-ratelimit-reset as unix seconds. */
function retryAfterIso(headers: Readonly<Record<string, string | undefined>>, now: number): string | null {
  const retry = header(headers, 'retry-after');
  if (retry != null && retry.trim() !== '') {
    const parsed = parseRetryAfter(retry.trim(), now);
    if (parsed) return parsed;
  }
  const reset = header(headers, 'x-ratelimit-reset')?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const ms = Number(reset) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function ssoUrlFrom(headerValue: string): string | null {
  const idx = headerValue.indexOf('url=');
  if (idx < 0) return null;
  let url = headerValue.slice(idx + 'url='.length).trim();
  if (url.endsWith(';') || url.endsWith(',')) url = url.slice(0, -1);
  if (!url.startsWith('https://github.com/')) return null;
  return url;
}

/**
 * The same SSO header on the user scope is an error: that group cannot be
 * sso-required or app-policy.
 */
export function classifyGithubResponse(input: ClassifyInput): ClassifyResult {
  if (input.tokenPrefix === 'ghu') {
    return { kind: 'reconnect', code: 'token-type' };
  }
  const { status, headers, group, now } = input;
  if (status === 401) return { kind: 'reconnect', code: 'unauthorized' };
  if (status === 304) return { kind: 'not-modified' };
  if (status === 200) return { kind: 'ok' };

  const remaining = header(headers, 'x-ratelimit-remaining')?.trim();
  const retryHeader = header(headers, 'retry-after');
  const hasRetry = retryHeader != null && retryHeader.trim() !== '';
  if (status === 429 || (status === 403 && (remaining === '0' || hasRetry))) {
    return { kind: 'rate-limited', retryAfter: retryAfterIso(headers, now) };
  }

  const sso = header(headers, 'x-github-sso');
  if ((status === 403 || status === 404) && sso != null && sso.trim().startsWith('required')) {
    if (group === 'org') return { kind: 'sso-required', ssoUrl: ssoUrlFrom(sso) };
    return { kind: 'error', retryAfter: retryAfterIso(headers, now) };
  }

  if (status === 403 && group === 'org') return { kind: 'app-policy' };
  if (status === 403) return { kind: 'error', retryAfter: retryAfterIso(headers, now) };
  if (status >= 500 && status <= 599) return { kind: 'error', retryAfter: retryAfterIso(headers, now) };
  return { kind: 'error', retryAfter: retryAfterIso(headers, now) };
}

export type PageSpan =
  | { readonly kind: 'complete'; readonly last: number }
  | { readonly kind: 'final' }
  | { readonly kind: 'unbounded' };

/**
 * null / blank → one page. rel="last" wins over rel="next".
 * A last page above MAX_REPO_PAGES, or a Link that names a further page
 * without a parseable rel="last", is unbounded so one header cannot
 * schedule an open-ended fan-out.
 * GitHub's final page omits rel="last" and sends only rel="first" and
 * rel="prev". That is the end of a span already known from an earlier page.
 */
export function pagesFromLink(linkHeader: string | null | undefined): PageSpan {
  if (linkHeader == null || linkHeader.trim() === '') return { kind: 'complete', last: 1 };
  const parts = linkHeader.split(/,(?=\s*<)/);
  let sawNext = false;
  let sawTerminal = false;
  for (const part of parts) {
    if (/rel="next"/.test(part)) sawNext = true;
    if (/rel="prev"/.test(part) || /rel="first"/.test(part)) sawTerminal = true;
    if (!/rel="last"/.test(part)) continue;
    const urlText = /<([^>]+)>/.exec(part)?.[1];
    if (!urlText) return { kind: 'unbounded' };
    let page: number | null = null;
    try {
      const raw = new URL(urlText, GITHUB_API).searchParams.get('page');
      if (raw != null && /^\d+$/.test(raw)) page = Number(raw);
    } catch {
      page = null;
    }
    if (page == null || page < 1 || page > MAX_REPO_PAGES) return { kind: 'unbounded' };
    return { kind: 'complete', last: page };
  }
  if (!sawNext && sawTerminal) return { kind: 'final' };
  return { kind: 'unbounded' };
}

/** GitHub's size is already KB. */
export function toRepoEntry(apiRepo: unknown): RepoEntry | null {
  if (!apiRepo || typeof apiRepo !== 'object') return null;
  const repo = apiRepo as Record<string, unknown>;
  if (repo.archived === true) return null;
  if (typeof repo.full_name !== 'string' || typeof repo.name !== 'string') return null;
  const slash = repo.full_name.indexOf('/');
  if (slash <= 0 || slash !== repo.full_name.lastIndexOf('/')) return null;
  if (repo.full_name.slice(slash + 1) !== repo.name) return null;
  if (typeof repo.private !== 'boolean') return null;
  if (typeof repo.default_branch !== 'string') return null;
  if (typeof repo.size !== 'number' || !Number.isFinite(repo.size)) return null;
  let pushedAt: string | null = null;
  if (repo.pushed_at != null) {
    if (typeof repo.pushed_at !== 'string') return null;
    pushedAt = repo.pushed_at;
  }
  return {
    fullName: repo.full_name,
    name: repo.name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    pushedAt,
    sizeKb: repo.size < 0 ? 0 : repo.size,
  };
}

function pushRank(pushedAt: string | null): number {
  if (pushedAt == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(pushedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function orderRepos(repos: readonly RepoEntry[]): RepoEntry[] {
  return [...repos].sort((a, b) => {
    const delta = pushRank(b.pushedAt) - pushRank(a.pushedAt);
    if (delta !== 0) return delta;
    if (a.fullName < b.fullName) return -1;
    if (a.fullName > b.fullName) return 1;
    return 0;
  });
}

export function mergeRepoEntries(entries: readonly RepoEntry[]): readonly RepoEntry[] {
  const seen = new Set<string>();
  const out: RepoEntry[] = [];
  for (const entry of orderRepos(entries)) {
    if (seen.has(entry.fullName)) continue;
    seen.add(entry.fullName);
    out.push(entry);
  }
  return out;
}

/** A non-array is a group error in the cache. [] is a real empty list. */
export function visibleRepos(body: unknown): readonly RepoEntry[] | null {
  if (!Array.isArray(body)) return null;
  const entries: RepoEntry[] = [];
  for (const item of body) {
    const entry = toRepoEntry(item);
    if (entry) entries.push(entry);
  }
  return mergeRepoEntries(entries);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function httpsGithubUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://github.com/') ? value : null;
}

export function publicOrgStatuses(secret: unknown): Record<string, OrgAccess> {
  if (!secret || typeof secret !== 'object') return {};
  const orgs = (secret as { orgs?: unknown }).orgs;
  if (!orgs || typeof orgs !== 'object' || Array.isArray(orgs)) return {};
  const out: Record<string, OrgAccess> = {};
  for (const [org, raw] of Object.entries(orgs as Record<string, unknown>)) {
    if (!ORG_SLUG.test(org) || !raw || typeof raw !== 'object') continue;
    const status = (raw as { status?: unknown }).status;
    if (status === 'ok') {
      out[org] = { status: 'ok' };
    } else if (status === 'app-policy') {
      out[org] = { status: 'app-policy' };
    } else if (status === 'sso-required') {
      out[org] = { status: 'sso-required', ssoUrl: httpsGithubUrl((raw as { ssoUrl?: unknown }).ssoUrl) };
    } else if (status === 'rate-limited') {
      out[org] = { status: 'rate-limited', retryAfter: isoOrNull((raw as { retryAfter?: unknown }).retryAfter) };
    } else if (status === 'error') {
      out[org] = { status: 'error', retryAfter: isoOrNull((raw as { retryAfter?: unknown }).retryAfter) };
    }
  }
  return out;
}

export function repoOrgs(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  const raw = env.GITHUB_REPO_ORGS;
  if (raw == null || raw.trim() === '') return [...DEFAULT_ORGS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const slug = part.trim();
    if (!ORG_SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out.length ? out : [...DEFAULT_ORGS];
}

/** Zero is kept: the age check never hits. */
export function repoCacheTtlMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.GITHUB_REPO_CACHE_SECONDS;
  if (raw == null || raw.trim() === '') return DEFAULT_TTL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_TTL_MS;
  return seconds * 1000;
}

function orgAccessFromClassify(result: ClassifyResult): OrgAccess {
  switch (result.kind) {
    case 'ok':
      return { status: 'ok' };
    case 'sso-required':
      return { status: 'sso-required', ssoUrl: result.ssoUrl };
    case 'app-policy':
      return { status: 'app-policy' };
    case 'rate-limited':
      return { status: 'rate-limited', retryAfter: result.retryAfter };
    case 'error':
    case 'not-modified':
      return { status: 'error', retryAfter: result.kind === 'error' ? result.retryAfter : null };
    case 'reconnect':
      throw new CredentialInputError(result.code === 'token-type' ? TOKEN_TYPE_SENTENCE : GITHUB_REJECTED_SENTENCE);
  }
}

/**
 * Does not follow Link. A 401 throws and the caller writes nothing.
 * A transport failure on one org is that org's error; the others are still returned.
 */
export async function probeOrgAccess(
  token: string,
  opts?: { fetchImpl?: typeof fetch; now?: number; orgs?: readonly string[] },
): Promise<Record<string, OrgAccess>> {
  const orgs = opts?.orgs ?? repoOrgs();
  const now = opts?.now ?? Date.now();
  const prefix = githubTokenPrefix(token);
  const results = await Promise.all(orgs.map(async (org) => {
    let access: OrgAccess;
    try {
      const res = await githubGet(`${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos?per_page=1`, token, {
        fetchImpl: opts?.fetchImpl,
      });
      access = orgAccessFromClassify(classifyGithubResponse({
        status: res.status,
        headers: res.headers,
        body: res.body,
        tokenPrefix: prefix,
        group: 'org',
        now,
      }));
    } catch (err) {
      if (err instanceof CredentialInputError) throw err;
      access = { status: 'error', retryAfter: null };
    }
    return [org, access] as const;
  }));
  return Object.fromEntries(results);
}
