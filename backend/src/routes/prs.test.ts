import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The route's own wiring only: GitHub, the boxes and the database are behind
// PipelineDeps, so nothing here reaches the network.
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/agentRegistry', () => ({ connectedOwnedBoxes: () => [], isProjectAgentConnected: () => false, sendForProject: vi.fn() }));
vi.mock('../services/credentialStore', () => ({ githubTokenSource: async () => null }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'] };
    next();
  },
  requireAuthOrAgentToken: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1' }; next(); },
}));

const { prsRouter, loadPipeline, termagDeploys, pipelineNotes, limit, _resetPipelineMemos } = await import('./prs');
const { GithubApiError } = await import('../services/githubCredential');
const { GithubRetryableError, GithubTimeoutError } = await import('../services/prPipelineGithub');
const { deferredUntil } = await import('../services/prDeferrals');
type Deps = Parameters<typeof loadPipeline>[2] & object;
type Merged = Parameters<typeof termagDeploys>[1][number];

const TOKEN_A = 'gho_' + 'a'.repeat(36);
const TOKEN_B = 'gho_' + 'b'.repeat(36);
const PROD = 'a1'.repeat(20);
const MERGE = 'b2'.repeat(20);

function mergedPr(over: Partial<Merged> = {}): Merged {
  return {
    repo: 'example-org/termag', number: 7, title: 'm', url: 'u', author: 'me', headRefName: 'done', baseRefName: 'main',
    mergedAt: '2026-10-08T00:00:00Z', mergedBy: 'me', mergeCommit: MERGE, files: ['backend/x.ts'], ...over,
  };
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [], merged: [], truncated: [] })),
    branches: vi.fn(async () => ({ branches: [], workstreams: [], offline: 0, outdatedAgent: 0, failed: 0 })),
    version: vi.fn(async () => ({ sha: PROD, source: 'git' as const })),
    contains: vi.fn(async () => true),
    mergedHeads: vi.fn(async () => new Set<string>()),
    boxCommits: () => [],
    orchestratorImage: vi.fn(async () => null),
    bakeRuns: vi.fn(async () => []),
    now: () => new Date('2026-10-09T12:00:00Z'),
    ...over,
  };
}

let server: Server;
let base: string;
let current: { deps: Deps; token: string | null; actions: Actions; deferrals: Store; links: Links; createWorkstream: CreateWs };

type Store = NonNullable<Parameters<typeof prsRouter>[3]>;
/** An in-memory deferral store, by user then key. */
function store(): Store & { rows: Map<string, Map<string, string>> } {
  const rows = new Map<string, Map<string, string>>();
  const of = (u: string) => { if (!rows.has(u)) rows.set(u, new Map()); return rows.get(u)!; };
  return {
    rows,
    list: vi.fn(async (u: string, now: Date) => [...of(u)].filter(([, until]) => Date.parse(until) > now.getTime()).map(([key, until]) => ({ key, until }))),
    // The real store's rule: a running deferral is extended from its end (deferredUntil).
    defer: vi.fn(async (u: string, input: { key: string; days: number }, now: Date) => {
      const current = of(u).get(input.key);
      const until = deferredUntil(current ? new Date(current) : null, input.days, now).toISOString();
      of(u).set(input.key, until);
      return { key: input.key, until };
    }),
    undefer: vi.fn(async (u: string, key: string) => { of(u).delete(key); }),
  };
}

type Links = NonNullable<Parameters<typeof prsRouter>[4]>;
type CreateWs = NonNullable<Parameters<typeof prsRouter>[5]>;
const WS_LINK = { projectId: 'p1', projectName: 'termag', workstream: 'termag-pr-dash' };
/** An in-memory link store: one workstream (p1/termag-pr-dash) belongs to u1, with the real store's precedence. */
function linkStore(): Links & { rows: Map<string, { repo: string; number: number; source: 'created' | 'branch' | 'manual' }> } {
  const rows = new Map<string, { repo: string; number: number; source: 'created' | 'branch' | 'manual' }>();
  return {
    rows,
    list: vi.fn(async (u: string) => (u === 'u1' ? [...rows.values()].map(r => ({ ...r, workstream: WS_LINK })) : [])),
    record: vi.fn(async (u: string, pr: { repo: string; number: number }, at: { projectId: string; workstream: string }, source: 'created' | 'branch' | 'manual') => {
      if (u !== 'u1' || at.projectId !== 'p1' || at.workstream !== 'termag-pr-dash') return false;
      const key = `${pr.repo.toLowerCase()}#${pr.number}`;
      if (!rows.has(key) || source === 'manual') rows.set(key, { repo: pr.repo.toLowerCase(), number: pr.number, source });
      return true;
    }),
    detach: vi.fn(async (_u: string, pr: { repo: string; number: number }) => { rows.delete(`${pr.repo.toLowerCase()}#${pr.number}`); }),
  };
}

type Actions = NonNullable<Parameters<typeof prsRouter>[2]>;
function actions(over: Partial<Actions> = {}): Actions {
  return {
    overview: vi.fn(async (_t, ref) => ({ repo: `${ref.owner}/${ref.name}`, number: ref.number, title: 'PR' }) as never),
    review: vi.fn(async () => ({ id: 1, state: 'APPROVED', url: null })),
    merge: vi.fn(async () => ({ merged: true, sha: 'd'.repeat(40), autoMerge: false, message: null })),
    rerun: vi.fn(async () => ({ rerun: [{ runId: 1, workflow: 'ci' }], refused: [], other: [] })),
    reviewers: vi.fn(async () => ({ users: ['bob'], teams: [] })),
    comment: vi.fn(async () => ({ url: 'https://github.com/c/1' })),
    bake: vi.fn(async () => undefined),
    head: vi.fn(async () => ({ state: 'OPEN' as const, branch: 'feat/pr-defer', sameRepo: true, headOid: 'a'.repeat(40) })),
    ...over,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The router is built once; each test swaps what it reads through `current`.
  const proxy: Deps = {
    search: (...a) => current.deps.search(...a),
    branches: (...a) => current.deps.branches(...a),
    version: () => current.deps.version(),
    contains: (...a) => current.deps.contains(...a),
    mergedHeads: (...a) => current.deps.mergedHeads(...a),
    boxCommits: () => current.deps.boxCommits(),
    orchestratorImage: () => current.deps.orchestratorImage(),
    bakeRuns: (...a) => current.deps.bakeRuns(...a),
    now: () => current.deps.now(),
  };
  app.use('/api', prsRouter(proxy, async () => current.token, {
    overview: (...a) => current.actions.overview(...a),
    review: (...a) => current.actions.review(...a),
    merge: (...a) => current.actions.merge(...a),
    rerun: (...a) => current.actions.rerun(...a),
    reviewers: (...a) => current.actions.reviewers(...a),
    comment: (...a) => current.actions.comment(...a),
    bake: (...a) => current.actions.bake(...a),
    head: (...a) => current.actions.head(...a),
  }, {
    list: (...a) => current.deferrals.list(...a),
    defer: (...a) => current.deferrals.defer(...a),
    undefer: (...a) => current.deferrals.undefer(...a),
  }, {
    list: (...a) => current.links.list(...a),
    record: (...a) => current.links.record(...a),
    detach: (...a) => current.links.detach(...a),
  }, (...a) => current.createWorkstream(...a)));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); });
beforeEach(() => { _resetPipelineMemos(); current = { deps: deps(), token: TOKEN_A, actions: actions(), deferrals: store(), links: linkStore(), createWorkstream: vi.fn(async (_u, _p, input) => ({ status: 201, body: { id: 'w9', name: input.name, branch: input.branch } })) }; });

const get = (path: string, user = 'u1') => fetch(`${base}${path}`, { headers: user ? { 'x-test-user': user } : {} });

describe('GET /api/prs', () => {
  it('needs a signed-in user', async () => {
    expect((await get('/prs', '')).status).toBe(401);
  });
  it('without a GitHub token answers connected: false and reads nothing', async () => {
    current.token = null;
    const res = await get('/prs');
    expect(await res.json()).toEqual({ connected: false });
    expect(current.deps.search).not.toHaveBeenCalled();
  });
  it('answers the lanes', async () => {
    const body = await (await get('/prs')).json();
    expect(body).toMatchObject({ connected: true, viewer: 'me', prod: { sha: PROD, source: 'git' }, notes: [], mergedWindowDays: 14 });
    expect(body.lanes.map((l: { id: string }) => l.id)).toContain('needs_my_review');
  });
  it('maps a rejected token to a 502 that says to reconnect, without the token', async () => {
    current.deps = deps({ search: vi.fn(async () => { throw new GithubApiError('GitHub search failed (HTTP 401)', 401); }) });
    const res = await get('/prs');
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('Reconnect GitHub in Settings');
    expect(text).not.toContain(TOKEN_A);
  });
  it('passes other GitHub failures through as a 502', async () => {
    current.deps = deps({ search: vi.fn(async () => { throw new GithubApiError('GitHub search failed: bad query', 502); }) });
    const res = await get('/prs');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('GitHub search failed: bad query');
  });
  it('does not word a generic GitHub failure as a timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    current.deps = deps({ search: vi.fn(async () => { throw new GithubRetryableError('GitHub search failed: Something went wrong while executing your query', 502); }) });
    const res = await get('/prs');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('GitHub search failed: Something went wrong while executing your query');
    warn.mockRestore();
  });
  it('says a GitHub timeout is one (504), and logs every failure with the user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    current.deps = deps({ search: vi.fn(async () => { throw new GithubTimeoutError('GitHub search failed (HTTP 504)', 504); }) });
    const res = await get('/prs');
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe('GitHub timed out listing your pull requests. It retries in a minute.');
    expect(warn.mock.calls.map(c => String(c[0])).some(m => m.startsWith('[PRS] ') && m.includes('HTTP 504'))).toBe(true);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toContain(TOKEN_A);
    warn.mockRestore();
  });
  it('memoizes per user, and a replaced token starts over', async () => {
    await get('/prs'); await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(1);
    current.token = TOKEN_B;
    await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(2);
    expect(vi.mocked(current.deps.search).mock.calls[1][0]).toBe(TOKEN_B);
    await get('/prs', 'u2');
    expect(current.deps.search).toHaveBeenCalledTimes(3);
  });
});

const post = (path: string, body: unknown, user = 'u1') => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  body: JSON.stringify(body),
});

describe('GET /api/prs/:owner/:repo/:number', () => {
  it('reads the PR with the user\'s token', async () => {
    const res = await get('/prs/example-org/termag/9');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: 'example-org/termag', number: 9 });
    expect(current.actions.overview).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 });
  });
  it('refuses a repository outside the pipeline orgs without calling GitHub', async () => {
    const res = await get('/prs/someone/else/9');
    expect(res.status).toBe(400);
    expect(current.actions.overview).not.toHaveBeenCalled();
  });
  it('answers 409 with no GitHub token', async () => {
    current.token = null;
    expect((await get('/prs/example-org/termag/9')).status).toBe(409);
  });
  it('never passes GitHub\'s 401 through, and keeps a 404', async () => {
    current.actions = actions({ overview: vi.fn(async () => { throw new GithubApiError('x', 401); }) });
    const res = await get('/prs/example-org/termag/9');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Reconnect GitHub');
    current.actions = actions({ overview: vi.fn(async () => { throw new GithubApiError('no such PR', 404); }) });
    expect((await get('/prs/example-org/termag/9')).status).toBe(404);
  });
});

describe('POST /api/prs/:owner/:repo/:number/review', () => {
  it('needs a signed-in user', async () => {
    expect((await post('/prs/example-org/termag/9/review', { event: 'APPROVE' }, '')).status).toBe(401);
  });
  it('submits the review and makes the next list read afresh', async () => {
    await get('/prs');
    const res = await post('/prs/example-org/termag/9/review', { event: 'COMMENT', body: 'nice' });
    expect(res.status).toBe(200);
    expect(current.actions.review).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 }, { event: 'COMMENT', body: 'nice' });
    await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(2);
  });
  it('refuses a comment with no text before calling GitHub', async () => {
    const res = await post('/prs/example-org/termag/9/review', { event: 'COMMENT', body: '' });
    expect(res.status).toBe(400);
    expect(current.actions.review).not.toHaveBeenCalled();
  });
  it('passes GitHub\'s 422 reason through', async () => {
    current.actions = actions({ review: vi.fn(async () => { throw new GithubApiError('GitHub refused the review: Can not approve your own pull request', 422); }) });
    const res = await post('/prs/example-org/termag/9/review', { event: 'APPROVE' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('Can not approve your own pull request');
  });
});

describe('POST /api/prs/:owner/:repo/:number/merge', () => {
  const sha = 'c'.repeat(40);
  it('merges now and makes the next list read afresh', async () => {
    await get('/prs');
    const res = await post('/prs/example-org/termag/9/merge', { mode: 'now', method: 'SQUASH', sha });
    expect(res.status).toBe(200);
    expect(current.actions.merge).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 }, { mode: 'now', method: 'SQUASH', sha });
    await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(2);
  });
  it('refuses a merge with no pinned sha before calling GitHub', async () => {
    expect((await post('/prs/example-org/termag/9/merge', { mode: 'now', method: 'SQUASH' })).status).toBe(400);
    expect(current.actions.merge).not.toHaveBeenCalled();
  });
  it('keeps GitHub\'s 405 and 409', async () => {
    current.actions = actions({ merge: vi.fn(async () => { throw new GithubApiError('GitHub refused the merge: Head branch was modified', 409); }) });
    const res = await post('/prs/example-org/termag/9/merge', { mode: 'now', method: 'SQUASH', sha });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Head branch was modified');
    current.actions = actions({ merge: vi.fn(async () => { throw new GithubApiError('not mergeable', 405); }) });
    expect((await post('/prs/example-org/termag/9/merge', { mode: 'now', method: 'SQUASH', sha })).status).toBe(405);
  });
});

describe('POST /api/prs/:owner/:repo/:number/rerun-failed', () => {
  it('re-runs with the user\'s token and makes the next list read afresh', async () => {
    await get('/prs');
    const res = await post('/prs/example-org/termag/9/rerun-failed', {});
    expect(await res.json()).toEqual({ rerun: [{ runId: 1, workflow: 'ci' }], refused: [], other: [] });
    expect(current.actions.rerun).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 });
    await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(2);
  });
  it('passes "nothing to re-run" through as a 422', async () => {
    current.actions = actions({ rerun: vi.fn(async () => { throw new GithubApiError('No failed checks on the latest commit', 422); }) });
    const res = await post('/prs/example-org/termag/9/rerun-failed', {});
    expect(res.status).toBe(422);
  });
});

describe('POST reviewers and comment', () => {
  it('re-requests reviews and makes the next list read afresh', async () => {
    await get('/prs');
    const res = await post('/prs/example-org/termag/9/reviewers', { users: ['@bob'] });
    expect(await res.json()).toEqual({ users: ['bob'], teams: [] });
    expect(current.actions.reviewers).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 }, { users: ['bob'], teams: [] });
    await get('/prs');
    expect(current.deps.search).toHaveBeenCalledTimes(2);
  });
  it('refuses an empty reviewer list before calling GitHub', async () => {
    expect((await post('/prs/example-org/termag/9/reviewers', {})).status).toBe(400);
    expect(current.actions.reviewers).not.toHaveBeenCalled();
  });
  it('posts a comment, and refuses an empty one', async () => {
    expect(await (await post('/prs/example-org/termag/9/comment', { body: '@bob ping' })).json()).toEqual({ url: 'https://github.com/c/1' });
    expect(current.actions.comment).toHaveBeenCalledWith(TOKEN_A, { owner: 'example-org', name: 'termag', number: 9 }, '@bob ping');
    expect((await post('/prs/example-org/termag/9/comment', { body: '' })).status).toBe(400);
  });
});

describe('the deploy stage', () => {
  it('asks for bakes in flight only while a merge waits on one, and answers the image', async () => {
    const image = { sha: 'e5'.repeat(20), createdAt: '2026-10-09T11:00:00Z' };
    const d = deps({ orchestratorImage: vi.fn(async () => image), bakeRuns: vi.fn(async () => [{ url: 'r', status: 'in_progress', event: 'schedule', createdAt: null }]) });
    const idle = await loadPipeline('u1', TOKEN_A, d);
    expect(d.bakeRuns).not.toHaveBeenCalled();
    expect(idle.deploy).toEqual({ image, bakes: null, workflowUrl: 'https://github.com/example-org/termag/actions/workflows/publish-ami.yml' });
    const waiting = deps({
      ...d,
      search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [], merged: [mergedPr()], truncated: [] })),
      contains: vi.fn(async () => false),
    });
    const got = await loadPipeline('u1', TOKEN_A, waiting);
    expect(d.bakeRuns).toHaveBeenCalledWith(TOKEN_A);
    expect(got.deploy.bakes).toHaveLength(1);
  });
  it('POST /prs/bake dispatches as the user and answers 202', async () => {
    const res = await post('/prs/bake', {});
    expect(res.status).toBe(202);
    expect(current.actions.bake).toHaveBeenCalledWith(TOKEN_A);
  });
  it('POST /prs/bake keeps GitHub\'s 403 and needs a token', async () => {
    current.actions = actions({ bake: vi.fn(async () => { throw new GithubApiError('GitHub did not start the bake: no access', 403); }) });
    expect((await post('/prs/bake', {})).status).toBe(403);
    current.token = null;
    expect((await post('/prs/bake', {})).status).toBe(409);
  });
});

describe('GET /api/version', () => {
  it('answers the running commit', async () => {
    expect(await (await get('/version')).json()).toEqual({ sha: PROD, source: 'git' });
  });
});

describe('loadPipeline', () => {
  it("asks for merged heads only for branch rows, as the viewer", async () => {
    const branch = {
      repo: 'example-org/termag', branch: 'feat', baseBranch: 'main', aheadOfBase: 1, pushed: true, dirty: false, lastCommitAt: null,
      workstream: { projectId: 'p1', projectName: 'termag', workstream: 'feat' },
    };
    const d = deps({
      branches: vi.fn(async () => ({ branches: [branch, { ...branch, branch: 'main' }], workstreams: [], offline: 0, outdatedAgent: 0, failed: 0 })),
      mergedHeads: vi.fn(async () => new Set(['example-org/termag:feat'])),
    });
    const got = await loadPipeline('u1', TOKEN_A, d);
    expect(d.mergedHeads).toHaveBeenCalledWith(TOKEN_A, 'me', [{ repo: 'example-org/termag', branch: 'feat' }]);
    expect(got.lanes.find(l => l.id === 'needs_pr')?.rows).toEqual([]);
  });
  it('says which repository each workstream is a checkout of, for the Attach picker', async () => {
    const got = await loadPipeline('u1', TOKEN_A, deps({
      branches: vi.fn(async () => ({ branches: [], workstreams: [
        { projectId: 'p1', projectName: 'termag', workstream: 'main', branch: 'main', repo: 'example-org/termag' },
        { projectId: 'p2', projectName: 'notes', workstream: 'main', branch: 'main', repo: null },
      ], offline: 0, outdatedAgent: 0, failed: 0 })),
    }));
    expect(got.checkouts).toEqual([{ projectId: 'p1', workstream: 'main', repo: 'example-org/termag' }]);
  });
  it('skips the merged-heads query when there is no branch row', async () => {
    const d = deps();
    await loadPipeline('u1', TOKEN_A, d);
    expect(d.mergedHeads).not.toHaveBeenCalled();
  });
});

describe('termagDeploys', () => {
  it('compares box commits only for a box-side merge that is already in prod', async () => {
    const contains = vi.fn(async (_t: string, _r: string, running: string) => running === PROD);
    const d = { contains, boxCommits: () => ['c3'.repeat(20), null] };
    const got = await termagDeploys(TOKEN_A, [
      mergedPr({ number: 1 }),
      mergedPr({ number: 2, files: ['agent/agent.js'] }),
      mergedPr({ number: 3, files: ['backend/x.ts'], filesTruncated: true }),
    ], { sha: PROD, source: 'git' }, d, 'u1');
    expect(got.get('example-org/termag#1')).toEqual({ state: 'deployed', boxes: 0, boxesUnknown: 0 });
    expect(got.get('example-org/termag#2')).toEqual({ state: 'orchestrator_only', boxesBehind: 1, boxesUnknown: 1, boxes: 2 });
    expect(got.get('example-org/termag#3')?.state).toBe('orchestrator_only');
    // 3 prod compares + one per box with a commit for #2 and #3.
    expect(contains).toHaveBeenCalledTimes(5);
  });
  it('checks only the viewer\'s own boxes', async () => {
    const boxCommits = vi.fn((userId: string) => (userId === 'u1' ? ['c3'.repeat(20)] : []));
    const contains = vi.fn(async (_t: string, _r: string, running: string) => running === PROD);
    const got = await termagDeploys(TOKEN_A, [mergedPr({ files: ['agent/agent.js'] })], { sha: PROD, source: 'git' }, { contains, boxCommits }, 'u1');
    expect(boxCommits).toHaveBeenCalledWith('u1');
    expect(got.get('example-org/termag#7')).toMatchObject({ state: 'orchestrator_only', boxesBehind: 1, boxes: 1 });
    const body = await loadPipeline('u2', TOKEN_A, deps({ boxCommits }));
    expect(body.boxes).toBe(0);
  });
  it('makes no compare when the merge is not in prod, or prod is unknown', async () => {
    const contains = vi.fn(async () => false);
    const got = await termagDeploys(TOKEN_A, [mergedPr({ files: ['agent/x.js'] })], { sha: PROD, source: 'git' }, { contains, boxCommits: () => ['c3'.repeat(20)] }, 'u1');
    expect(got.get('example-org/termag#7')).toEqual({ state: 'not_deployed', baked: null });
    expect(contains).toHaveBeenCalledTimes(1);
    const unknown = await termagDeploys(TOKEN_A, [mergedPr()], { sha: null, source: 'unknown' }, { contains, boxCommits: () => [] }, 'u1');
    expect(unknown.get('example-org/termag#7')?.state).toBe('unknown');
    expect(contains).toHaveBeenCalledTimes(1);
  });
  it('says whether a merge not on prod is in the newest orchestrator image', async () => {
    const IMAGE = 'e5'.repeat(20);
    const contains = vi.fn(async (_t: string, _r: string, running: string, commit: string) => running === IMAGE && commit === MERGE);
    const got = await termagDeploys(TOKEN_A, [mergedPr(), mergedPr({ number: 8, mergeCommit: 'f6'.repeat(20) })], { sha: PROD, source: 'git' },
      { contains, boxCommits: () => [] }, 'u1', { sha: IMAGE, createdAt: null });
    expect(got.get('example-org/termag#7')).toEqual({ state: 'not_deployed', baked: true });
    expect(got.get('example-org/termag#8')).toEqual({ state: 'not_deployed', baked: false });
  });
  it('ignores other repositories and merges into other bases', async () => {
    const contains = vi.fn(async () => true);
    const got = await termagDeploys(TOKEN_A, [mergedPr({ repo: 'example-org/webapp' }), mergedPr({ baseRefName: 'stacked' })], { sha: PROD, source: 'git' }, { contains, boxCommits: () => [] }, 'u1');
    expect(got.size).toBe(0);
    expect(contains).not.toHaveBeenCalled();
  });
});

describe('pipelineNotes', () => {
  it('says when check names could not be read', () => {
    expect(pipelineNotes({ truncated: [], checksMissing: 3 }, { offline: 0, outdatedAgent: 0, failed: 0 }, { sha: 'a'.repeat(40), source: 'git' }))
      .toEqual(['GitHub did not list the checks of 3 pull requests: their failing or pending state shows, the check names do not.']);
  });
  it('says what is missing and why', () => {
    const notes = pipelineNotes(
      { truncated: [{ search: 'authored', total: 73, shown: 50 }] },
      { offline: 1, outdatedAgent: 2, failed: 3 },
      { sha: null, source: 'unknown' },
    );
    expect(notes).toEqual([
      'Showing 50 of 73 your open pull requests.',
      '1 workstream on a box that is offline or stopped: not shown in In progress / Needs a PR.',
      '2 workstreams on a box whose agent predates the branch read; restart that agent.',
      '3 workstreams could not be read (a timeout, or a missing worktree): not shown in In progress / Needs a PR.',
      'The orchestrator cannot tell which commit it runs, so termag merges stay in "Merged, not deployed".',
    ]);
  });
});

describe('limit', () => {
  it('runs at most n at once and still runs them all', async () => {
    const gate = limit(2);
    let active = 0; let peak = 0;
    const task = () => gate(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return 1; });
    const got = await Promise.all(Array.from({ length: 7 }, task));
    expect(got).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(peak).toBe(2);
  });
  it('a rejection frees its slot', async () => {
    const gate = limit(1);
    await expect(gate(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await gate(async () => 2)).toBe(2);
  });
});

const send = (method: string, path: string, body?: unknown, user = 'u1') => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('deferrals', () => {
  const KEY = 'example-org/termag#99';
  it('defers a row for a day and lists it with the lanes, outside the memo', async () => {
    expect((await get('/prs')).status).toBe(200);
    const res = await send('PUT', '/prs/deferrals', { key: KEY });
    expect(await res.json()).toEqual({ key: KEY, until: '2026-10-10T12:00:00.000Z' });
    const body = await (await get('/prs')).json();
    expect(body.deferred).toEqual([{ key: KEY, until: '2026-10-10T12:00:00.000Z' }]);
    expect(current.deps.search).toHaveBeenCalledTimes(1);
  });
  it('defers again from the current end ("another day")', async () => {
    await send('PUT', '/prs/deferrals', { key: KEY });
    const res = await send('PUT', '/prs/deferrals', { key: KEY });
    expect(await res.json()).toEqual({ key: KEY, until: '2026-10-11T12:00:00.000Z' });
  });
  it('is per user', async () => {
    await send('PUT', '/prs/deferrals', { key: KEY, days: 2 });
    expect((await (await get('/prs', 'u2')).json()).deferred).toEqual([]);
  });
  it('brings a row back', async () => {
    await send('PUT', '/prs/deferrals', { key: KEY });
    const res = await send('DELETE', `/prs/deferrals?key=${encodeURIComponent(KEY)}`);
    expect(res.status).toBe(204);
    expect((await (await get('/prs')).json()).deferred).toEqual([]);
  });
  it('refuses a bad key or day count, and needs a signed-in user', async () => {
    expect((await send('PUT', '/prs/deferrals', { key: 'nope' })).status).toBe(400);
    expect((await send('PUT', '/prs/deferrals', { key: KEY, days: 0 })).status).toBe(400);
    expect((await send('DELETE', '/prs/deferrals')).status).toBe(400);
    expect((await send('PUT', '/prs/deferrals', { key: KEY }, '')).status).toBe(401);
  });
  it('still answers the lanes when the deferrals cannot be read', async () => {
    current.deferrals.list = vi.fn(async () => { throw new Error('db down'); });
    const body = await (await get('/prs')).json();
    expect(body).toMatchObject({ connected: true, deferred: [] });
  });
});

describe('workstream links', () => {
  const merged = () => vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [], merged: [mergedPr({ repo: 'Example-Org/termag' })], truncated: [] }));
  const row7 = (body: { lanes: { rows: { number: number; workstream: unknown; linkedBy?: unknown }[] }[] }) =>
    body.lanes.flatMap(l => l.rows).find(r => r.number === 7)!;
  it('attaches a PR by hand and shows it on the next read, outside the memo', async () => {
    current.deps.search = merged();
    expect(row7(await (await get('/prs')).json()).workstream).toBeNull();
    const res = await send('PUT', '/prs/links', { repo: 'example-org/termag', number: 7, projectId: 'p1', workstream: 'termag-pr-dash' });
    expect(res.status).toBe(200);
    expect(row7(await (await get('/prs')).json())).toMatchObject({ workstream: WS_LINK, linkedBy: 'manual' });
    expect(current.deps.search).toHaveBeenCalledTimes(1);
  });
  it('refuses a workstream that is not the user\'s, and bad input', async () => {
    expect((await send('PUT', '/prs/links', { repo: 'example-org/termag', number: 7, projectId: 'p2', workstream: 'x' })).status).toBe(404);
    expect((await send('PUT', '/prs/links', { repo: 'nope', number: 7, projectId: 'p1', workstream: 'x' })).status).toBe(400);
    expect((await send('PUT', '/prs/links', { repo: 'a/b', number: 0, projectId: 'p1', workstream: 'x' })).status).toBe(400);
    expect((await send('DELETE', '/prs/links?repo=a/b')).status).toBe(400);
  });
  it('detaches', async () => {
    current.deps.search = merged();
    await send('PUT', '/prs/links', { repo: 'example-org/termag', number: 7, projectId: 'p1', workstream: 'termag-pr-dash' });
    expect((await send('DELETE', '/prs/links?repo=example-org/termag&number=7')).status).toBe(204);
    expect(row7(await (await get('/prs')).json()).workstream).toBeNull();
  });
  it('stores the live checkout links a load finds', async () => {
    const recordLinks = vi.fn(async () => undefined);
    await loadPipeline('u1', TOKEN_A, deps({
      recordLinks,
      search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [], merged: [mergedPr({ headRefName: 'feat/x' })], truncated: [] })),
      branches: vi.fn(async () => ({ branches: [], workstreams: [{ ...WS_LINK, branch: 'feat/x', repo: 'example-org/termag' }], offline: 0, outdatedAgent: 0, failed: 0 })),
    }));
    expect(recordLinks).toHaveBeenCalledWith('u1', [expect.objectContaining({ number: 7, workstream: WS_LINK })]);
  });
  it('sends the stored links no lane lists as earlier PRs', async () => {
    await send('PUT', '/prs/links', { repo: 'example-org/termag', number: 41, projectId: 'p1', workstream: 'termag-pr-dash' });
    const body = await (await get('/prs')).json();
    expect(body.earlier).toEqual([{ repo: 'example-org/termag', number: 41, workstream: WS_LINK, at: null }]);
  });
  it('still answers the lanes when the links cannot be read', async () => {
    current.links.list = vi.fn(async () => { throw new Error('db down'); });
    expect((await get('/prs')).status).toBe(200);
  });
});

describe('POST /api/prs/:owner/:repo/:number/workstream', () => {
  const url = '/prs/example-org/termag/359/workstream';
  it('creates a workstream on the PR\'s own branch and attaches the PR to it', async () => {
    const res = await send('POST', url, { projectId: 'p1', name: 'termag-pr-dash' });
    expect(res.status).toBe(201);
    expect(current.createWorkstream).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'p1',
      { name: 'termag-pr-dash', branch: 'feat/pr-defer', pr: { number: 359, sameRepo: true, headOid: 'a'.repeat(40) } });
    expect(current.links.rows.get('example-org/termag#359')).toMatchObject({ source: 'manual' });
  });
  it('attaches under the adopted name when the workstream took one', async () => {
    current.createWorkstream = vi.fn(async () => ({ status: 201, body: { id: 'w9', name: 'termag-pr-dash', branch: 'feat/pr-defer' } }));
    await send('POST', url, { projectId: 'p1', name: 'something-else' });
    expect(current.links.record).toHaveBeenCalledWith('u1', { repo: 'example-org/termag', number: 359 }, { projectId: 'p1', workstream: 'termag-pr-dash' }, 'manual');
  });
  it('refuses a closed or merged PR, bad input and a missing GitHub token, and passes creation errors through', async () => {
    current.actions.head = vi.fn(async () => ({ state: 'MERGED' as const, branch: 'x', sameRepo: true, headOid: 'a'.repeat(40) }));
    expect((await send('POST', url, { projectId: 'p1', name: 'n' })).status).toBe(409);
    expect((await send('POST', url, { name: 'n' })).status).toBe(400);
    current.token = null;
    expect((await send('POST', url, { projectId: 'p1', name: 'n' })).status).toBe(409);
    current.token = TOKEN_A;
    current.actions.head = vi.fn(async () => ({ state: 'OPEN' as const, branch: 'x', sameRepo: true, headOid: 'a'.repeat(40) }));
    current.createWorkstream = vi.fn(async () => ({ status: 409, body: { error: 'update termag on the box' } }));
    const res = await send('POST', url, { projectId: 'p1', name: 'n' });
    expect(res.status).toBe(409);
    expect(current.links.record).not.toHaveBeenCalled();
  });
});
