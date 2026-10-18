import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubApiError } from './githubCredential';
import { FRAGMENTS, GithubRetryableError, GithubTimeoutError, MAX_PER_SEARCH, PAGE, _resetContainmentCache, commitContains, mergedHeads, parseSearch, searchPrs, searchQueries } from './prPipelineGithub';

const TOKEN = 'gho_' + 'x'.repeat(36);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function fakeFetch(respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = respond(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const openNode = {
  number: 9, title: 'Add lanes', url: 'https://github.com/example-org/termag/pull/9', isDraft: false,
  updatedAt: '2026-10-09T01:00:00Z', headRefName: 'feat', baseRefName: 'main',
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  author: { login: 'me' }, repository: { nameWithOwner: 'example-org/termag' }, autoMergeRequest: null,
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'alice' } }, { requestedReviewer: { __typename: 'Team', slug: 'platform-team' } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'Bugbot', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'StatusContext', context: 'security', state: 'ERROR' },
  ] } } } }] },
};

const mergedNode = {
  number: 8, title: 'Old', url: 'u', headRefName: 'old', baseRefName: 'main', mergedAt: '2026-10-08T00:00:00Z',
  author: { login: 'me' }, mergedBy: { login: 'me' }, repository: { nameWithOwner: 'example-org/termag' },
  mergeCommit: { oid: A }, files: { nodes: [{ path: 'agent/agent.js' }] },
};

describe('searchQueries', () => {
  it('scopes every search to both orgs and the merge window', () => {
    const q = searchQueries(new Date('2026-10-09T12:00:00Z'));
    for (const s of Object.values(q)) expect(s).toContain('org:example-org org:example-team');
    expect(q.review).toContain('review-requested:@me -author:@me');
    expect(q.merged).toContain('merged:>=2026-09-25');
  });
});

describe('parseSearch', () => {
  it('reads open and merged PRs and drops non-PR nodes', () => {
    const got = parseSearch({ viewer: { login: 'me' }, authored: { nodes: [openNode, {}] }, review: { nodes: [] }, merged: { nodes: [mergedNode, { number: 1 }] } });
    expect(got.viewer).toBe('me');
    expect(got.authored).toHaveLength(1);
    expect(got.authored[0]).toMatchObject({
      repo: 'example-org/termag', number: 9, checkRollup: 'FAILURE', requestedReviewers: ['alice', 'platform-team'], autoMerge: false,
      checks: [
        { name: 'Bugbot', state: 'failed' }, { name: 'ci', state: 'pending' },
        { name: 'lint', state: 'passed' }, { name: 'security', state: 'failed' },
      ],
    });
    expect(got.merged).toEqual([expect.objectContaining({ number: 8, mergeCommit: A, files: ['agent/agent.js'] })]);
  });
  it('a PR with no checks has a null rollup', () => {
    const got = parseSearch({ authored: { nodes: [{ ...openNode, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }] } });
    expect(got.authored[0].checkRollup).toBeNull();
    expect(got.authored[0].checks).toEqual([]);
  });
});

describe('searchPrs', () => {
  // The three searches go out as three requests; answer each by its operation name.
  const bySearch = (answers: Record<'Authored' | 'Review' | 'Merged', unknown>) => (_url: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    const op = /query (\w+)/.exec(query)![1] as keyof typeof answers;
    return { body: answers[op] };
  };

  it('sends the three searches with the token, each with only its own fragments', async () => {
    const gh = fakeFetch(bySearch({
      Authored: { data: { viewer: { login: 'me' }, search: { nodes: [openNode] } } },
      Review: { data: { search: { nodes: [] } } },
      Merged: { data: { search: { nodes: [mergedNode] } } },
    }));
    const got = await searchPrs(TOKEN, new Date('2026-10-09T12:00:00Z'), gh.fetchImpl);
    expect(got).toMatchObject({ viewer: 'me', authored: [expect.objectContaining({ number: 9 })], merged: [expect.objectContaining({ number: 8 })] });
    expect(gh.calls).toHaveLength(3);
    for (const c of gh.calls) {
      expect(c.url).toBe('https://api.github.com/graphql');
      expect((c.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      const { query, variables } = JSON.parse(String(c.init?.body));
      // Every fragment defined is spread: GraphQL rejects an unused one.
      for (const [, name] of query.matchAll(/fragment (\w+) on/g)) expect(query).toContain(`...${name}`);
      expect(variables.q).toContain('org:example-org');
    }
  });
  it('fails with the status and without the token', async () => {
    const gh = fakeFetch(() => ({ status: 401, body: {} }));
    const err = await searchPrs(TOKEN, new Date(), gh.fetchImpl).catch(e => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(TOKEN);
  });
  it('keeps partial data when GraphQL reports errors alongside it', async () => {
    const gh = fakeFetch(bySearch({
      Authored: { data: { viewer: { login: 'me' }, search: { nodes: [openNode] } }, errors: [{ message: 'SAML' }] },
      Review: { data: { search: { nodes: [] } } },
      Merged: { data: { search: { nodes: [] } } },
    }));
    expect((await searchPrs(TOKEN, new Date(), gh.fetchImpl)).authored).toHaveLength(1);
  });
  it('fails when GraphQL returns no data', async () => {
    const gh = fakeFetch(() => ({ body: { errors: [{ message: 'bad query' }] } }));
    await expect(searchPrs(TOKEN, new Date(), gh.fetchImpl)).rejects.toThrow('bad query');
  });
});

describe('commitContains', () => {
  beforeEach(() => _resetContainmentCache());

  it('behind and identical mean contained; ahead and diverged mean not', async () => {
    for (const [status, want] of [['behind', true], ['identical', true], ['ahead', false], ['diverged', false]] as const) {
      _resetContainmentCache();
      const gh = fakeFetch(() => ({ body: { status } }));
      expect(await commitContains(TOKEN, 'example-org/termag', A, B, gh.fetchImpl)).toBe(want);
    }
  });
  it('compares running...commit and caches the answer', async () => {
    const gh = fakeFetch(() => ({ body: { status: 'behind' } }));
    await commitContains(TOKEN, 'example-org/termag', A, B, gh.fetchImpl);
    await commitContains(TOKEN, 'example-org/termag', A, B, gh.fetchImpl);
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0].url).toBe(`https://api.github.com/repos/example-org/termag/compare/${A}...${B}?per_page=1`);
  });
  it('a SHA GitHub does not know is unknown, and is asked again next time', async () => {
    const gh = fakeFetch(() => ({ status: 404, body: {} }));
    expect(await commitContains(TOKEN, 'example-org/termag', A, B, gh.fetchImpl)).toBeNull();
    expect(await commitContains(TOKEN, 'example-org/termag', A, B, gh.fetchImpl)).toBeNull();
    expect(gh.calls).toHaveLength(2);
  });
  it('never sends a non-SHA into the URL', async () => {
    const gh = fakeFetch(() => ({ body: { status: 'behind' } }));
    expect(await commitContains(TOKEN, 'example-org/termag', '../../user', B, gh.fetchImpl)).toBeNull();
    expect(gh.calls).toHaveLength(0);
  });
});

describe('mergedHeads', () => {
  const authored = (...logins: string[]) => ({ pullRequests: { nodes: logins.map(login => ({ author: { login } })) } });

  it('asks for every head in one request, names as variables', async () => {
    const gh = fakeFetch(() => ({ body: { data: { h0: authored('me'), h1: authored() } } }));
    const got = await mergedHeads(TOKEN, 'me', [{ repo: 'example-org/termag', branch: 'old' }, { repo: 'example-org/termag', branch: 'new' }], gh.fetchImpl);
    expect([...got!]).toEqual(['example-org/termag:old']);
    expect(gh.calls).toHaveLength(1);
    const sent = JSON.parse(String(gh.calls[0].init?.body));
    expect(sent.variables).toEqual({ o0: 'example-org', n0: 'termag', h0: 'old', o1: 'example-org', n1: 'termag', h1: 'new' });
    expect(sent.query).not.toContain('old');
  });
  it("counts only the viewer's own merges: a colleague's same-named branch does not hide mine", async () => {
    const gh = fakeFetch(() => ({ body: { data: { h0: authored('colleague'), h1: authored('colleague', 'Me') } } }));
    const got = await mergedHeads(TOKEN, 'me', [{ repo: 'example-org/termag', branch: 'feat-x' }, { repo: 'example-org/termag', branch: 'feat-y' }], gh.fetchImpl);
    expect([...got!]).toEqual(['example-org/termag:feat-y']);
  });
  it('makes no request for nothing, and answers null on failure', async () => {
    const gh = fakeFetch(() => ({ status: 502, body: {} }));
    expect(await mergedHeads(TOKEN, 'me', [], gh.fetchImpl)).toEqual(new Set());
    expect(gh.calls).toHaveLength(0);
    expect(await mergedHeads(TOKEN, 'me', [{ repo: 'example-org/termag', branch: 'x' }], gh.fetchImpl)).toBeNull();
  });
});

describe('truncation and review-request time', () => {
  it('flags a merged PR whose file list did not fit one page, or came back without one', () => {
    const got = parseSearch({ merged: { nodes: [
      { ...mergedNode, number: 1, files: { pageInfo: { hasNextPage: true }, nodes: [{ path: 'backend/x.ts' }] } },
      { ...mergedNode, number: 2, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: 'backend/x.ts' }] } },
      { ...mergedNode, number: 3, files: null },
    ] } });
    expect(got.merged.map(m => [m.number, m.filesTruncated])).toEqual([[1, true], [2, false], [3, true]]);
  });
  it('reports searches GitHub matched more PRs for than it returned', () => {
    const got = parseSearch({ authored: { issueCount: 73, nodes: [openNode] }, review: { issueCount: 0, nodes: [] }, merged: { issueCount: 1, nodes: [mergedNode] } });
    expect(got.truncated).toEqual([{ search: 'authored', total: 73, shown: 1 }]);
  });
  it("dates a review request by the viewer's own request, not a later one to someone else", () => {
    const ev = (createdAt: string, r: object) => ({ createdAt, requestedReviewer: r });
    const node = (events: object[]) => ({ ...openNode, timelineItems: { nodes: events } });
    const got = parseSearch({ viewer: { login: 'Me' }, review: { nodes: [
      node([ev('2026-10-01T00:00:00Z', { __typename: 'User', login: 'me' }), ev('2026-10-08T00:00:00Z', { __typename: 'User', login: 'alice' })]),
      node([ev('2026-10-02T00:00:00Z', { __typename: 'Team', slug: 'platform-team' }), ev('2026-10-05T00:00:00Z', { __typename: 'User', login: 'alice' })]),
      node([ev('2026-10-03T00:00:00Z', { __typename: 'User', login: 'alice' })]),
    ] } });
    expect(got.reviewRequested.map(p => p.requestedAt)).toEqual(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', null]);
  });
});

describe('paged searches (GitHub times out on big pages)', () => {
  const pr = (n: number, extra: Record<string, unknown> = {}) => ({
    ...openNode, number: n, url: `https://github.com/example-org/termag/pull/${n}`,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...extra,
  });
  const empty = { data: { search: { issueCount: 0, nodes: [] } } };
  /** Answers Authored from a list of PRs, honouring first/after; the rest empty. */
  function authoredFrom(all: unknown[], opts: { failFirstAbove?: number; status?: number } = {}) {
    return (_url: string, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body));
      const op = /query (\w+)/.exec(query)![1];
      if (op !== 'Authored') return { body: op === 'Checks' ? { data: { nodes: [] } } : empty };
      if (opts.failFirstAbove != null && variables.first > opts.failFirstAbove) return { status: opts.status ?? 504, body: {} };
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = all.slice(start, start + variables.first);
      const end = start + nodes.length;
      return { body: { data: { viewer: { login: 'me' }, search: {
        issueCount: all.length, nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
      } } } };
    };
  }
  const authoredCalls = (calls: { init?: RequestInit }[]) => calls
    .map(c => JSON.parse(String(c.init?.body)))
    .filter(b => /query Authored/.test(b.query))
    .map(b => ({ first: b.variables.first, after: b.variables.after ?? null }));

  it('fetches PAGE at a time and stops at MAX_PER_SEARCH, reporting the truncation', async () => {
    const all = Array.from({ length: 73 }, (_, i) => pr(i + 1));
    const gh = fakeFetch(authoredFrom(all));
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(authoredCalls(gh.calls)).toEqual([{ first: 20, after: null }, { first: 20, after: '20' }, { first: 10, after: '40' }]);
    expect(got.authored).toHaveLength(50);
    expect(got.truncated).toEqual([{ search: 'authored', total: 73, shown: 50 }]);
  });
  it('reads the whole merged window, past MAX_PER_SEARCH, with nothing truncated', async () => {
    const all = Array.from({ length: 82 }, (_, i) => ({ ...mergedNode, number: i + 1, url: `https://github.com/example-org/termag/pull/${i + 1}` }));
    const gh = fakeFetch((_url: string, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body));
      const op = /query (\w+)/.exec(query)![1];
      if (op !== 'Merged') return { body: op === 'Authored' ? { data: { viewer: { login: 'me' }, search: { issueCount: 0, nodes: [] } } } : empty };
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = all.slice(start, start + variables.first);
      const end = start + nodes.length;
      return { body: { data: { search: { issueCount: all.length, nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } } };
    });
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(got.merged).toHaveLength(82);
    expect(got.truncated).toEqual([]);
    const pages = gh.calls.map(c => JSON.parse(String(c.init?.body))).filter(b => /query Merged/.test(b.query)).map(b => b.variables.first);
    expect(pages).toEqual([20, 20, 20, 20, 20]);
  });
  it('stops paging when GitHub says there is no next page', async () => {
    const gh = fakeFetch(authoredFrom([pr(1), pr(2)]));
    expect((await searchPrs(TOKEN, new Date(), gh.fetchImpl)).authored).toHaveLength(2);
    expect(authoredCalls(gh.calls)).toHaveLength(1);
  });
  it('retries a timed-out page at half the size, and keeps the smaller size', async () => {
    const all = Array.from({ length: 30 }, (_, i) => pr(i + 1));
    const gh = fakeFetch(authoredFrom(all, { failFirstAbove: 10 }));
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(got.authored).toHaveLength(30);
    expect(authoredCalls(gh.calls)).toEqual([
      { first: 20, after: null }, { first: 10, after: null }, { first: 10, after: '10' }, { first: 10, after: '20' },
    ]);
  });
  it('treats a 200 whose GraphQL error says it timed out like a 504', async () => {
    let n = 0;
    const gh = fakeFetch((_u, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (/query Authored/.test(query) && n++ === 0) return { body: { errors: [{ message: 'Timeout on validation of query' }] } };
      return authoredFrom([pr(1)])(_u, init);
    });
    expect((await searchPrs(TOKEN, new Date(), gh.fetchImpl)).authored).toHaveLength(1);
  });
  it('gives up as a GithubTimeoutError once the page is MIN_PAGE and still times out', async () => {
    const gh = fakeFetch(authoredFrom([pr(1)], { failFirstAbove: 0 }));
    const err = await searchPrs(TOKEN, new Date(), gh.fetchImpl).catch(e => e);
    expect(err).toBeInstanceOf(GithubTimeoutError);
    expect(err.status).toBe(504);
    expect(authoredCalls(gh.calls).map(c => c.first)).toEqual([20, 10, 5]);
  });
  it('does not retry a refusal (401, 403) at a smaller size', async () => {
    const gh = fakeFetch(authoredFrom([pr(1)], { failFirstAbove: 0, status: 403 }));
    const err = await searchPrs(TOKEN, new Date(), gh.fetchImpl).catch(e => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err).not.toBeInstanceOf(GithubTimeoutError);
    expect(authoredCalls(gh.calls)).toHaveLength(1);
  });

  it('asks for check names only for open PRs that are not green, and fills them in', async () => {
    const failing = pr(1, { id: 'PR_1', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } });
    const green = pr(2, { id: 'PR_2' });
    const asked: string[][] = [];
    const gh = fakeFetch((_u, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (/query Checks/.test(query)) {
        asked.push(variables.ids);
        return { body: { data: { nodes: [{ id: 'PR_1', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
          { __typename: 'CheckRun', name: 'Bugbot', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null },
        ] } } } }] } }] } } };
      }
      return authoredFrom([failing, green])(_u, init);
    });
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(asked).toEqual([['PR_1']]);
    expect(got.authored.find(p => p.number === 1)!.checks).toEqual([{ name: 'Bugbot', state: 'failed' }, { name: 'ci', state: 'pending' }]);
    expect(got.authored.find(p => p.number === 2)!.checks).toEqual([]);
    expect(got.checksMissing).toBe(0);
  });
  it('keeps the list when the check names cannot be read, and counts what is missing', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => pr(i + 1, { id: `PR_${i + 1}`, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }));
    const gh = fakeFetch((_u, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (/query Checks/.test(query)) return { status: 504, body: {} };
      return authoredFrom(nodes)(_u, init);
    });
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(got.authored).toHaveLength(12);
    expect(got.authored[0].checkRollup).toBe('PENDING');
    expect(got.checksMissing).toBe(12);
  });
  it('the search fragment no longer carries the per-check list', () => {
    expect(FRAGMENTS.Open).not.toContain('contexts');
    expect(FRAGMENTS.Open).toContain('statusCheckRollup { state }');
    expect(PAGE).toBe(20);
    expect(MAX_PER_SEARCH).toBe(50);
  });
});

describe('review round: checks follow-up and error kinds', () => {
  const failingPr = (n: number) => ({
    ...openNode, id: `PR_${n}`, number: n, url: `https://github.com/example-org/termag/pull/${n}`,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  });
  const searchOf = (nodes: unknown[]) => (op: string) => op === 'Authored'
    ? { body: { data: { viewer: { login: 'me' }, search: { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } } } } }
    : { body: { data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } } };
  const opOf = (init?: RequestInit) => /query (\w+)/.exec(JSON.parse(String(init?.body)).query)![1];

  it('a network failure in a checks batch keeps the list and counts the batch', async () => {
    const answer = searchOf([failingPr(1), failingPr(2)]);
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      if (opOf(init) === 'Checks') throw new TypeError('fetch failed');
      const { status = 200, body } = answer(opOf(init));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const got = await searchPrs(TOKEN, new Date(), fetchImpl);
    expect(got.authored).toHaveLength(2);
    expect(got.checksMissing).toBe(2);
  });
  it('counts PRs the checks answer leaves out, and takes the fresh rollup state', async () => {
    const answer = searchOf([failingPr(1), failingPr(2), failingPr(3)]);
    const gh = fakeFetch((_u, init) => opOf(init) === 'Checks'
      ? { body: { data: { nodes: [
          { id: 'PR_1', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [
            { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ] } } } }] } },
          null,
          { id: 'PR_99', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } } }] } },
        ] }, errors: [{ message: 'Could not resolve to a node with the global id of PR_2' }] } }
      : answer(opOf(init)));
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(got.checksMissing).toBe(2); // PR_2 null, PR_3 absent; PR_99 was never asked for
    const one = got.authored.find(p => p.number === 1)!;
    expect(one.checkRollup).toBe('SUCCESS');
    expect(one.checks).toEqual([{ name: 'ci', state: 'passed' }]);
  });
  it("retries GitHub's generic GraphQL error but does not call it a timeout", async () => {
    const gh = fakeFetch(() => ({ body: { errors: [{ message: 'Something went wrong while executing your query. Please include `ABC` when reporting this issue.' }] } }));
    const err = await searchPrs(TOKEN, new Date(), gh.fetchImpl).catch(e => e);
    expect(err).toBeInstanceOf(GithubRetryableError);
    expect(err).not.toBeInstanceOf(GithubTimeoutError);
    const authored = gh.calls.map(c => JSON.parse(String(c.init?.body))).filter(b => /query Authored/.test(b.query)).map(b => b.variables.first);
    expect(authored).toEqual([20, 10, 5]);
  });
  it('a 502 or 503 is retryable, a 504 is a timeout', async () => {
    for (const [status, timeout] of [[502, false], [503, false], [504, true]] as const) {
      const gh = fakeFetch(() => ({ status, body: {} }));
      const err = await searchPrs(TOKEN, new Date(), gh.fetchImpl).catch(e => e);
      expect(err).toBeInstanceOf(GithubRetryableError);
      expect(err instanceof GithubTimeoutError).toBe(timeout);
    }
  });
});

describe('review round 2 (Bugbot): timeouts that come with data', () => {
  const opOf = (init?: RequestInit) => /query (\w+)/.exec(JSON.parse(String(init?.body)).query)![1];
  const firstOf = (init?: RequestInit) => JSON.parse(String(init?.body)).variables.first;
  const ok = (op: string) => op === 'Authored'
    ? { body: { data: { viewer: { login: 'me' }, search: { issueCount: 1, nodes: [{ ...openNode, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }], pageInfo: { hasNextPage: false } } } } }
    : { body: { data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } } };

  it('retries smaller when a timeout error comes alongside data with a null search', async () => {
    const gh = fakeFetch((_u, init) => opOf(init) === 'Authored' && firstOf(init) === 20
      ? { body: { data: { viewer: { login: 'me' }, search: null }, errors: [{ message: 'Timeout on search' }] } }
      : ok(opOf(init)));
    const got = await searchPrs(TOKEN, new Date(), gh.fetchImpl);
    expect(got.authored).toHaveLength(1);
    const authored = gh.calls.filter(c => opOf(c.init) === 'Authored').map(c => firstOf(c.init));
    expect(authored).toEqual([20, 10]);
  });
  it('a missing search with no explaining error is a failure, not an empty list', async () => {
    const gh = fakeFetch((_u, init) => opOf(init) === 'Review' ? { body: { data: { search: null } } } : ok(opOf(init)));
    await expect(searchPrs(TOKEN, new Date(), gh.fetchImpl)).rejects.toThrow('no review results');
  });
  it('still keeps partial data behind a non-timeout error (an SSO-blocked org)', async () => {
    const gh = fakeFetch((_u, init) => opOf(init) === 'Authored'
      ? { body: { ...ok('Authored').body, errors: [{ message: 'Resource protected by organization SAML enforcement' }] } }
      : ok(opOf(init)));
    expect((await searchPrs(TOKEN, new Date(), gh.fetchImpl)).authored).toHaveLength(1);
  });
});
