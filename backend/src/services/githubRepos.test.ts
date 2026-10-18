import { describe, expect, it } from 'vitest';
import {
  classifyGithubResponse,
  mergeRepoEntries,
  pagesFromLink,
  publicOrgStatuses,
  repoCacheTtlMs,
  repoOrgs,
  toRepoEntry,
  visibleRepos,
  type ClassifyInput,
  type ClassifyResult,
  type RepoEntry,
} from './githubRepos';

const NOW = 1_700_000_000_000;
const PLUS_60 = '2023-11-14T22:14:20.000Z';
const SSO = 'required; url=https://github.com/orgs/example-org/sso?authorization_request=1';
const SSO_URL = 'https://github.com/orgs/example-org/sso?authorization_request=1';
const SENTINEL = 'gho_SENTINELsentinelSENTINEL0123456789';

function input(over: Partial<ClassifyInput> & Pick<ClassifyInput, 'status'>): ClassifyInput {
  return {
    headers: {},
    body: { message: 'secret prose' },
    tokenPrefix: 'gho',
    group: 'org',
    now: NOW,
    ...over,
  };
}

function expectClass(over: Partial<ClassifyInput> & Pick<ClassifyInput, 'status'>, expected: ClassifyResult) {
  const got = classifyGithubResponse(input(over));
  expect(got).not.toBeUndefined();
  expect(got).toEqual(expected);
  expect(JSON.stringify(got)).not.toContain('secret prose');
  expect(JSON.stringify(got)).not.toContain(SENTINEL);
}

describe('classifyGithubResponse', () => {
  it('follows the classification order with literal results', () => {
    expectClass(
      { status: 200, tokenPrefix: 'ghu', headers: { 'x-ratelimit-remaining': '0' } },
      { kind: 'reconnect', code: 'token-type' },
    );
    expectClass({ status: 200, tokenPrefix: 'github_pat' }, { kind: 'ok' });
    expectClass({ status: 401, tokenPrefix: 'ghu' }, { kind: 'reconnect', code: 'token-type' });
    expectClass(
      { status: 401, headers: { 'x-github-sso': SSO } },
      { kind: 'reconnect', code: 'unauthorized' },
    );
    expectClass(
      { status: 304, headers: { 'retry-after': '60' } },
      { kind: 'not-modified' },
    );
    expectClass(
      { status: 200, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' } },
      { kind: 'ok' },
    );
    expectClass({ status: 429 }, { kind: 'rate-limited', retryAfter: null });
    expectClass(
      { status: 429, headers: { 'retry-after': '60' } },
      { kind: 'rate-limited', retryAfter: PLUS_60 },
    );
    expectClass(
      { status: 429, headers: { 'retry-after': 'Tue, 14 Nov 2023 22:14:20 GMT' } },
      { kind: 'rate-limited', retryAfter: PLUS_60 },
    );
    expectClass(
      { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1700000060' } },
      { kind: 'rate-limited', retryAfter: PLUS_60 },
    );
    expectClass(
      { status: 403, headers: { 'retry-after': '60', 'x-github-sso': SSO } },
      { kind: 'rate-limited', retryAfter: PLUS_60 },
    );
    expectClass(
      { status: 403, headers: { 'retry-after': 'nope', 'x-ratelimit-reset': '1700000060' } },
      { kind: 'rate-limited', retryAfter: PLUS_60 },
    );
    expectClass(
      { status: 429, headers: { 'retry-after': 'nope' } },
      { kind: 'rate-limited', retryAfter: null },
    );
    expectClass(
      { status: 403, headers: { 'x-github-sso': SSO } },
      { kind: 'sso-required', ssoUrl: SSO_URL },
    );
    expectClass(
      { status: 404, headers: { 'X-GitHub-SSO': `${SSO};` } },
      { kind: 'sso-required', ssoUrl: SSO_URL },
    );
    expectClass(
      { status: 403, headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=1,' } },
      { kind: 'sso-required', ssoUrl: 'https://github.com/orgs/acme/sso?authorization_request=1' },
    );
    expectClass(
      { status: 403, headers: { 'x-github-sso': 'required; url=http://github.com/orgs/example-org/sso' } },
      { kind: 'sso-required', ssoUrl: null },
    );
    expectClass(
      { status: 404, headers: { 'x-github-sso': 'required' } },
      { kind: 'sso-required', ssoUrl: null },
    );
    expectClass(
      { status: 403, group: 'user', headers: { 'x-github-sso': SSO } },
      { kind: 'error', retryAfter: null },
    );
    expectClass(
      { status: 404, group: 'user', headers: { 'x-github-sso': SSO } },
      { kind: 'error', retryAfter: null },
    );
    expectClass(
      { status: 403, headers: { 'x-github-sso': 'partial-results; organizations=21955855' } },
      { kind: 'app-policy' },
    );
    expectClass({ status: 403 }, { kind: 'app-policy' });
    expectClass({ status: 403, group: 'user' }, { kind: 'error', retryAfter: null });
    expectClass(
      { status: 503, headers: { 'retry-after': '60' } },
      { kind: 'error', retryAfter: PLUS_60 },
    );
    expectClass({ status: 500 }, { kind: 'error', retryAfter: null });
    expectClass({ status: 599 }, { kind: 'error', retryAfter: null });
    expectClass({ status: 404 }, { kind: 'error', retryAfter: null });
    expectClass({ status: 418 }, { kind: 'error', retryAfter: null });
  });
});

describe('pagesFromLink', () => {
  it('treats a missing header as one page and reads rel=last', () => {
    expect(pagesFromLink(null)).toEqual({ kind: 'complete', last: 1 });
    expect(pagesFromLink(undefined)).toEqual({ kind: 'complete', last: 1 });
    expect(pagesFromLink('')).toEqual({ kind: 'complete', last: 1 });
    expect(pagesFromLink('   ')).toEqual({ kind: 'complete', last: 1 });
    expect(pagesFromLink('<https://api.github.com/orgs/example-org/repos?page=14&per_page=100>; rel="last"'))
      .toEqual({ kind: 'complete', last: 14 });
    expect(pagesFromLink(
      '<https://api.github.com/user/repos?page=9&per_page=100>; rel="next", <https://api.github.com/user/repos?per_page=100&page=2>; rel="last"',
    )).toEqual({ kind: 'complete', last: 2 });
    expect(pagesFromLink('<https://api.github.com/user/repos?page=50&per_page=100>; rel="last"'))
      .toEqual({ kind: 'complete', last: 50 });
  });

  it('treats a final page of first and prev, with no rel=last, as the end', () => {
    expect(pagesFromLink(
      '<https://api.github.com/orgs/example-org/repos?page=1&per_page=100>; rel="first", <https://api.github.com/orgs/example-org/repos?page=13&per_page=100>; rel="prev"',
    )).toEqual({ kind: 'final' });
    expect(pagesFromLink('<https://api.github.com/orgs/example-org/repos?page=13&per_page=100>; rel="prev"'))
      .toEqual({ kind: 'final' });
  });

  it('is unbounded when rel=last is missing or past 50', () => {
    expect(pagesFromLink('<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"'))
      .toEqual({ kind: 'unbounded' });
    expect(pagesFromLink(
      '<https://api.github.com/user/repos?page=1&per_page=100>; rel="prev", <https://api.github.com/user/repos?page=3&per_page=100>; rel="next"',
    )).toEqual({ kind: 'unbounded' });
    expect(pagesFromLink('<https://api.github.com/user/repos?page=51&per_page=100>; rel="last"'))
      .toEqual({ kind: 'unbounded' });
    expect(pagesFromLink('<https://api.github.com/user/repos?page=0&per_page=100>; rel="last"'))
      .toEqual({ kind: 'unbounded' });
    expect(pagesFromLink('not a link')).toEqual({ kind: 'unbounded' });
  });
});

function apiRepo(name: string, pushedAt: string | null, extra: Record<string, unknown> = {}) {
  return {
    full_name: `octocat/${name}`,
    name,
    private: true,
    default_branch: 'main',
    size: 12,
    pushed_at: pushedAt,
    archived: false,
    ...extra,
  };
}

function entry(name: string, pushedAt: string | null, extra: Partial<RepoEntry> = {}): RepoEntry {
  return {
    fullName: `octocat/${name}`,
    name,
    defaultBranch: 'main',
    private: true,
    pushedAt,
    sizeKb: 12,
    ...extra,
  };
}

describe('visibleRepos', () => {
  it('drops archived repos, dedupes, and sorts pushedAt descending with nulls last', () => {
    expect(toRepoEntry(apiRepo('gone', '2024-01-01T00:00:00Z', { archived: true }))).toBeNull();
    expect(toRepoEntry(apiRepo('neg', '2024-01-01T00:00:00Z', { size: -4 }))).toEqual(entry('neg', '2024-01-01T00:00:00Z', { sizeKb: 0 }));
    expect(toRepoEntry(apiRepo('nope', '2024-01-01T00:00:00Z', { private: 'yes' }))).toBeNull();
    expect(toRepoEntry(apiRepo('nope', '2024-01-01T00:00:00Z', { full_name: 'octocat/other' }))).toBeNull();
    expect(toRepoEntry(null)).toBeNull();
    expect(visibleRepos({ message: 'nope' })).toBeNull();
    expect(visibleRepos([])).toEqual([]);
    expect(visibleRepos([
      apiRepo('b', '2020-01-01T00:00:00Z'),
      apiRepo('a', null),
      apiRepo('c', '2024-01-01T00:00:00Z'),
      apiRepo('b', '2020-01-01T00:00:00Z'),
      apiRepo('old', '2019-01-01T00:00:00Z', { archived: true }),
      apiRepo('d', 'not-a-date'),
      apiRepo('e', '2024-01-01T00:00:00Z'),
    ])).toEqual([
      entry('c', '2024-01-01T00:00:00Z'),
      entry('e', '2024-01-01T00:00:00Z'),
      entry('b', '2020-01-01T00:00:00Z'),
      entry('a', null),
      entry('d', 'not-a-date'),
    ]);
  });

  it('keeps the newer duplicate when fullNames collide', () => {
    expect(mergeRepoEntries([
      entry('a', '2020-01-01T00:00:00Z'),
      entry('a', '2024-01-01T00:00:00Z'),
    ])).toEqual([entry('a', '2024-01-01T00:00:00Z')]);
  });
});

describe('repoOrgs and cache ttl', () => {
  it('defaults, drops bad slugs, and dedupes', () => {
    expect(repoOrgs({})).toEqual([]);
    expect(repoOrgs({ GITHUB_REPO_ORGS: '' })).toEqual([]);
    expect(repoOrgs({ GITHUB_REPO_ORGS: '   ' })).toEqual([]);
    expect(repoOrgs({ GITHUB_REPO_ORGS: 'acme, bad slug, acme, -nope, example-team' }))
      .toEqual(['acme', 'example-team']);
    expect(repoOrgs({ GITHUB_REPO_ORGS: '!!!, ???' })).toEqual([]);
  });

  it('keeps zero and replaces junk with 600 seconds', () => {
    expect(repoCacheTtlMs({})).toBe(600_000);
    expect(repoCacheTtlMs({ GITHUB_REPO_CACHE_SECONDS: '0' })).toBe(0);
    expect(repoCacheTtlMs({ GITHUB_REPO_CACHE_SECONDS: '600' })).toBe(600_000);
    expect(repoCacheTtlMs({ GITHUB_REPO_CACHE_SECONDS: '-1' })).toBe(600_000);
    expect(repoCacheTtlMs({ GITHUB_REPO_CACHE_SECONDS: 'nope' })).toBe(600_000);
    expect(repoCacheTtlMs({ GITHUB_REPO_CACHE_SECONDS: '' })).toBe(600_000);
  });
});

describe('publicOrgStatuses', () => {
  it('drops the token and invalid urls', () => {
    const got = publicOrgStatuses({
      token: SENTINEL,
      orgs: {
        'example-org': { status: 'sso-required', ssoUrl: 'http://evil.example/sso' },
        acme: { status: 'ok', token: SENTINEL },
        bad: { status: 'nope' },
        beta: { status: 'error', retryAfter: SENTINEL },
      },
    });
    expect(got).toEqual({
      'example-org': { status: 'sso-required', ssoUrl: null },
      acme: { status: 'ok' },
      beta: { status: 'error', retryAfter: null },
    });
    expect(JSON.stringify(got)).not.toContain(SENTINEL);
    expect(publicOrgStatuses(null)).toEqual({});
    expect(publicOrgStatuses({ token: SENTINEL })).toEqual({});
  });
});
