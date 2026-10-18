/**
 * A generation so forget wins over a refresh that already started.
 * The route answers 503 when the credential store is off; this module does not.
 */

import { createHash } from 'crypto';
import { githubGet, GITHUB_API } from './githubCredential';
import { onGithubCredentialChange, readGithubAccess } from './credentialStore';
import {
  classifyGithubResponse,
  githubTokenPrefix,
  mergeRepoEntries,
  pagesFromLink,
  RECONNECT_SENTENCE,
  repoCacheTtlMs,
  repoOrgs,
  TOKEN_TYPE_SENTENCE,
  visibleRepos,
  type GithubTokenPrefix,
  type RepoEntry,
  type RepoGroup,
  type RepoList,
} from './githubRepos';

interface StoredPage {
  readonly etag: string | null;
  readonly repos: readonly RepoEntry[];
}

type StoredStatus = 'ok' | 'sso-required' | 'app-policy' | 'rate-limited' | 'error';

interface StoredGroup {
  readonly owner: string;
  readonly kind: 'user' | 'org';
  readonly status: StoredStatus;
  readonly ssoUrl: string | null;
  readonly retryAfter: string | null;
  readonly pageCount: number;
  readonly pages: ReadonlyMap<number, StoredPage>;
}

interface StoredListing {
  /** Never copied onto RepoList. */
  readonly fingerprint: string;
  readonly fetchedAt: number;
  readonly groups: readonly StoredGroup[];
}

interface GroupSpec {
  readonly owner: string;
  readonly kind: 'user' | 'org';
}

export interface RepoCacheDeps {
  fetchImpl: typeof fetch;
  now(): number;
  loadAccess(userId: string): Promise<{ token: string; login: string } | null>;
  orgs: readonly string[];
  ttlMs: number;
}

export interface RepoCache {
  getRepos(userId: string, opts: { refresh: boolean }): Promise<RepoList>;
  forget(userId: string): void;
}

const PER_PAGE = 100;

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function listUrl(spec: GroupSpec, page: number): string {
  if (spec.kind === 'user') {
    return `${GITHUB_API}/user/repos?affiliation=owner&per_page=${PER_PAGE}&page=${page}`;
  }
  return `${GITHUB_API}/orgs/${encodeURIComponent(spec.owner)}/repos?per_page=${PER_PAGE}&page=${page}`;
}

function emptyPages(): ReadonlyMap<number, StoredPage> {
  return new Map();
}

function flatten(pages: ReadonlyMap<number, StoredPage>): RepoEntry[] {
  const out: RepoEntry[] = [];
  for (const n of [...pages.keys()].sort((a, b) => a - b)) out.push(...pages.get(n)!.repos);
  return out;
}

/**
 * Pages accepted in this request win, including a first load whose previous
 * group is empty. A failure before any page is accepted keeps the stored group.
 */
function keepLast(
  prev: StoredGroup | undefined,
  spec: GroupSpec,
  status: 'error' | 'rate-limited',
  retryAfter: string | null,
  fetched?: { pages: ReadonlyMap<number, StoredPage>; end: number },
): StoredGroup {
  if (fetched && fetched.pages.size > 0) {
    let pageCount = fetched.end;
    for (const n of fetched.pages.keys()) if (n > pageCount) pageCount = n;
    return { owner: spec.owner, kind: spec.kind, status, ssoUrl: null, retryAfter, pageCount, pages: fetched.pages };
  }
  if (!prev || prev.pages.size === 0) {
    return { owner: spec.owner, kind: spec.kind, status, ssoUrl: null, retryAfter, pageCount: 0, pages: emptyPages() };
  }
  return { owner: spec.owner, kind: spec.kind, status, ssoUrl: null, retryAfter, pageCount: prev.pageCount, pages: prev.pages };
}

function denied(spec: GroupSpec, status: 'sso-required' | 'app-policy', ssoUrl: string | null): StoredGroup {
  return { owner: spec.owner, kind: spec.kind, status, ssoUrl, retryAfter: null, pageCount: 0, pages: emptyPages() };
}

function okGroup(spec: GroupSpec, pageCount: number, pages: ReadonlyMap<number, StoredPage>): StoredGroup {
  return { owner: spec.owner, kind: spec.kind, status: 'ok', ssoUrl: null, retryAfter: null, pageCount, pages };
}

/**
 * Blank Link on a 200 is one page. Blank Link on a 304 keeps the stored span,
 * because GitHub often omits Link when the representation is unchanged.
 * A present Link can grow or shrink that span, including on a later 304.
 */
function endFromLink(
  page: number,
  link: string | undefined,
  end: number,
  absent: 'one-page' | 'keep',
): { end: number } | { fail: true } {
  const present = link != null && link.trim() !== '';
  if (!present && absent === 'keep') return { end };
  const span = pagesFromLink(link);
  if (page === 1) {
    if (span.kind === 'unbounded') return { fail: true };
    return { end: span.kind === 'complete' ? span.last : end };
  }
  if (present && span.kind === 'unbounded') return { fail: true };
  if (present && span.kind === 'complete' && span.last < page) return { fail: true };
  if (present && span.kind === 'complete' && span.last > end) return { end: span.last };
  return { end };
}

function toGroup(group: StoredGroup, forceError: boolean): RepoGroup {
  const status = forceError ? 'error' : group.status;
  const retryAfter = forceError ? null : group.retryAfter;
  const repos = status === 'sso-required' || status === 'app-policy' ? [] : mergeRepoEntries(flatten(group.pages));
  if (group.kind === 'user') {
    if (status === 'rate-limited' || status === 'error') {
      return { owner: group.owner, kind: 'user', status, retryAfter, repos };
    }
    return { owner: group.owner, kind: 'user', status: 'ok', repos };
  }
  if (status === 'sso-required') return { owner: group.owner, kind: 'org', status, ssoUrl: group.ssoUrl, repos: [] };
  if (status === 'app-policy') return { owner: group.owner, kind: 'org', status, repos: [] };
  if (status === 'rate-limited') return { owner: group.owner, kind: 'org', status, retryAfter, repos };
  if (status === 'error') return { owner: group.owner, kind: 'org', status, retryAfter, repos };
  return { owner: group.owner, kind: 'org', status: 'ok', repos };
}

function project(listing: StoredListing, forceError: boolean): RepoList {
  return { status: 'ok', groups: listing.groups.map(group => toGroup(group, forceError)) };
}

/** The login is inside the secret we could not open, so the user group's owner is blank. */
function coldError(orgs: readonly string[]): RepoList {
  return {
    status: 'ok',
    groups: [
      { owner: '', kind: 'user', status: 'error', retryAfter: null, repos: [] },
      ...orgs.map((owner): RepoGroup => ({ owner, kind: 'org', status: 'error', retryAfter: null, repos: [] })),
    ],
  };
}

function unauthorized(): RepoList {
  return { status: 'reconnect', reconnect: { code: 'unauthorized', sentence: RECONNECT_SENTENCE }, groups: [] };
}

function tokenType(): RepoList {
  return { status: 'reconnect', reconnect: { code: 'token-type', sentence: TOKEN_TYPE_SENTENCE }, groups: [] };
}

export function createRepoCache(deps: RepoCacheDeps): RepoCache {
  const listings = new Map<string, StoredListing>();
  const inflight = new Map<string, Promise<RepoList>>();
  const generations = new Map<string, number>();

  function current(userId: string): number {
    return generations.get(userId) ?? 0;
  }

  async function fetchPage(spec: GroupSpec, page: number, etag: string | undefined, token: string) {
    try {
      return await githubGet(listUrl(spec, page), token, { etag, fetchImpl: deps.fetchImpl });
    } catch {
      return 'thrown' as const;
    }
  }

  async function loadGroup(
    spec: GroupSpec,
    token: string,
    prefix: GithubTokenPrefix,
    prev: StoredGroup | undefined,
    now: number,
  ): Promise<{ reconnect: true } | { reconnect: false; group: StoredGroup }> {
    const classify = (status: number, headers: Readonly<Record<string, string>>, body: unknown) => classifyGithubResponse({
      status, headers, body, tokenPrefix: prefix, group: spec.kind, now,
    });

    let fetchedPages: Map<number, StoredPage> | null = null;
    let fetchedEnd = 1;

    const applyFailure = (
      kind: 'rate-limited' | 'error' | 'sso-required' | 'app-policy',
      retryAfter: string | null,
      ssoUrl: string | null,
    ): { reconnect: false; group: StoredGroup } => {
      if (kind === 'sso-required' && spec.kind === 'org') return { reconnect: false, group: denied(spec, 'sso-required', ssoUrl) };
      if (kind === 'app-policy' && spec.kind === 'org') return { reconnect: false, group: denied(spec, 'app-policy', null) };
      const fetched = fetchedPages && fetchedPages.size > 0 ? { pages: fetchedPages, end: fetchedEnd } : undefined;
      if (kind === 'rate-limited') return { reconnect: false, group: keepLast(prev, spec, 'rate-limited', retryAfter, fetched) };
      return { reconnect: false, group: keepLast(prev, spec, 'error', retryAfter, fetched) };
    };

    const acceptPage = (
      page: number,
      link: string | undefined,
      body: unknown,
      etag: string | null,
      pages: Map<number, StoredPage>,
      end: number,
    ): { end: number } | { fail: true } => {
      // Blank Link is one page. On a later page that would deny the bytes just
      // received, so only a present Link can fail or extend the span there.
      // A final page (rel="first" / rel="prev", no rel="last") is that end.
      const updated = endFromLink(page, link, end, 'one-page');
      if ('fail' in updated) return { fail: true };
      const repos = visibleRepos(body);
      if (repos == null) return { fail: true };
      pages.set(page, { etag, repos });
      return { end: updated.end };
    };

    try {
      const first = await fetchPage(spec, 1, prev?.pages.get(1)?.etag ?? undefined, token);
      if (first === 'thrown') return applyFailure('error', null, null);
      const firstClass = classify(first.status, first.headers, first.body);
      if (firstClass.kind === 'reconnect') return { reconnect: true };
      if (firstClass.kind === 'rate-limited') return applyFailure('rate-limited', firstClass.retryAfter, null);
      if (firstClass.kind === 'error') return applyFailure('error', firstClass.retryAfter, null);
      if (firstClass.kind === 'sso-required') return applyFailure('sso-required', null, firstClass.ssoUrl);
      if (firstClass.kind === 'app-policy') return applyFailure('app-policy', null, null);

      const pages = new Map<number, StoredPage>();
      fetchedPages = pages;
      let end = 1;
      if (firstClass.kind === 'not-modified') {
        const page1 = prev?.pages.get(1);
        if (!page1) return applyFailure('error', null, null);
        const updated = endFromLink(1, first.headers.link, prev!.pageCount || 1, 'keep');
        if ('fail' in updated) return applyFailure('error', null, null);
        pages.set(1, page1);
        end = updated.end;
        fetchedEnd = end;
        for (const [n, page] of prev!.pages) if (n !== 1 && n <= end) pages.set(n, page);
      } else {
        const accepted = acceptPage(1, first.headers.link, first.body, first.etag, pages, 1);
        if ('fail' in accepted) return applyFailure('error', null, null);
        end = accepted.end;
        fetchedEnd = end;
      }

      let cursor = 2;
      while (cursor <= end) {
        const nums: number[] = [];
        for (let n = cursor; n <= end; n++) nums.push(n);
        const batch = await Promise.all(nums.map(n => fetchPage(spec, n, prev?.pages.get(n)?.etag ?? undefined, token)));
        for (let i = 0; i < nums.length; i++) {
          const n = nums[i]!;
          const res = batch[i]!;
          if (res === 'thrown') return applyFailure('error', null, null);
          const classified = classify(res.status, res.headers, res.body);
          if (classified.kind === 'reconnect') return { reconnect: true };
          if (classified.kind === 'not-modified') {
            const kept = prev?.pages.get(n);
            if (!kept) return applyFailure('error', null, null);
            const updated = endFromLink(n, res.headers.link, end, 'keep');
            if ('fail' in updated) return applyFailure('error', null, null);
            pages.set(n, kept);
            end = updated.end;
            fetchedEnd = end;
            continue;
          }
          if (classified.kind === 'ok') {
            const accepted = acceptPage(n, res.headers.link, res.body, res.etag, pages, end);
            if ('fail' in accepted) return applyFailure('error', null, null);
            end = accepted.end;
            fetchedEnd = end;
            continue;
          }
          if (classified.kind === 'rate-limited') return applyFailure('rate-limited', classified.retryAfter, null);
          if (classified.kind === 'sso-required') return applyFailure('sso-required', null, classified.ssoUrl);
          if (classified.kind === 'app-policy') return applyFailure('app-policy', null, null);
          return applyFailure('error', classified.retryAfter, null);
        }
        cursor = nums[nums.length - 1]! + 1;
      }
      return { reconnect: false, group: okGroup(spec, end, pages) };
    } catch {
      return applyFailure('error', null, null);
    }
  }

  async function run(userId: string, refresh: boolean, generation: number): Promise<RepoList> {
    let access: { token: string; login: string } | null;
    try {
      access = await deps.loadAccess(userId);
    } catch {
      // A decrypt or KMS throw is not reconnect, and it must not replace the cached list.
      const prev = listings.get(userId);
      return prev ? project(prev, true) : coldError(deps.orgs);
    }
    if (!access) {
      if (current(userId) === generation) listings.delete(userId);
      return unauthorized();
    }
    const prefix = githubTokenPrefix(access.token);
    if (prefix === 'ghu') {
      if (current(userId) === generation) listings.delete(userId);
      return tokenType();
    }
    if (prefix !== 'gho' && prefix !== 'ghp' && prefix !== 'github_pat') {
      if (current(userId) === generation) listings.delete(userId);
      return unauthorized();
    }
    const fp = fingerprint(access.token);
    const prev = listings.get(userId);
    const same = prev && prev.fingerprint === fp ? prev : undefined;
    if (same && !refresh && deps.ttlMs > 0 && deps.now() - same.fetchedAt < deps.ttlMs) return project(same, false);

    const now = deps.now();
    const token = access.token;
    const specs: GroupSpec[] = [
      { kind: 'user', owner: access.login },
      ...deps.orgs.map(owner => ({ kind: 'org' as const, owner })),
    ];
    const loaded = await Promise.all(specs.map(spec => {
      const previous = same?.groups.find(group => group.kind === spec.kind && group.owner === spec.owner);
      return loadGroup(spec, token, prefix, previous, now);
    }));
    if (loaded.some(item => item.reconnect)) {
      if (current(userId) === generation) listings.delete(userId);
      return unauthorized();
    }
    const listing: StoredListing = {
      fingerprint: fp,
      fetchedAt: deps.now(),
      groups: loaded.map(item => (item as { reconnect: false; group: StoredGroup }).group),
    };
    if (current(userId) === generation) listings.set(userId, listing);
    return project(listing, false);
  }

  function getRepos(userId: string, opts: { refresh: boolean }): Promise<RepoList> {
    const existing = inflight.get(userId);
    if (existing) return existing;
    const generation = current(userId);
    const promise = run(userId, opts.refresh, generation).finally(() => {
      if (inflight.get(userId) === promise) inflight.delete(userId);
    });
    inflight.set(userId, promise);
    return promise;
  }

  function forget(userId: string): void {
    generations.set(userId, current(userId) + 1);
    listings.delete(userId);
    inflight.delete(userId);
  }

  return { getRepos, forget };
}

export const repoCache: RepoCache = createRepoCache({
  fetchImpl: fetch,
  now: () => Date.now(),
  loadAccess: readGithubAccess,
  orgs: repoOrgs(),
  ttlMs: repoCacheTtlMs(),
});

onGithubCredentialChange(userId => { repoCache.forget(userId); });
