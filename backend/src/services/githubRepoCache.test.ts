import { describe, expect, it, vi } from 'vitest';
import { createRepoCache } from './githubRepoCache';
import type { RepoEntry, RepoList } from './githubRepos';

const TOKEN = 'gho_SENTINELsentinelSENTINEL0123456789';
const PAT = 'github_pat_11AAAAAAA0123456789abcdef';
const NOW = 1_700_000_000_000;
const PLUS_60 = '2023-11-14T22:14:20.000Z';

function apiRepo(owner: string, name: string, pushedAt: string) {
  return {
    full_name: `${owner}/${name}`,
    name,
    private: true,
    default_branch: 'main',
    archived: false,
    pushed_at: pushedAt,
    size: 12,
  };
}

function entry(owner: string, name: string, pushedAt: string): RepoEntry {
  return {
    fullName: `${owner}/${name}`,
    name,
    defaultBranch: 'main',
    private: true,
    pushedAt,
    sizeKb: 12,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get('page') ?? '1');
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function harness(opts: {
  token?: string;
  login?: string;
  orgs?: readonly string[];
  ttlMs?: number;
  loadAccess?: () => Promise<{ token: string; login: string } | null>;
  fetchImpl: typeof fetch;
}) {
  const token = opts.token ?? TOKEN;
  let now = NOW;
  const cache = createRepoCache({
    fetchImpl: opts.fetchImpl,
    now: () => now,
    loadAccess: opts.loadAccess ?? (async () => ({ token, login: opts.login ?? 'octocat' })),
    orgs: opts.orgs ?? [],
    ttlMs: opts.ttlMs ?? 600_000,
  });
  return {
    cache,
    token,
    setNow: (n: number) => { now = n; },
    async list(refresh = false): Promise<RepoList> {
      const body = await cache.getRepos('user-1', { refresh });
      expect(JSON.stringify(body)).not.toContain(token);
      return body;
    },
  };
}

describe('createRepoCache', () => {
  it('fetches the pages named by rel=last in parallel and drops archived repos', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let bothStarted!: () => void;
    const both = new Promise<void>(resolve => { bothStarted = resolve; });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      const page = pageOf(url);
      const link = '<https://api.github.com/user/repos?page=9&per_page=100>; rel="next", <https://api.github.com/user/repos?page=3&per_page=100>; rel="last"';
      if (page === 1) {
        return json(200, [
          { ...apiRepo('octocat', 'old', '2019-01-01T00:00:00Z'), archived: true },
          apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z'),
        ], { etag: '"p1"', link });
      }
      started += 1;
      if (started === 2) bothStarted();
      await gate;
      const name = page === 2 ? 'alpha' : 'gamma';
      const pushed = page === 2 ? '2024-06-01T00:00:00Z' : '2023-01-01T00:00:00Z';
      return json(200, [apiRepo('octocat', name, pushed)], { etag: `"p${page}"`, link });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = list(true);
    try {
      await Promise.race([
        both,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pages were not fetched in parallel')), 500)),
      ]);
    } finally {
      release();
    }
    expect(await pending).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [
          entry('octocat', 'alpha', '2024-06-01T00:00:00Z'),
          entry('octocat', 'gamma', '2023-01-01T00:00:00Z'),
          entry('octocat', 'beta', '2020-01-01T00:00:00Z'),
        ],
      }],
    });
    expect(urls.some(url => url.includes('page=9'))).toBe(false);
    expect(urls.filter(url => url.includes('page=2'))).toHaveLength(1);
    expect(urls.filter(url => url.includes('page=3'))).toHaveLength(1);
    expect(urls[0]).toContain('affiliation=owner');
    expect(urls[0]).toContain('per_page=100');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)).not.toBeInstanceOf(Headers);
  });

  it('keeps repos when page 1 is 304', async () => {
    let hits = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = headersOf(init);
      if (headers['If-None-Match'] === '"p1"') return new Response(null, { status: 304, headers: { etag: '"p1"' } });
      hits += 1;
      return json(200, [apiRepo('octocat', `r${hits}`, '2024-01-01T00:00:00Z')], { etag: '"p1"' });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const first = await list(true);
    const second = await list(true);
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [entry('octocat', 'r1', '2024-01-01T00:00:00Z')],
      }],
    });
    expect(headersOf(fetchImpl.mock.calls[1]?.[1] as RequestInit)['If-None-Match']).toBe('"p1"');
  });

  it('keeps the last repos when an org is rate-limited', async () => {
    let orgCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/user/repos')) return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
      orgCalls += 1;
      if (orgCalls === 1) return json(200, [apiRepo('example-org', 'secret', '2024-03-01T00:00:00Z')]);
      return json(403, { message: 'rate' }, { 'x-ratelimit-remaining': '0', 'retry-after': '60' });
    });
    const { list } = harness({ orgs: ['example-org'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [
        { owner: 'octocat', kind: 'user', status: 'ok', repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')] },
        {
          owner: 'example-org',
          kind: 'org',
          status: 'rate-limited',
          retryAfter: PLUS_60,
          repos: [entry('example-org', 'secret', '2024-03-01T00:00:00Z')],
        },
      ],
    });
  });

  it('drops an org\'s repos when access becomes SSO', async () => {
    let orgCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/user/repos')) return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
      orgCalls += 1;
      if (orgCalls === 1) return json(200, [apiRepo('example-org', 'secret', '2024-03-01T00:00:00Z')]);
      return json(403, { message: 'sso' }, {
        'x-github-sso': 'required; url=https://github.com/orgs/example-org/sso?authorization_request=1',
      });
    });
    const { list } = harness({ orgs: ['example-org'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [
        { owner: 'octocat', kind: 'user', status: 'ok', repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')] },
        {
          owner: 'example-org',
          kind: 'org',
          status: 'sso-required',
          ssoUrl: 'https://github.com/orgs/example-org/sso?authorization_request=1',
          repos: [],
        },
      ],
    });
  });

  it('returns reconnect and empty groups on 401', async () => {
    let deny = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (deny && url.includes('/user/repos')) return json(401, { message: 'bad' });
      if (url.includes('/orgs/')) return json(200, [apiRepo('example-org', 'secret', '2024-03-01T00:00:00Z')]);
      return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
    });
    const { list } = harness({ orgs: ['example-org'], fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    deny = true;
    expect(await list(true)).toEqual({
      status: 'reconnect',
      reconnect: { code: 'unauthorized', sentence: 'Reconnect GitHub in Settings' },
      groups: [],
    });
    deny = false;
    const calls = fetchImpl.mock.calls.length;
    const again = await list(false);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.groups[0]).toMatchObject({ owner: 'octocat', repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')] });
  });

  it('does not call GitHub for a legacy github_pat_ token', async () => {
    const fetchImpl = vi.fn();
    const { list } = harness({
      token: PAT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await list(true)).toEqual({
      status: 'reconnect',
      reconnect: {
        code: 'token-type',
        sentence: 'This token type sees one owner only; paste the output of `gh auth token`',
      },
      groups: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is not the module that answers 503 when the store is off', async () => {
    const fetchImpl = vi.fn();
    const { list } = harness({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadAccess: async () => null,
      orgs: ['example-org'],
    });
    expect(await list(false)).toEqual({
      status: 'reconnect',
      reconnect: { code: 'unauthorized', sentence: 'Reconnect GitHub in Settings' },
      groups: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the last list when the secret cannot be opened and does not store that failure', async () => {
    let fail = false;
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches += 1;
      return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
    });
    const { list } = harness({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadAccess: async () => {
        if (fail) throw new Error('The credential store is not configured on this orchestrator.');
        return { token: TOKEN, login: 'octocat' };
      },
    });
    await list(true);
    expect(fetches).toBe(1);
    fail = true;
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'error',
        retryAfter: null,
        repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')],
      }],
    });
    expect(fetches).toBe(1);
    fail = false;
    expect(await list(false)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')],
      }],
    });
    expect(fetches).toBe(1);
  });

  it('shares one in-flight refresh and does not refill the list after forget', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches += 1;
      await gate;
      return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
    });
    const { cache, list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const first = cache.getRepos('user-1', { refresh: true });
    const second = cache.getRepos('user-1', { refresh: false });
    expect(second).toBe(first);
    release();
    const body = await first;
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(await second).toEqual(body);
    expect(fetches).toBe(1);

    let release2!: () => void;
    const gate2 = new Promise<void>(resolve => { release2 = resolve; });
    fetchImpl.mockImplementation(async () => {
      fetches += 1;
      await gate2;
      return json(200, [apiRepo('octocat', 'other', '2024-08-01T00:00:00Z')]);
    });
    const late = list(true);
    await vi.waitFor(() => expect(fetches).toBe(2));
    cache.forget('user-1');
    release2();
    expect((await late).status).toBe('ok');
    fetches = 0;
    fetchImpl.mockImplementation(async () => {
      fetches += 1;
      return json(200, [apiRepo('octocat', 'fresh', '2025-01-01T00:00:00Z')]);
    });
    const again = await list(false);
    expect(fetches).toBe(1);
    expect(again).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [entry('octocat', 'fresh', '2025-01-01T00:00:00Z')],
      }],
    });
  });

  it('keeps an org\'s repos when the final page omits rel=last', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const page = pageOf(url);
      if (url.includes('/user/repos')) return json(200, [apiRepo('octocat', 'mine', '2024-02-01T00:00:00Z')]);
      if (page === 1) {
        return json(200, [apiRepo('example-org', 'beta', '2020-01-01T00:00:00Z')], {
          link: '<https://api.github.com/orgs/example-org/repos?page=2&per_page=100>; rel="next", <https://api.github.com/orgs/example-org/repos?page=2&per_page=100>; rel="last"',
        });
      }
      return json(200, [apiRepo('example-org', 'alpha', '2024-01-01T00:00:00Z')], {
        link: '<https://api.github.com/orgs/example-org/repos?page=1&per_page=100>; rel="first", <https://api.github.com/orgs/example-org/repos?page=1&per_page=100>; rel="prev"',
      });
    });
    const { list } = harness({ orgs: ['example-org'], fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [
        { owner: 'octocat', kind: 'user', status: 'ok', repos: [entry('octocat', 'mine', '2024-02-01T00:00:00Z')] },
        {
          owner: 'example-org',
          kind: 'org',
          status: 'ok',
          repos: [
            entry('example-org', 'alpha', '2024-01-01T00:00:00Z'),
            entry('example-org', 'beta', '2020-01-01T00:00:00Z'),
          ],
        },
      ],
    });
  });

  it('keeps the last repos when a revalidated page has no rel=last', async () => {
    let pass = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const page = pageOf(url);
      const inm = headersOf(init)['If-None-Match'];
      if (pass === 0) {
        const link = '<https://api.github.com/user/repos?page=2&per_page=100>; rel="last"';
        if (page === 1) return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], { etag: '"p1"', link });
        return json(200, [apiRepo('octocat', 'alpha', '2024-01-01T00:00:00Z')], { etag: '"p2"', link });
      }
      if (page === 1 && inm === '"p1"') return new Response(null, { status: 304, headers: { etag: '"p1"' } });
      return json(200, [apiRepo('octocat', 'new', '2025-01-01T00:00:00Z')], {
        etag: '"p2b"',
        link: '<https://api.github.com/user/repos?page=3&per_page=100>; rel="next"',
      });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    pass = 1;
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'error',
        retryAfter: null,
        repos: [
          entry('octocat', 'alpha', '2024-01-01T00:00:00Z'),
          entry('octocat', 'beta', '2020-01-01T00:00:00Z'),
        ],
      }],
    });
  });

  it('keeps repos already fetched when a later page throws on first load', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (pageOf(url) === 1) {
        return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], {
          etag: '"p1"',
          link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="last"',
        });
      }
      throw new Error('socket reset');
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'error',
        retryAfter: null,
        repos: [entry('octocat', 'beta', '2020-01-01T00:00:00Z')],
      }],
    });
  });

  it('keeps repos already fetched when a later page is rate-limited on first load', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (pageOf(url) === 1) {
        return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], {
          etag: '"p1"',
          link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="last"',
        });
      }
      return json(429, { message: 'slow down' }, { 'retry-after': '60' });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'rate-limited',
        retryAfter: PLUS_60,
        repos: [entry('octocat', 'beta', '2020-01-01T00:00:00Z')],
      }],
    });
  });

  it('keeps repos already fetched when a later page Link is unusable on first load', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (pageOf(url) === 1) {
        return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], {
          etag: '"p1"',
          link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="last"',
        });
      }
      return json(200, [apiRepo('octocat', 'alpha', '2024-01-01T00:00:00Z')], {
        etag: '"p2"',
        link: '<https://api.github.com/user/repos?page=3&per_page=100>; rel="next"',
      });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'error',
        retryAfter: null,
        repos: [entry('octocat', 'beta', '2020-01-01T00:00:00Z')],
      }],
    });
  });

  it('fetches a new last page when page 1 revalidates 304 and Link names it', async () => {
    let pass = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const page = pageOf(url);
      const inm = headersOf(init)['If-None-Match'];
      if (pass === 0) {
        return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], { etag: '"p1"' });
      }
      if (page === 1) {
        expect(inm).toBe('"p1"');
        return new Response(null, {
          status: 304,
          headers: {
            etag: '"p1"',
            link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next", <https://api.github.com/user/repos?page=2&per_page=100>; rel="last"',
          },
        });
      }
      return json(200, [apiRepo('octocat', 'alpha', '2024-06-01T00:00:00Z')], {
        etag: '"p2"',
        link: '<https://api.github.com/user/repos?page=1&per_page=100>; rel="first", <https://api.github.com/user/repos?page=1&per_page=100>; rel="prev"',
      });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    pass = 1;
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [
          entry('octocat', 'alpha', '2024-06-01T00:00:00Z'),
          entry('octocat', 'beta', '2020-01-01T00:00:00Z'),
        ],
      }],
    });
  });

  it('reads Link on a later 304 and fetches the new last page', async () => {
    let pass = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const page = pageOf(url);
      const inm = headersOf(init)['If-None-Match'];
      if (pass === 0) {
        const link = '<https://api.github.com/user/repos?page=2&per_page=100>; rel="last"';
        if (page === 1) return json(200, [apiRepo('octocat', 'beta', '2020-01-01T00:00:00Z')], { etag: '"p1"', link });
        return json(200, [apiRepo('octocat', 'mid', '2022-01-01T00:00:00Z')], { etag: '"p2"', link });
      }
      if (page === 1 && inm === '"p1"') return new Response(null, { status: 304, headers: { etag: '"p1"' } });
      if (page === 2 && inm === '"p2"') {
        return new Response(null, {
          status: 304,
          headers: {
            etag: '"p2"',
            link: '<https://api.github.com/user/repos?page=3&per_page=100>; rel="next", <https://api.github.com/user/repos?page=3&per_page=100>; rel="last"',
          },
        });
      }
      return json(200, [apiRepo('octocat', 'alpha', '2025-01-01T00:00:00Z')], {
        etag: '"p3"',
        link: '<https://api.github.com/user/repos?page=1&per_page=100>; rel="first", <https://api.github.com/user/repos?page=2&per_page=100>; rel="prev"',
      });
    });
    const { list } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await list(true);
    pass = 1;
    expect(await list(true)).toEqual({
      status: 'ok',
      groups: [{
        owner: 'octocat',
        kind: 'user',
        status: 'ok',
        repos: [
          entry('octocat', 'alpha', '2025-01-01T00:00:00Z'),
          entry('octocat', 'mid', '2022-01-01T00:00:00Z'),
          entry('octocat', 'beta', '2020-01-01T00:00:00Z'),
        ],
      }],
    });
  });

  it('returns error groups and does not call GitHub when the secret cannot be opened and nothing is cached', async () => {
    const fetchImpl = vi.fn();
    const { list } = harness({
      orgs: ['example-org'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadAccess: async () => { throw new Error('kms'); },
    });
    expect(await list(false)).toEqual({
      status: 'ok',
      groups: [
        { owner: '', kind: 'user', status: 'error', retryAfter: null, repos: [] },
        { owner: 'example-org', kind: 'org', status: 'error', retryAfter: null, repos: [] },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
