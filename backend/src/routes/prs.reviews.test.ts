import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// PR reviews in the simple UI on the PR routes:
// the routes it added answer only while simple-ui-reviews-enabled is on for
// the caller. GitHub and the database are behind injected deps; nothing here
// reaches the network.
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/agentRegistry', () => ({ connectedOwnedBoxes: () => [], isProjectAgentConnected: () => false, sendForProject: vi.fn() }));
vi.mock('../services/credentialStore', () => ({ githubTokenSource: async () => null }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { headers: Record<string, string>; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'] };
    next();
  },
  requireAuthOrAgentToken: (_req: unknown, _res: unknown, next: () => void) => { next(); },
}));
const { prsRouter, prsLister, loadPipeline, _resetPipelineMemos } = await import('./prs');
type Rounds = import('../services/prReviewRounds').ReviewRoundStore;
type Deps = Parameters<typeof loadPipeline>[2] & object;
type Actions = NonNullable<Parameters<typeof prsRouter>[2]>;

const TOKEN = 'gho_' + 'a'.repeat(36);
const FILES = { files: [{ path: 'agent/tunnel-dial.js', status: 'modified', additions: 38, deletions: 6, patch: '@@ -1 +1 @@\n-a\n+b', previous: null }], truncated: false };
const THREADS = [{ id: 't1', path: 'agent/tunnel-dial.js', line: 1, resolved: false, outdated: false, comments: [] }];

let server: Server;
let base: string;
let current: { on: boolean; actions: Partial<Actions>; rounds: Rounds };

function deps(): Deps {
  return {
    search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [], merged: [], truncated: [] })),
    branches: vi.fn(async () => ({ branches: [], workstreams: [], offline: 0, outdatedAgent: 0, failed: 0 })),
    version: vi.fn(async () => ({ sha: 'a1'.repeat(20), source: 'git' as const })),
    contains: vi.fn(async () => true),
    mergedHeads: vi.fn(async () => new Set<string>()),
    boxCommits: () => [],
    orchestratorImage: vi.fn(async () => null),
    bakeRuns: vi.fn(async () => []),
    reviewsOn: async () => current.on,
    now: () => new Date('2026-10-29T12:00:00Z'),
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const act = (name: keyof Actions) => (...a: unknown[]) => (current.actions[name] as (...x: unknown[]) => unknown)(...a);
  const rounds: Rounds = { record: (...a) => current.rounds.record(...a), latest: (...a) => current.rounds.latest(...a) };
  app.use('/api', prsRouter(deps(), async () => TOKEN, {
    files: act('files'), threads: act('threads'), review: act('review'),
  } as unknown as Actions, undefined, undefined, undefined, undefined, undefined, rounds));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  _resetPipelineMemos();
  current = {
    on: true,
    actions: {
      files: vi.fn(async () => FILES) as never, threads: vi.fn(async () => THREADS) as never,
      review: vi.fn(async () => ({ id: 1, state: 'CHANGES_REQUESTED', url: 'https://github.com/example-org/termag/pull/804#pullrequestreview-1' })) as never,
    },
    rounds: { record: vi.fn(async (_u, r) => ({ ...r, round: 1, postedAt: '2026-10-29T12:00:00Z' })), latest: vi.fn(async () => []) },
  };
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { 'x-test-user': 'u1' } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-test-user': 'u1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const HEAD = 'c'.repeat(40);
const CARD = { event: 'REQUEST_CHANGES', body: 'Two holds.', comments: [{ path: 'agent/tunnel-dial.js', line: 1, side: 'RIGHT', body: 'Skip the check when nothing is queued.' }], commitId: HEAD };

describe('Files changed: GET /api/prs/:owner/:repo/:n/files and /threads', () => {
  it('reads the diff and the review threads with the caller\'s token while the flag is on', async () => {
    expect(await (await get('/prs/example-org/termag/804/files')).json()).toEqual(FILES);
    expect(await (await get('/prs/example-org/termag/804/threads')).json()).toEqual({ threads: THREADS });
    expect(current.actions.files).toHaveBeenCalledWith(TOKEN, { owner: 'example-org', name: 'termag', number: 804 });
  });

  it('answers 404 while simple-ui-reviews-enabled is off for the caller, and reads nothing', async () => {
    current.on = false;
    for (const path of ['/prs/example-org/termag/804/files', '/prs/example-org/termag/804/threads']) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'reviews-off' });
    }
    expect(current.actions.files).not.toHaveBeenCalled();
    expect(current.actions.threads).not.toHaveBeenCalled();
  });
});

describe('Posting a review card: POST /api/prs/:owner/:repo/:n/review', () => {
  it('posts the inline comments, pinned to the head, while the flag is on, and records the round', async () => {
    const res = await post('/prs/example-org/termag/804/review', { ...CARD, title: 'Forward: slow readers', author: 'e2e-fabian' });
    expect(res.status).toBe(200);
    expect(current.rounds.record).toHaveBeenCalledWith('u1', {
      repo: 'example-org/termag', number: 804, headSha: HEAD, event: 'REQUEST_CHANGES', comments: 1, title: 'Forward: slow readers', author: 'e2e-fabian',
    });
    expect(current.actions.review).toHaveBeenCalledWith(TOKEN, { owner: 'example-org', name: 'termag', number: 804 },
      expect.objectContaining({ event: 'REQUEST_CHANGES', commitId: HEAD, comments: [expect.objectContaining({ path: 'agent/tunnel-dial.js', line: 1 })] }));
  });

  it('refuses inline comments or a pinned head while it is off, and the lab\'s summary-only review still posts', async () => {
    current.on = false;
    for (const body of [CARD, { event: 'COMMENT', body: 'x', commitId: HEAD }]) {
      const res = await post('/prs/example-org/termag/804/review', body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'reviews-off' });
    }
    expect(current.actions.review).not.toHaveBeenCalled();
    expect((await post('/prs/example-org/termag/804/review', { event: 'COMMENT', body: 'Looks good.' })).status).toBe(200);
    expect(current.actions.review).toHaveBeenCalledTimes(1);
  });
});

describe('Rounds: GET /api/prs carries reviewRounds', () => {
  const ROUND = {
    repo: 'example-org/termag', number: 804, round: 2, headSha: HEAD, event: 'APPROVE' as const, comments: 0, title: 'Forward', author: 'e2e-fabian',
    postedAt: '2026-10-29T11:00:00Z', earlier: [{ round: 1, event: 'REQUEST_CHANGES' as const, comments: 3, postedAt: '2026-10-28T11:00:00Z' }],
  };
  const lister = (on: boolean, rounds: Rounds, headOf: Parameters<typeof prsLister>[7], token: () => string = () => TOKEN) => prsLister(
    { ...deps(), reviewsOn: async () => on }, async () => token(),
    { list: async () => [], defer: vi.fn(), undefer: vi.fn() } as never,
    { list: async () => [], record: async () => true, detach: async () => {} } as never,
    { list: async () => [] } as never, { list: async () => new Set<string>(), dismiss: vi.fn() } as never,
    rounds, headOf);

  it('reads each PR\'s latest round, its earlier ones and its head now, while the flag is on', async () => {
    const headOf = vi.fn(async () => ({ state: 'MERGED' as const, branch: 'forward-stall', sameRepo: true, headOid: HEAD.toUpperCase() }));
    const res = await lister(true, { record: vi.fn(), latest: vi.fn(async () => [ROUND]) }, headOf)('u-rounds-on');
    expect((res.body as { reviewRounds: unknown[] }).reviewRounds).toEqual([
      expect.objectContaining({ number: 804, round: 2, earlier: ROUND.earlier, now: expect.objectContaining({ state: 'merged', headSha: HEAD, askedAgain: false }) }),
    ]);
  });

  it('keeps no failed head read, and reads the head again under another token', async () => {
    const head = { state: 'OPEN' as const, branch: 'forward-stall', sameRepo: true, headOid: HEAD };
    const headOf = vi.fn().mockRejectedValueOnce(new Error('GitHub blipped')).mockResolvedValue(head);
    let token = TOKEN;
    const list = lister(true, { record: vi.fn(), latest: vi.fn(async () => [ROUND]) }, headOf, () => token);
    const nowOf = async () => ((await list('u-heads')).body as { reviewRounds: Array<{ now: unknown }> }).reviewRounds[0].now;
    expect(await nowOf()).toBeNull();                          // the blip: no head, and none kept
    expect(await nowOf()).toMatchObject({ headSha: HEAD });    // read again at once
    expect(await nowOf()).toMatchObject({ headSha: HEAD });    // now from the memo
    expect(headOf).toHaveBeenCalledTimes(2);
    token = 'gho_' + 'b'.repeat(36);                           // reconnected as someone else
    await nowOf();
    expect(headOf).toHaveBeenCalledTimes(3);
    expect(headOf).toHaveBeenLastCalledWith(token, { owner: 'example-org', name: 'termag', number: 804 });
  });

  it('asks for round 2 only on a review request newer than the round, not on a request GitHub kept', async () => {
    const head = { state: 'OPEN' as const, branch: 'forward-stall', sameRepo: true, headOid: HEAD };
    const open = (requestedAt: string) => ({
      repo: 'example-org/termag', number: 804, title: 'Forward', url: 'https://github.com/example-org/termag/pull/804', author: 'e2e-fabian', isDraft: false,
      headRefName: 'forward-stall', baseRefName: 'main', updatedAt: requestedAt, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED', autoMerge: false, checkRollup: 'SUCCESS', checks: [], requestedReviewers: ['me'], requestedAt, requestedYou: true,
    });
    const askedAgain = async (requestedAt: string) => {
      _resetPipelineMemos();
      const list = prsLister(
        { ...deps(), reviewsOn: async () => true, search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [open(requestedAt)], merged: [], truncated: [] })) as never },
        async () => TOKEN,
        { list: async () => [], defer: vi.fn(), undefer: vi.fn() } as never,
        { list: async () => [], record: async () => true, detach: async () => {} } as never,
        { list: async () => [] } as never, { list: async () => new Set<string>(), dismiss: vi.fn() } as never,
        { record: vi.fn(), latest: vi.fn(async () => [{ ...ROUND, event: 'COMMENT' as const, postedAt: '2026-10-29T11:00:00Z' }]) }, vi.fn(async () => head));
      return ((await list('u-asked')).body as { reviewRounds: Array<{ now: { askedAgain: boolean } }> }).reviewRounds[0].now.askedAgain;
    };
    // Asked before the COMMENT review: GitHub kept the request, so it's still waiting on the author.
    expect(await askedAgain('2026-10-29T10:00:00Z')).toBe(false);
    // Asked after it: round 2.
    expect(await askedAgain('2026-10-29T12:00:00Z')).toBe(true);
  });

  it('lists the PRs without rounds when the flag lookup fails', async () => {
    const latest = vi.fn(async () => [ROUND]);
    const list = prsLister(
      { ...deps(), reviewsOn: async () => { throw new Error('database blipped'); } }, async () => TOKEN,
      { list: async () => [], defer: vi.fn(), undefer: vi.fn() } as never,
      { list: async () => [], record: async () => true, detach: async () => {} } as never,
      { list: async () => [] } as never, { list: async () => new Set<string>(), dismiss: vi.fn() } as never,
      { record: vi.fn(), latest }, vi.fn());
    const res = await list('u-flag-blip');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lanes: expect.any(Array) });
    expect(res.body).not.toHaveProperty('reviewRounds');
    expect(latest).not.toHaveBeenCalled();
  });

  it("keeps the round of every PR a lane lists, past the newest others it reads heads for", async () => {
    const at = (n: number) => new Date(Date.parse('2026-10-29T12:00:00Z') - n * 60_000).toISOString();
    const rounds = Array.from({ length: 42 }, (_, i) => ({ ...ROUND, number: 900 + i, round: 1, earlier: [], postedAt: at(i), event: 'COMMENT' as const }));
    const asked = { repo: 'example-org/termag', number: 941, title: 'Oldest', url: '', author: 'e2e-fabian', isDraft: false, headRefName: 'b', baseRefName: 'main',
      updatedAt: at(50), reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMerge: false, checkRollup: 'SUCCESS', checks: [],
      requestedReviewers: ['me'], requestedAt: at(50), requestedYou: true };
    _resetPipelineMemos();
    const list = prsLister(
      { ...deps(), reviewsOn: async () => true, search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [asked], merged: [], truncated: [] })) as never },
      async () => TOKEN,
      { list: async () => [], defer: vi.fn(), undefer: vi.fn() } as never,
      { list: async () => [], record: async () => true, detach: async () => {} } as never,
      { list: async () => [] } as never, { list: async () => new Set<string>(), dismiss: vi.fn() } as never,
      { record: vi.fn(), latest: vi.fn(async () => rounds) }, vi.fn(async () => ({ state: 'OPEN' as const, branch: 'b', sameRepo: true, headOid: HEAD })));
    const got = ((await list('u-cap')).body as { reviewRounds: Array<{ number: number }> }).reviewRounds.map(r => r.number);
    expect(got).toHaveLength(41);
    expect(got).toContain(941);       // in a lane: kept, though the oldest
    expect(got).not.toContain(940);   // the 41st newest of the others: past the cap
  });

  it('reads no rounds and no heads while it is off', async () => {
    const latest = vi.fn(async () => [ROUND]);
    const headOf = vi.fn();
    const res = await lister(false, { record: vi.fn(), latest }, headOf as never)('u-rounds-off');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('reviewRounds');
    expect(latest).not.toHaveBeenCalled();
    expect(headOf).not.toHaveBeenCalled();
  });
});
