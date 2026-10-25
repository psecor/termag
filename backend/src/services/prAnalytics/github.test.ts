import { describe, it, expect } from 'vitest';
import { GithubApiError } from '../githubCredential';
import { fetchPrPage, isRateLimited, searchPrPage } from './github';

describe('isRateLimited', () => {
  it('is true for GraphQL RATE_LIMIT, HTTP 429 and a 403 that says so', () => {
    expect(isRateLimited(new GithubApiError('GitHub GraphQL failed: RATE_LIMIT', 502))).toBe(true);
    expect(isRateLimited(new GithubApiError('GitHub GraphQL failed (HTTP 429)', 429))).toBe(true);
    expect(isRateLimited(new GithubApiError('You have exceeded a secondary rate limit', 403))).toBe(true);
  });

  it('is false for other failures', () => {
    expect(isRateLimited(new GithubApiError('GitHub GraphQL failed (HTTP 403)', 403))).toBe(false);
    expect(isRateLimited(new GithubApiError('GitHub GraphQL failed: no data', 502))).toBe(false);
    expect(isRateLimited(new Error('RATE_LIMIT'))).toBe(false);
  });
});

describe('searchPrPage', () => {
  it('searches the owner by updated time, to the second, and drops non-PR nodes', async () => {
    let body: { variables: { q: string; after: string | null; first: number } } | null = null;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: {
        rateLimit: { remaining: 4000, limit: 5000, resetAt: '2026-10-21T14:00:00Z' },
        search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'PR_1', number: 1, repository: { nameWithOwner: 'example-org/webapp', visibility: 'INTERNAL' } }, {}] },
      } }) };
    }) as unknown as typeof fetch;
    const page = await searchPrPage('t', 'example-org', new Date('2026-10-21T13:04:05.678Z'), null, fetchImpl);
    expect(body!.variables).toEqual({ q: 'org:example-org is:pr updated:>=2026-10-21T13:04:05Z sort:updated-desc', after: null, first: 50 });
    expect(page.nodes.map(n => n.id)).toEqual(['PR_1']);
    expect(page).toMatchObject({ issueCount: 2, hasNextPage: false, rateLimit: { remaining: 4000 } });
  });
});

describe('fetchPrPage', () => {
  const ok = (first: number) => ({ ok: true, json: async () => ({ data: {
    rateLimit: { remaining: 4000, limit: 5000, resetAt: '2026-10-21T14:00:00Z' },
    repository: { visibility: 'INTERNAL', pullRequests: { pageInfo: { hasNextPage: true, endCursor: `c${first}` }, nodes: [] } },
  } }) });

  it('asks for a smaller page when GitHub times out, from the same cursor', async () => {
    const asked: Array<{ first: number; after: string | null }> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const v = JSON.parse(init.body).variables; asked.push({ first: v.first, after: v.after });
      return v.first > 10 ? { ok: false, status: 504 } : ok(v.first);
    }) as unknown as typeof fetch;
    const page = await fetchPrPage('t', 'example-org/termag', 'c0', fetchImpl);
    expect(asked).toEqual([{ first: 50, after: 'c0' }, { first: 25, after: 'c0' }, { first: 10, after: 'c0' }]);
    expect(page.endCursor).toBe('c10');
  });

  it('does not retry the rate limit, and gives up after the smallest page', async () => {
    let calls = 0;
    const limited = (async () => { calls++; return { ok: true, json: async () => ({ errors: [{ type: 'RATE_LIMIT' }] }) }; }) as unknown as typeof fetch;
    await expect(fetchPrPage('t', 'example-org/termag', null, limited)).rejects.toThrow(/RATE_LIMIT/);
    expect(calls).toBe(1);
    calls = 0;
    const down = (async () => { calls++; return { ok: false, status: 504 }; }) as unknown as typeof fetch;
    await expect(fetchPrPage('t', 'example-org/termag', null, down)).rejects.toThrow(/504/);
    expect(calls).toBe(3);
  });

  it('retries our own timeout and a GraphQL timeout, but not other GraphQL errors', async () => {
    const run = async (fail: () => unknown) => {
      let calls = 0;
      const fetchImpl = (async (_url: string, init: { body: string }) => {
        calls++; const v = JSON.parse(init.body).variables;
        return v.first > 25 ? fail() : ok(v.first);
      }) as unknown as typeof fetch;
      const page = await fetchPrPage('t', 'example-org/termag', null, fetchImpl).catch((e: Error) => e);
      return { calls, page };
    };
    const aborted = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    expect((await run(aborted)).calls).toBe(2);
    const slow = () => ({ ok: true, json: async () => ({ errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout' }] }) });
    expect((await run(slow)).calls).toBe(2);
    const forbidden = () => ({ ok: true, json: async () => ({ errors: [{ type: 'FORBIDDEN' }] }) });
    const r = await run(forbidden);
    expect(r.calls).toBe(1);
    expect(r.page).toBeInstanceOf(Error);
  });
});
