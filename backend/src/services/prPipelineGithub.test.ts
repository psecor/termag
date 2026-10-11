import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubApiError } from './githubCredential';
import { _resetContainmentCache, commitContains, mergedHeads, parseSearch, searchPrs, searchQueries } from './prPipelineGithub';

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
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'alice' } }, { requestedReviewer: { __typename: 'Team', slug: 'devspeed' } }] },
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
    for (const s of Object.values(q)) expect(s).toContain('org:example-org org:example-labs');
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
      repo: 'example-org/termag', number: 9, checkRollup: 'FAILURE', requestedReviewers: ['alice', 'devspeed'], autoMerge: false,
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
      node([ev('2026-10-02T00:00:00Z', { __typename: 'Team', slug: 'devspeed' }), ev('2026-10-05T00:00:00Z', { __typename: 'User', login: 'alice' })]),
      node([ev('2026-10-03T00:00:00Z', { __typename: 'User', login: 'alice' })]),
    ] } });
    expect(got.reviewRequested.map(p => p.requestedAt)).toEqual(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', null]);
  });
});
