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
    now: () => new Date('2026-10-09T12:00:00Z'),
    ...over,
  };
}

let server: Server;
let base: string;
let current: { deps: Deps; token: string | null };

beforeAll(async () => {
  const app = express();
  // The router is built once; each test swaps what it reads through `current`.
  const proxy: Deps = {
    search: (...a) => current.deps.search(...a),
    branches: (...a) => current.deps.branches(...a),
    version: () => current.deps.version(),
    contains: (...a) => current.deps.contains(...a),
    mergedHeads: (...a) => current.deps.mergedHeads(...a),
    boxCommits: () => current.deps.boxCommits(),
    now: () => current.deps.now(),
  };
  app.use('/api', prsRouter(proxy, async () => current.token));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); });
beforeEach(() => { _resetPipelineMemos(); current = { deps: deps(), token: TOKEN_A }; });

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
    expect(body).toMatchObject({ connected: true, viewer: 'me', prod: { sha: PROD, source: 'git' }, notes: [] });
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
    ], { sha: PROD, source: 'git' }, d);
    expect(got.get('example-org/termag#1')).toEqual({ state: 'deployed', boxes: 0, boxesUnknown: 0 });
    expect(got.get('example-org/termag#2')).toEqual({ state: 'orchestrator_only', boxesBehind: 1, boxesUnknown: 1, boxes: 2 });
    expect(got.get('example-org/termag#3')?.state).toBe('orchestrator_only');
    // 3 prod compares + one per box with a commit for #2 and #3.
    expect(contains).toHaveBeenCalledTimes(5);
  });
  it('makes no compare when the merge is not in prod, or prod is unknown', async () => {
    const contains = vi.fn(async () => false);
    const got = await termagDeploys(TOKEN_A, [mergedPr({ files: ['agent/x.js'] })], { sha: PROD, source: 'git' }, { contains, boxCommits: () => ['c3'.repeat(20)] });
    expect(got.get('example-org/termag#7')).toEqual({ state: 'not_deployed' });
    expect(contains).toHaveBeenCalledTimes(1);
    const unknown = await termagDeploys(TOKEN_A, [mergedPr()], { sha: null, source: 'unknown' }, { contains, boxCommits: () => [] });
    expect(unknown.get('example-org/termag#7')?.state).toBe('unknown');
    expect(contains).toHaveBeenCalledTimes(1);
  });
  it('ignores other repositories and merges into other bases', async () => {
    const contains = vi.fn(async () => true);
    const got = await termagDeploys(TOKEN_A, [mergedPr({ repo: 'example-org/webapp' }), mergedPr({ baseRefName: 'stacked' })], { sha: PROD, source: 'git' }, { contains, boxCommits: () => [] });
    expect(got.size).toBe(0);
    expect(contains).not.toHaveBeenCalled();
  });
});

describe('pipelineNotes', () => {
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
