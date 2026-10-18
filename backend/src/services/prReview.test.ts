import { describe, it, expect, vi } from 'vitest';
import { GithubApiError } from './githubCredential';
import {
  fetchPrHead,
  PrInputError, fetchPrOverview, githubReason, mergePr, parseCommentInput, parseFailedSuites, parseMergeInput, parseOverview, parsePrRef,
  parseReviewInput, parseReviewersInput, postComment, requestReviewers, rerunFailedChecks, submitReview,
} from './prReview';

const TOKEN = 'gho_' + 'x'.repeat(36);
const REF = { owner: 'example-org', name: 'termag', number: 9 };

function fakeFetch(respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = respond(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const prNode = {
  number: 9, title: 'Add lanes', url: 'https://github.com/example-org/termag/pull/9', isDraft: false,
  updatedAt: '2026-10-09T01:00:00Z', headRefName: 'feat', baseRefName: 'main',
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  author: { login: 'alice' }, repository: { nameWithOwner: 'example-org/termag' }, autoMergeRequest: null,
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ] } } } }] },
  state: 'OPEN', body: 'Why and how.', createdAt: '2026-10-08T00:00:00Z', additions: 40, deletions: 3, changedFiles: 2,
  files: { pageInfo: { hasNextPage: false }, nodes: [
    { path: 'a.ts', additions: 30, deletions: 3, changeType: 'MODIFIED' },
    { path: 'b.ts', additions: 10, deletions: 0, changeType: 'ADDED' },
  ] },
  latestReviews: { nodes: [{ author: { login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-10-09T00:00:00Z' }] },
  viewerLatestReview: null,
  id: 'PR_kw9', headRefOid: 'c'.repeat(40),
  repository: { nameWithOwner: 'example-org/termag', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, viewerDefaultMergeMethod: 'MERGE' },
};
const SHA = 'c'.repeat(40);

describe('parsePrRef', () => {
  it('accepts a PR in the pipeline orgs, normalizing the org case', () => {
    expect(parsePrRef('Example-Org', 'termag', '9')).toEqual(REF);
  });
  it('refuses other orgs, odd names and non-numbers', () => {
    expect(() => parsePrRef('someone', 'termag', '9')).toThrow(PrInputError);
    expect(() => parsePrRef('example-org', 'a/b', '9')).toThrow(PrInputError);
    expect(() => parsePrRef('example-org', 'termag', '0')).toThrow(PrInputError);
    expect(() => parsePrRef('example-org', 'termag', '9x')).toThrow(PrInputError);
  });
});

describe('parseReviewInput', () => {
  it('takes an approval with or without text', () => {
    expect(parseReviewInput({ event: 'APPROVE' })).toEqual({ event: 'APPROVE', body: '' });
    expect(parseReviewInput({ event: 'APPROVE', body: '  lgtm \n' })).toEqual({ event: 'APPROVE', body: 'lgtm' });
  });
  it('needs text for a comment or a change request', () => {
    expect(() => parseReviewInput({ event: 'COMMENT', body: '   ' })).toThrow('A comment needs some text');
    expect(() => parseReviewInput({ event: 'REQUEST_CHANGES' })).toThrow('Say what needs to change');
    expect(parseReviewInput({ event: 'REQUEST_CHANGES', body: 'fix x' })).toEqual({ event: 'REQUEST_CHANGES', body: 'fix x' });
  });
  it('refuses an unknown event and an oversized body', () => {
    expect(() => parseReviewInput({ event: 'MERGE' })).toThrow(PrInputError);
    expect(() => parseReviewInput(null)).toThrow(PrInputError);
    expect(() => parseReviewInput({ event: 'COMMENT', body: 'x'.repeat(70_000) })).toThrow('too long');
  });
});

describe('parseOverview', () => {
  it('reads the PR with its description, files and reviews', () => {
    const pr = parseOverview({ viewer: { login: 'me' }, repository: { pullRequest: prNode } })!;
    expect(pr).toMatchObject({
      repo: 'example-org/termag', number: 9, author: 'alice', viewer: 'me', state: 'OPEN', body: 'Why and how.',
      additions: 40, deletions: 3, changedFiles: 2, filesTruncated: false, viewerReview: null, viewerCanReview: true,
      checkRollup: 'SUCCESS', requestedReviewers: ['me'],
    });
    expect(pr.files.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(pr.reviews).toEqual([{ author: 'bob', state: 'COMMENTED', submittedAt: '2026-10-09T00:00:00Z' }]);
  });
  it('says the viewer cannot review their own PR, or a closed one', () => {
    expect(parseOverview({ viewer: { login: 'Alice' }, repository: { pullRequest: prNode } })!.viewerCanReview).toBe(false);
    expect(parseOverview({ viewer: { login: 'me' }, repository: { pullRequest: { ...prNode, state: 'MERGED' } } })!.viewerCanReview).toBe(false);
  });
  it('is null when there is no such PR', () => {
    expect(parseOverview({ viewer: { login: 'me' }, repository: { pullRequest: null } })).toBeNull();
    expect(parseOverview({ viewer: { login: 'me' }, repository: null })).toBeNull();
  });
});

describe('fetchPrOverview', () => {
  it('asks GraphQL for the PR by owner, name and number, with the token in the header only', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { data: { viewer: { login: 'me' }, repository: { pullRequest: prNode } } } }));
    const pr = await fetchPrOverview(TOKEN, REF, fetchImpl);
    expect(pr.title).toBe('Add lanes');
    const sent = JSON.parse(String(calls[0].init!.body));
    expect(sent.variables).toEqual({ owner: 'example-org', name: 'termag', number: 9 });
    expect(sent.query).toContain('fragment Open on PullRequest');
    expect(String(calls[0].init!.body)).not.toContain(TOKEN);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('turns a missing PR into a 404 that carries GitHub\'s reason', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { data: { viewer: { login: 'me' }, repository: null }, errors: [{ message: 'Could not resolve to a Repository' }] } }));
    await expect(fetchPrOverview(TOKEN, REF, fetchImpl)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('Could not resolve') });
  });
  it('passes an HTTP failure through with its status', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: {} }));
    await expect(fetchPrOverview(TOKEN, REF, fetchImpl)).rejects.toBeInstanceOf(GithubApiError);
    await expect(fetchPrOverview(TOKEN, REF, fetchImpl)).rejects.toMatchObject({ status: 401 });
  });
});

describe('submitReview', () => {
  it('posts the event and body to the PR\'s reviews', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { id: 5, state: 'APPROVED', html_url: 'https://github.com/r#5' } }));
    const got = await submitReview(TOKEN, REF, { event: 'APPROVE', body: 'lgtm' }, fetchImpl);
    expect(got).toEqual({ id: 5, state: 'APPROVED', url: 'https://github.com/r#5' });
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/pulls/9/reviews');
    expect(calls[0].init!.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ event: 'APPROVE', body: 'lgtm' });
  });
  it('sends no body for a bare approval', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { id: 6, state: 'APPROVED' } }));
    await submitReview(TOKEN, REF, { event: 'APPROVE', body: '' }, fetchImpl);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ event: 'APPROVE' });
  });
  it('carries GitHub\'s refusal, status and reason', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 422, body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] } }));
    await expect(submitReview(TOKEN, REF, { event: 'APPROVE', body: '' }, fetchImpl))
      .rejects.toMatchObject({ status: 422, message: 'GitHub refused the review: Unprocessable Entity: Can not approve your own pull request' });
  });
});

describe('githubReason', () => {
  it('joins message and errors, of either shape', () => {
    expect(githubReason({ message: 'Validation Failed', errors: [{ message: 'one pending review' }, 'x'] })).toBe('Validation Failed: one pending review: x');
    expect(githubReason(null)).toBeNull();
  });
});

describe('the overview\'s merge fields', () => {
  it('lists the allowed methods in button order and falls back from a disallowed default', () => {
    const pr = parseOverview({ viewer: { login: 'alice' }, repository: { pullRequest: prNode } })!;
    expect(pr.mergeSettings).toEqual({ methods: ['SQUASH', 'REBASE'], defaultMethod: 'SQUASH', autoMergeAllowed: true });
    expect(pr).toMatchObject({ nodeId: 'PR_kw9', headSha: SHA, autoMergeMethod: null, viewerCanMerge: true });
  });
  it('offers the merge panel only on the viewer\'s own open PR', () => {
    expect(parseOverview({ viewer: { login: 'me' }, repository: { pullRequest: prNode } })!.viewerCanMerge).toBe(false);
    expect(parseOverview({ viewer: { login: 'alice' }, repository: { pullRequest: { ...prNode, state: 'MERGED' } } })!.viewerCanMerge).toBe(false);
  });
  it('reads the auto-merge method', () => {
    const pr = parseOverview({ viewer: { login: 'alice' }, repository: { pullRequest: { ...prNode, autoMergeRequest: { enabledAt: 'x', mergeMethod: 'SQUASH' } } } })!;
    expect(pr.autoMergeMethod).toBe('SQUASH');
    expect(pr.autoMerge).toBe(true);
  });
});

describe('parseMergeInput', () => {
  it('pins a merge now to a full head sha', () => {
    expect(parseMergeInput({ mode: 'now', method: 'SQUASH', sha: SHA })).toEqual({ mode: 'now', method: 'SQUASH', sha: SHA });
    expect(() => parseMergeInput({ mode: 'now', method: 'SQUASH' })).toThrow('head commit');
    expect(() => parseMergeInput({ mode: 'now', method: 'SQUASH', sha: 'abc' })).toThrow(PrInputError);
  });
  it('takes auto-merge with a method, and its cancel with nothing', () => {
    expect(parseMergeInput({ mode: 'auto', method: 'REBASE' })).toEqual({ mode: 'auto', method: 'REBASE' });
    expect(parseMergeInput({ mode: 'cancel_auto', method: 'junk' })).toEqual({ mode: 'cancel_auto' });
  });
  it('refuses unknown modes and methods', () => {
    expect(() => parseMergeInput({ mode: 'force' })).toThrow(PrInputError);
    expect(() => parseMergeInput({ mode: 'auto', method: 'squash' })).toThrow(PrInputError);
    expect(() => parseMergeInput(undefined)).toThrow(PrInputError);
  });
});

describe('mergePr', () => {
  it('merges now with PUT, the method lowercased and the sha pinned', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { merged: true, sha: 'd'.repeat(40), message: 'Pull Request successfully merged' } }));
    const got = await mergePr(TOKEN, REF, { mode: 'now', method: 'SQUASH', sha: SHA }, fetchImpl);
    expect(got).toEqual({ merged: true, sha: 'd'.repeat(40), autoMerge: false, message: 'Pull Request successfully merged' });
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/pulls/9/merge');
    expect(calls[0].init!.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ merge_method: 'squash', sha: SHA });
  });
  it('carries a moved head\'s 409 and a blocked merge\'s 405', async () => {
    let status = 409;
    const { fetchImpl } = fakeFetch(() => ({ status, body: { message: status === 409 ? 'Head branch was modified. Review and try the merge again.' : 'Pull Request is not mergeable' } }));
    await expect(mergePr(TOKEN, REF, { mode: 'now', method: 'MERGE', sha: SHA }, fetchImpl)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Head branch was modified') });
    status = 405;
    await expect(mergePr(TOKEN, REF, { mode: 'now', method: 'MERGE', sha: SHA }, fetchImpl)).rejects.toMatchObject({ status: 405 });
  });
  it('turns auto-merge on through the PR\'s node id, read server-side', async () => {
    const { fetchImpl, calls } = fakeFetch((_u, init) => {
      const q = JSON.parse(String(init!.body)).query as string;
      if (q.includes('query PrId')) return { body: { data: { repository: { pullRequest: { id: 'PR_kw9' } } } } };
      return { body: { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: 'now' } } } } } };
    });
    expect(await mergePr(TOKEN, REF, { mode: 'auto', method: 'SQUASH' }, fetchImpl)).toEqual({ merged: false, sha: null, autoMerge: true, message: null });
    expect(JSON.parse(String(calls[1].init!.body)).variables).toEqual({ id: 'PR_kw9', method: 'SQUASH' });
  });
  it('turns auto-merge off', async () => {
    const { fetchImpl, calls } = fakeFetch((_u, init) => {
      const q = JSON.parse(String(init!.body)).query as string;
      if (q.includes('query PrId')) return { body: { data: { repository: { pullRequest: { id: 'PR_kw9' } } } } };
      return { body: { data: { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } } };
    });
    expect((await mergePr(TOKEN, REF, { mode: 'cancel_auto' }, fetchImpl)).autoMerge).toBe(false);
    expect(JSON.parse(String(calls[1].init!.body)).query).toContain('disablePullRequestAutoMerge');
  });
  it('turns a refused mutation (a 200 with errors) into a 422 with GitHub\'s words', async () => {
    const { fetchImpl } = fakeFetch((_u, init) => {
      const q = JSON.parse(String(init!.body)).query as string;
      if (q.includes('query PrId')) return { body: { data: { repository: { pullRequest: { id: 'PR_kw9' } } } } };
      return { body: { data: null, errors: [{ message: 'Pull request is in clean status' }] } };
    });
    await expect(mergePr(TOKEN, REF, { mode: 'auto', method: 'SQUASH' }, fetchImpl)).rejects.toMatchObject({ status: 422, message: 'GitHub refused: Pull request is in clean status' });
  });
});

const suites = (...nodes: unknown[]) => ({ head: { nodes: [{ commit: { checkSuites: { nodes } } }] } });
const actionsSuite = (runId: number, conclusion = 'FAILURE', status = 'COMPLETED') =>
  ({ status, conclusion, app: { name: 'GitHub Actions' }, workflowRun: { databaseId: runId, workflow: { name: `wf${runId}` } } });

describe('parseFailedSuites', () => {
  it('splits finished failures into Actions runs and other apps, once each', () => {
    expect(parseFailedSuites(suites(
      actionsSuite(1), actionsSuite(1), actionsSuite(2, 'TIMED_OUT'), actionsSuite(3, 'SUCCESS'), actionsSuite(4, null as never, 'IN_PROGRESS'),
      { status: 'COMPLETED', conclusion: 'FAILURE', app: { name: 'Cursor Bugbot' }, workflowRun: null },
      { status: 'COMPLETED', conclusion: 'FAILURE', app: { name: 'Cursor Bugbot' }, workflowRun: null },
    ))).toEqual({ runs: [{ runId: 1, workflow: 'wf1' }, { runId: 2, workflow: 'wf2' }], other: ['Cursor Bugbot'] });
  });
  it('is empty with no suites', () => {
    expect(parseFailedSuites(null)).toEqual({ runs: [], other: [] });
  });
  it('rides on the overview', () => {
    const pr = parseOverview({ viewer: { login: 'me' }, repository: { pullRequest: { ...prNode, ...suites(actionsSuite(7)) } } })!;
    expect(pr.failedSuites).toEqual({ runs: [{ runId: 7, workflow: 'wf7' }], other: [] });
  });
});

describe('rerunFailedChecks', () => {
  const respond = (sts: unknown[], rerunStatus: (runId: number) => number) => fakeFetch((url, init) => {
    if (url.endsWith('/graphql')) return { body: { data: { repository: { pullRequest: suites(...sts) } } } };
    const id = Number(/runs\/(\d+)\//.exec(url)![1]);
    const status = rerunStatus(id);
    return { status, body: status === 201 ? {} : { message: 'This workflow is already running' } };
  });
  it('re-runs each failed Actions run read from GitHub, and lists the rest', async () => {
    const { fetchImpl, calls } = respond([actionsSuite(1), actionsSuite(2), { status: 'COMPLETED', conclusion: 'FAILURE', app: { name: 'Cursor Bugbot' } }], () => 201);
    const got = await rerunFailedChecks(TOKEN, REF, fetchImpl);
    expect(got.rerun.map(r => r.runId).sort()).toEqual([1, 2]);
    expect(got.other).toEqual(['Cursor Bugbot']);
    expect(calls.filter(c => c.init?.method === 'POST' && c.url.includes('/actions/runs/')).map(c => c.url).sort())
      .toEqual(['https://api.github.com/repos/example-org/termag/actions/runs/1/rerun-failed-jobs', 'https://api.github.com/repos/example-org/termag/actions/runs/2/rerun-failed-jobs']);
  });
  it('reports a refused run alongside the ones that went', async () => {
    const { fetchImpl } = respond([actionsSuite(1), actionsSuite(2)], id => id === 2 ? 403 : 201);
    const got = await rerunFailedChecks(TOKEN, REF, fetchImpl);
    expect(got.rerun).toEqual([{ runId: 1, workflow: 'wf1' }]);
    expect(got.refused).toEqual([{ runId: 2, workflow: 'wf2', error: 'This workflow is already running' }]);
  });
  it('is an error when nothing could be re-run, or nothing failed', async () => {
    const all = respond([actionsSuite(1)], () => 403);
    await expect(rerunFailedChecks(TOKEN, REF, all.fetchImpl)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('already running') });
    const none = respond([actionsSuite(1, 'SUCCESS')], () => 201);
    await expect(rerunFailedChecks(TOKEN, REF, none.fetchImpl)).rejects.toMatchObject({ status: 422, message: 'No failed checks on the latest commit' });
  });
  it('re-runs from the data GitHub did return beside field errors, as the overview renders it', async () => {
    const { fetchImpl } = fakeFetch((url) => url.endsWith('/graphql')
      ? { body: { data: { repository: { pullRequest: suites(actionsSuite(1)) } }, errors: [{ message: 'Resource not accessible by integration' }] } }
      : { status: 201, body: {} });
    expect((await rerunFailedChecks(TOKEN, REF, fetchImpl)).rerun).toEqual([{ runId: 1, workflow: 'wf1' }]);
  });
  it('answers only the other apps when no failure is an Actions run', async () => {
    const { fetchImpl, calls } = respond([{ status: 'COMPLETED', conclusion: 'FAILURE', app: { name: 'Cursor Bugbot' } }], () => 201);
    expect(await rerunFailedChecks(TOKEN, REF, fetchImpl)).toEqual({ rerun: [], refused: [], other: ['Cursor Bugbot'] });
    expect(calls).toHaveLength(1);
  });
});

describe('requests by kind', () => {
  it('splits pending requests into users and teams', () => {
    const node = { ...prNode, reviewRequests: { nodes: [
      { requestedReviewer: { __typename: 'User', login: 'carol' } },
      { requestedReviewer: { __typename: 'Team', slug: 'platform-team' } },
      { requestedReviewer: null },
    ] } };
    const pr = parseOverview({ viewer: { login: 'alice' }, repository: { pullRequest: node } })!;
    expect(pr).toMatchObject({ requestedUsers: ['carol'], requestedTeams: ['platform-team'], requestedReviewers: ['carol', 'platform-team'] });
  });
});

describe('parseReviewersInput', () => {
  it('takes logins and team slugs, dropping @ and the org prefix, once each', () => {
    expect(parseReviewersInput({ users: ['@bob', 'bob', ' carol '], teams: ['@example-org/platform-team'] })).toEqual({ users: ['bob', 'carol'], teams: ['platform-team'] });
  });
  it('refuses nothing, too many, and things that are not names', () => {
    expect(() => parseReviewersInput({ users: [] })).toThrow('at least one');
    expect(() => parseReviewersInput({ users: Array.from({ length: 16 }, (_, i) => `u${i}`) })).toThrow('At most 15');
    expect(() => parseReviewersInput({ users: ['bob smith'] })).toThrow(PrInputError);
    expect(() => parseReviewersInput({ users: 'bob' })).toThrow('must be a list');
    expect(() => parseReviewersInput({ users: [3] })).toThrow(PrInputError);
  });
});

describe('parseCommentInput', () => {
  it('needs some text, and not too much', () => {
    expect(parseCommentInput({ body: ' @bob ping ' })).toEqual({ body: '@bob ping' });
    expect(() => parseCommentInput({ body: ' ' })).toThrow('empty');
    expect(() => parseCommentInput({ body: 'x'.repeat(70_000) })).toThrow('too long');
  });
});

describe('requestReviewers and postComment', () => {
  it('posts users and teams to requested_reviewers and answers who is requested', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { requested_reviewers: [{ login: 'bob' }], requested_teams: [{ slug: 'platform-team' }] } }));
    expect(await requestReviewers(TOKEN, REF, { users: ['bob'], teams: ['platform-team'] }, fetchImpl)).toEqual({ users: ['bob'], teams: ['platform-team'] });
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/pulls/9/requested_reviewers');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ reviewers: ['bob'], team_reviewers: ['platform-team'] });
  });
  it('carries GitHub\'s 422 for a reviewer it will not take', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 422, body: { message: 'Reviews may only be requested from collaborators.' } }));
    await expect(requestReviewers(TOKEN, REF, { users: ['stranger'], teams: [] }, fetchImpl))
      .rejects.toMatchObject({ status: 422, message: 'GitHub refused the review request: Reviews may only be requested from collaborators.' });
  });
  it('posts a conversation comment on the PR\'s issue', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { html_url: 'https://github.com/c/1' } }));
    expect(await postComment(TOKEN, REF, '@bob ping', fetchImpl)).toEqual({ url: 'https://github.com/c/1' });
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/issues/9/comments');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ body: '@bob ping' });
  });
});

describe('fetchPrHead', () => {
  const ref = { owner: 'example-org', name: 'termag', number: 359 };
  it('reads the branch, the head commit and whether it comes from a fork', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { data: { repository: { pullRequest: { state: 'OPEN', headRefName: 'feat/pr-defer', headRefOid: 'c'.repeat(40), isCrossRepository: true } } } } }));
    expect(await fetchPrHead('t', ref, fetchImpl)).toEqual({ state: 'OPEN', branch: 'feat/pr-defer', sameRepo: false, headOid: 'c'.repeat(40) });
  });
  it('is a 404 when GitHub has no such PR', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { data: { repository: { pullRequest: null } } } }));
    await expect(fetchPrHead('t', ref, fetchImpl)).rejects.toMatchObject({ status: 404 });
  });
});
