import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Review groups on the PR routes:
// GET /api/prs's `groups` and the group routes. GitHub and the database are
// behind injected deps; nothing here reaches the network.
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
const { prsRouter, loadPipeline, _resetPipelineMemos } = await import('./prs');
const { GithubApiError } = await import('../services/githubCredential');
const { keyHash } = await import('../services/prGroupSuggestions');
const { PrInputError } = await import('../services/prReview');
type Deps = Parameters<typeof loadPipeline>[2] & object;
type NumberedPr = import('../services/prPipelineGithub').NumberedPr;
type OpenPr = import('../services/prPipeline').OpenPr;
type StoredGroup = import('../services/prReviewGroups').StoredGroup;
type GroupStore = import('../services/prReviewGroups').ReviewGroupStore;

const NOW = new Date('2026-10-24T12:00:00Z');
const open = (repo: string, number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  repo, number, title: `${repo}#${number}`, url: `https://github.com/${repo}/pull/${number}`, author: 'dev', isDraft: false,
  headRefName: `b${number}`, baseRefName: 'main', updatedAt: '2026-10-24T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMerge: false, checkRollup: 'SUCCESS', checks: [], requestedReviewers: ['me'],
  requestedAt: '2026-10-24T00:00:00Z', requestedYou: true, ...over,
});
const numbered = (repo: string, number: number, over: Partial<NumberedPr> = {}): NumberedPr => {
  const o = over.open === undefined ? open(repo, number) : over.open;
  return {
    repo, number, found: true, state: 'OPEN', open: o, title: o?.title ?? `${repo}#${number}`, url: o?.url ?? 'u', author: 'dev',
    headRefName: `b${number}`, baseRefName: 'main', mergedAt: null, closedAt: null, yourReview: null, ...over,
  };
};

/** An in-memory group store with the real one's rules that matter here. */
function groupStore(): GroupStore & { rows: StoredGroup[] } {
  const rows: StoredGroup[] = [];
  let n = 0;
  const owner = new Map<string, string>();
  return {
    rows,
    list: vi.fn(async (u: string) => rows.filter(g => owner.get(g.id) === u).map(g => structuredClone(g))),
    create: vi.fn(async (u, name, members) => {
      if (name === 'one too many') throw new PrInputError('You can have at most 10 open groups: close one first');
      const g: StoredGroup = { id: `g${++n}`, name, closedAt: null, createdAt: NOW.toISOString(), members: members.map((m, i) => ({ ...m, position: i })) };
      rows.push(g);
      owner.set(g.id, u);
      return structuredClone(g);
    }),
    update: vi.fn(async (u, id, patch, now) => {
      const g = rows.find(x => x.id === id && owner.get(id) === u);
      if (!g) return false;
      if (patch.name !== undefined) g.name = patch.name;
      if (patch.closed !== undefined) g.closedAt = patch.closed ? (g.closedAt ?? now.toISOString()) : null;
      return true;
    }),
    setMembers: vi.fn(async (u, id, members) => {
      const g = rows.find(x => x.id === id && owner.get(id) === u);
      if (!g) return false;
      g.members = members.map((m, i) => ({ ...m, position: i }));
      return true;
    }),
    remove: vi.fn(async (u, id) => {
      const i = rows.findIndex(x => x.id === id && owner.get(id) === u);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

let server: Server;
let base: string;
let current: {
  deps: Deps; groups: ReturnType<typeof groupStore>; github: Map<string, NumberedPr>; byNumber: ReturnType<typeof vi.fn>;
  lite: ReturnType<typeof vi.fn>; suggestionsOn: boolean; bodies: Map<string, string>; dismissed: Set<string>;
};

function deps(over: Partial<Deps> = {}): Deps {
  return {
    search: vi.fn(async () => ({ viewer: 'me', authored: [], reviewRequested: [open('example-org/termag', 646)], merged: [], truncated: [] })),
    branches: vi.fn(async () => ({ branches: [], workstreams: [], offline: 0, outdatedAgent: 0, failed: 0 })),
    version: vi.fn(async () => ({ sha: null, source: 'unknown' as const })),
    contains: vi.fn(async () => true),
    mergedHeads: vi.fn(async () => new Set<string>()),
    boxCommits: () => [],
    orchestratorImage: vi.fn(async () => null),
    bakeRuns: vi.fn(async () => []),
    viewer: vi.fn(async () => 'me'),
    now: () => NOW,
    ...over,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const proxy: Deps = {
    search: (...a) => current.deps.search(...a),
    branches: (...a) => current.deps.branches(...a),
    version: () => current.deps.version(),
    contains: (...a) => current.deps.contains(...a),
    mergedHeads: (...a) => current.deps.mergedHeads(...a),
    boxCommits: () => current.deps.boxCommits(),
    orchestratorImage: () => current.deps.orchestratorImage(),
    bakeRuns: (...a) => current.deps.bakeRuns(...a),
    byNumber: (...a) => current.byNumber(...a),
    lite: (...a) => current.lite(...a),
    suggestionsOn: async () => current.suggestionsOn,
    viewer: (...a) => current.deps.viewer!(...a),
    now: () => current.deps.now(),
  };
  const noDeferrals = { list: async () => [], defer: vi.fn(), undefer: vi.fn() };
  const noLinks = { list: async () => [], record: vi.fn(async () => true), detach: vi.fn() };
  const actions = {
    review: vi.fn(async () => ({ id: 1, state: 'APPROVED', url: null })),
    merge: vi.fn(async () => ({ merged: true, sha: 'd'.repeat(40), autoMerge: false, message: null })),
    overview: vi.fn(async (_t: string, ref: { owner: string; name: string; number: number }) => ({ repo: `${ref.owner}/${ref.name}`, number: ref.number, title: 'PR' })),
  } as never;
  app.use('/api', prsRouter(proxy, async () => 'gho_test', actions, noDeferrals as never, noLinks as never, vi.fn() as never, {
    list: (...a) => current.groups.list(...a),
    create: (...a) => current.groups.create(...a),
    update: (...a) => current.groups.update(...a),
    setMembers: (...a) => current.groups.setMembers(...a),
    remove: (...a) => current.groups.remove(...a),
  }, {
    list: async () => new Set([...current.dismissed]),
    dismiss: async (_u: string, key: string) => { current.dismissed.add(keyHash(key)); },
  }));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  _resetPipelineMemos();
  const github = new Map<string, NumberedPr>();
  current = {
    deps: deps(),
    groups: groupStore(),
    github,
    byNumber: vi.fn(async (_t: string, _v: string, refs: { repo: string; number: number }[]) =>
      refs.map(r => github.get(`${r.repo}#${r.number}`) ?? numbered(r.repo, r.number, { found: false, state: null, open: null }))),
    lite: vi.fn(async (_t: string, refs: { repo: string; number: number }[], withBody: boolean) => refs.map(r => {
      const pr = current.github.get(`${r.repo}#${r.number}`);
      return pr
        ? { repo: r.repo, number: r.number, found: true, open: pr.state === 'OPEN', title: pr.title, url: pr.url, author: pr.author, body: withBody ? current.bodies.get(`${r.repo}#${r.number}`) ?? '' : null }
        : { repo: r.repo, number: r.number, found: false, open: false, title: '', url: '', author: null, body: null };
    })),
    suggestionsOn: true,
    bodies: new Map(),
    dismissed: new Set(),
  };
});

const call = (method: string, path: string, body?: unknown, user = 'u1') => fetch(`${base}${path}`, {
  method, headers: { 'x-test-user': user, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('review groups on GET /api/prs', () => {
  it('answers no groups, and reads nothing by number, for a user with none', async () => {
    const body = await (await call('GET', '/prs')).json();
    expect(body.groups).toEqual([]);
    expect(current.byNumber).not.toHaveBeenCalled();
  });
  it('serves each member with its state, the lane row where one lists it, and a card row where none does', async () => {
    current.github.set('example-org/termag#646', numbered('example-org/termag', 646));
    current.github.set('example-org/terraform#28576', numbered('example-org/terraform', 28576, {
      open: open('example-org/terraform', 28576, { requestedYou: false, requestedReviewers: ['someone'] }),
      yourReview: { state: 'COMMENTED', submittedAt: '2026-10-24T10:00:00Z' },
    }));
    await current.groups.create('u1', 'Desktop bridge', [
      { repo: 'example-org/termag', number: 646, note: 'the contract', title: 'stored' },
      { repo: 'example-org/terraform', number: 28576, note: null, title: 'stored' },
    ]);
    const body = await (await call('GET', '/prs')).json();
    expect(body.groups).toHaveLength(1);
    const [bridge, alb] = body.groups[0].members;
    expect(bridge).toMatchObject({ number: 646, note: 'the contract', inLane: true, askedYou: true, checked: false, state: 'open' });
    expect(bridge.row.lane).toBe('needs_my_review');
    expect(alb).toMatchObject({ number: 28576, inLane: false, askedYou: false, yourReview: 'COMMENTED', checked: true });
    expect(alb.row).toMatchObject({ lane: 'team_review', askedYou: false });
    expect(body.groups[0].done).toBe(false);
    // The lanes are unchanged: the terraform PR is in the card only.
    const rows = body.lanes.flatMap((l: { rows: { number: number }[] }) => l.rows.map(r => r.number));
    expect(rows).toEqual([646]);
  });
  it('links a card-only member like a lane row: its checkout, and where Review with Devin runs (Devin)', async () => {
    current.deps = deps({
      branches: vi.fn(async () => ({
        branches: [], offline: 0, outdatedAgent: 0, failed: 0,
        workstreams: [
          { projectId: 'p9', projectName: 'terraform', workstream: 'main', branch: 'main', repo: 'example-org/terraform' },
          { projectId: 'p9', projectName: 'terraform', workstream: 'tf-pr28576', branch: 'b28576', repo: 'example-org/terraform' },
        ],
      })),
    });
    current.github.set('example-org/terraform#28576', numbered('example-org/terraform', 28576, {
      open: open('example-org/terraform', 28576, { requestedYou: false }),
    }));
    current.github.set('example-org/terraform#28577', numbered('example-org/terraform', 28577, {
      open: open('example-org/terraform', 28577, { requestedYou: false, headRefName: 'elsewhere' }),
    }));
    await current.groups.create('u1', 'G', [
      { repo: 'example-org/terraform', number: 28576, note: null, title: 't' },
      { repo: 'example-org/terraform', number: 28577, note: null, title: 't' },
    ]);
    const body = await (await call('GET', '/prs')).json();
    const [checkedOut, other] = body.groups[0].members;
    expect(checkedOut.row).toMatchObject({
      workstream: { projectId: 'p9', workstream: 'tf-pr28576' }, linkedBy: 'checkout',
      reviewTarget: { projectId: 'p9', workstream: 'tf-pr28576' },
    });
    // No checkout on its branch: Review with Devin runs in main of the project on its repository.
    expect(other.row).toMatchObject({ workstream: null, reviewTarget: { projectId: 'p9', projectName: 'terraform', workstream: 'main' } });
    expect(body).not.toHaveProperty('linkable');
  });
  it('gives every member a pane, merged and your own included (Devin, #668)', async () => {
    current.deps = deps({
      search: vi.fn(async () => ({ viewer: 'me', authored: [open('example-org/termag', 648, { author: 'me', requestedYou: undefined })], reviewRequested: [], merged: [], truncated: [] })),
      branches: vi.fn(async () => ({
        branches: [], offline: 0, outdatedAgent: 0, failed: 0,
        workstreams: [{ projectId: 'p1', projectName: 'termag', workstream: 'main', branch: 'main', repo: 'example-org/termag' }],
      })),
    });
    current.github.set('example-org/termag#646', numbered('example-org/termag', 646, { state: 'MERGED', open: null, mergedAt: '2026-10-24T10:00:00Z' }));
    current.github.set('example-org/termag#648', numbered('example-org/termag', 648, { open: open('example-org/termag', 648, { author: 'me' }), author: 'me' }));
    current.github.set('example-org/terraform#28576', numbered('example-org/terraform', 28576, { open: open('example-org/terraform', 28576, { requestedYou: false }) }));
    await current.groups.create('u1', 'G', [
      { repo: 'example-org/termag', number: 646, note: null, title: 't' },
      { repo: 'example-org/termag', number: 648, note: null, title: 't' },
      { repo: 'example-org/terraform', number: 28576, note: null, title: 't' },
    ]);
    const body = await (await call('GET', '/prs')).json();
    const [merged, mine, tf] = body.groups[0].members;
    const termagMain = { projectId: 'p1', projectName: 'termag', workstream: 'main' };
    expect(merged).toMatchObject({ state: 'merged', inLane: false, pane: termagMain });
    expect(merged.row.reviewTarget).toBeNull();
    expect(mine).toMatchObject({ inLane: true, pane: termagMain });
    expect(mine.row.reviewTarget).toBeNull();
    // No project on terraform: no pane of its own.
    expect(tf.pane).toBeNull();
  });
  it('closes a group whose members are all merged or closed', async () => {
    current.github.set('o/r#1', numbered('o/r', 1, { state: 'MERGED', open: null, mergedAt: '2026-10-24T11:00:00Z' }));
    const g = await current.groups.create('u1', 'Finished', [{ repo: 'o/r', number: 1, note: null, title: 't' }]);
    const body = await (await call('GET', '/prs')).json();
    expect(body.groups[0]).toMatchObject({ done: true, closedAt: NOW.toISOString() });
    expect(current.groups.update).toHaveBeenCalledWith('u1', g.id, { closed: true }, NOW);
  });
  it('leaves a group open in the answer when its close could not be written (Devin)', async () => {
    current.github.set('o/r#1', numbered('o/r', 1, { state: 'MERGED', open: null, mergedAt: '2026-10-24T11:00:00Z' }));
    await current.groups.create('u1', 'Finished', [{ repo: 'o/r', number: 1, note: null, title: 't' }]);
    vi.mocked(current.groups.update).mockRejectedValueOnce(new Error('db down'));
    const body = await (await call('GET', '/prs')).json();
    expect(body.groups[0]).toMatchObject({ done: true, closedAt: null });
  });
  it('keeps the cards with what is stored when GitHub fails, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    current.byNumber = vi.fn(async () => { throw new GithubApiError('GitHub search failed (HTTP 502)', 502); });
    await current.groups.create('u1', 'G', [{ repo: 'o/r', number: 1, note: null, title: 'Stored title' }]);
    const res = await call('GET', '/prs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups[0].members[0]).toMatchObject({ state: 'unknown', title: 'Stored title', row: null, checked: false });
    expect(body.groupsError).toMatch(/Could not read the groups' pull requests/);
    expect(current.groups.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('memoizes the member read, and reads afresh when the members change, or after a review or a merge', async () => {
    current.github.set('o/r#1', numbered('o/r', 1));
    current.github.set('o/r#2', numbered('o/r', 2));
    const g = await current.groups.create('u1', 'G', [{ repo: 'o/r', number: 1, note: null, title: 't' }]);
    await call('GET', '/prs');
    await call('GET', '/prs');
    expect(current.byNumber).toHaveBeenCalledTimes(1);
    expect((await call('PUT', `/prs/groups/${g.id}/members`, { members: [{ repo: 'o/r', number: 1 }, { repo: 'o/r', number: 2 }] })).status).toBe(200);
    const calls = current.byNumber.mock.calls.length;
    await call('GET', '/prs');
    expect(current.byNumber).toHaveBeenCalledTimes(calls + 1);
    // Any review drops the member read: the reviewed PR may be in a group.
    expect((await call('POST', '/prs/example-org/termag/646/review', { event: 'APPROVE', body: '' })).status).toBe(200);
    await call('GET', '/prs');
    expect(current.byNumber).toHaveBeenCalledTimes(calls + 2);
    // So does a merge (Bugbot): it checks the member off, and can close the group.
    expect((await call('POST', '/prs/example-org/termag/646/merge', { mode: 'now', method: 'SQUASH', sha: 'a'.repeat(40) })).status).toBe(200);
    await call('GET', '/prs');
    expect(current.byNumber).toHaveBeenCalledTimes(calls + 3);
  });
});

describe('the group routes', () => {
  it('creates a group, its members titled from GitHub', async () => {
    current.github.set('example-org/termag#646', numbered('example-org/termag', 646, { title: 'Bridge' }));
    const res = await call('POST', '/prs/groups', { name: ' Desktop bridge ', members: [{ repo: 'Example-Org/Termag', number: 646, note: 'contract' }] });
    expect(res.status).toBe(201);
    expect(current.groups.create).toHaveBeenCalledWith('u1', 'Desktop bridge', [{ repo: 'example-org/termag', number: 646, note: 'contract', title: 'Bridge' }]);
    expect(current.byNumber).toHaveBeenCalledWith('gho_test', 'me', [{ repo: 'example-org/termag', number: 646, note: 'contract' }]);
  });
  it('refuses a PR GitHub does not have, naming it, and stores nothing', async () => {
    const res = await call('POST', '/prs/groups', { name: 'G', members: [{ repo: 'o/r', number: 404 }] });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('GitHub has no pull request o/r#404 that you can see.');
    expect(current.groups.create).not.toHaveBeenCalled();
  });
  it('passes a bad name, a bad list or the open-group cap back as a 400', async () => {
    expect((await call('POST', '/prs/groups', { name: '' })).status).toBe(400);
    expect((await call('POST', '/prs/groups', { name: 'G', members: [{ repo: 'x', number: 1 }] })).status).toBe(400);
    const res = await call('POST', '/prs/groups', { name: 'one too many' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 10 open groups/);
  });
  it('reorders and annotates without reading GitHub, and reads only a member that is new', async () => {
    current.github.set('o/r#3', numbered('o/r', 3, { title: 'Three' }));
    const g = await current.groups.create('u1', 'G', [
      { repo: 'o/r', number: 1, note: null, title: 'One' }, { repo: 'o/r', number: 2, note: null, title: 'Two' },
    ]);
    expect((await call('PUT', `/prs/groups/${g.id}/members`, { members: [{ repo: 'o/r', number: 2, note: 'first' }, { repo: 'o/r', number: 1 }] })).status).toBe(200);
    expect(current.byNumber).not.toHaveBeenCalled();
    expect(current.groups.rows[0].members.map(m => [m.number, m.title, m.note])).toEqual([[2, 'Two', 'first'], [1, 'One', null]]);

    expect((await call('PUT', `/prs/groups/${g.id}/members`, { members: [{ repo: 'o/r', number: 2 }, { repo: 'o/r', number: 3 }] })).status).toBe(200);
    expect(current.byNumber).toHaveBeenCalledWith('gho_test', 'me', [{ repo: 'o/r', number: 3, note: null }]);
    expect(current.groups.rows[0].members.map(m => [m.number, m.title])).toEqual([[2, 'Two'], [3, 'Three']]);
  });
  it('renames, closes, reopens and deletes only the caller\'s own group', async () => {
    const g = await current.groups.create('u2', 'Theirs', []);
    expect((await call('PATCH', `/prs/groups/${g.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await call('PUT', `/prs/groups/${g.id}/members`, { members: [] })).status).toBe(404);
    await call('DELETE', `/prs/groups/${g.id}`);
    expect(current.groups.rows).toHaveLength(1);

    const mine = await current.groups.create('u1', 'Mine', []);
    expect((await call('PATCH', `/prs/groups/${mine.id}`, { name: 'Renamed', closed: true })).status).toBe(200);
    expect(current.groups.rows[1]).toMatchObject({ name: 'Renamed', closedAt: NOW.toISOString() });
    expect((await call('PATCH', `/prs/groups/${mine.id}`, { closed: false })).status).toBe(200);
    expect(current.groups.rows[1].closedAt).toBeNull();
    expect((await call('DELETE', `/prs/groups/${mine.id}`)).status).toBe(204);
    expect(current.groups.rows.map(x => x.id)).toEqual([g.id]);
  });
});

describe('a member from another organisation (Devin, #667)', () => {
  it('opens its overview, a read with the user\'s own token, but no write takes it', async () => {
    const res = await call('GET', '/prs/pingdotgg/t3code/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: 'pingdotgg/t3code', number: 42 });
    const review = await call('POST', '/prs/pingdotgg/t3code/42/review', { event: 'APPROVE', body: '' });
    expect(review.status).toBe(400);
    expect((await review.json()).error).toMatch(/Only pull requests in example-org or example-team/);
  });
  it('still refuses a malformed owner', async () => {
    expect((await call('GET', '/prs/bad%20owner/r/1')).status).toBe(400);
  });
});

describe('suggested groups (phase 3)', () => {
  beforeEach(() => {
    current.deps = deps({
      search: vi.fn(async () => ({ viewer: 'me', authored: [], merged: [], truncated: [], reviewRequested: [
        open('example-org/termag', 646), open('example-org/termag', 647), open('example-org/termag', 700),
      ] })),
    });
    for (const n of [646, 647, 700]) current.github.set(`example-org/termag#${n}`, numbered('example-org/termag', n));
    current.github.set('example-org/terraform#28576', numbered('example-org/terraform', 28576, { title: 'ALB path' }));
    // #646 links a PR GitHub does not have first, then terraform: the pairing must survive the gap.
    current.bodies.set('example-org/termag#646', 'See example-org/termag#999 and example-org/terraform#28576.');
    current.bodies.set('example-org/termag#647', '#646 adds the orchestrator half.');
    current.bodies.set('example-org/termag#700', 'Unrelated.');
  });

  it('suggests the linked PRs, reading descriptions of reviews asked of you, and linked PRs no lane lists', async () => {
    const body = await (await call('GET', '/prs')).json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({ reason: 'references', target: null });
    expect(body.suggestions[0].members.map((m: { repo: string; number: number }) => `${m.repo}#${m.number}`))
      // Named once each, #646 and terraform (repository order), then #647, named by none.
      .toEqual(['example-org/termag#646', 'example-org/terraform#28576', 'example-org/termag#647']);
    expect(body.suggestions[0].members[1].title).toBe('ALB path');
    expect(current.lite).toHaveBeenCalledWith('gho_test', expect.arrayContaining([{ repo: 'example-org/termag', number: 646 }]), true);
    expect(current.lite).toHaveBeenCalledWith('gho_test', [{ repo: 'example-org/termag', number: 999 }, { repo: 'example-org/terraform', number: 28576 }], false);
  });
  it('pairs each looked-up PR with its own reference, past one GitHub does not have', async () => {
    // #646 names only a missing PR; #700 names terraform. Paired wrong, terraform would join #646.
    current.bodies.set('example-org/termag#646', 'See example-org/termag#999.');
    current.bodies.set('example-org/termag#647', 'Unrelated.');
    current.bodies.set('example-org/termag#700', 'Needs example-org/terraform#28576.');
    const body = await (await call('GET', '/prs')).json();
    expect(body.suggestions.map((s: { members: { repo: string; number: number }[] }) => s.members.map(m => `${m.repo}#${m.number}`)))
      .toEqual([['example-org/terraform#28576', 'example-org/termag#700']]);
  });
  it('reads descriptions once in a while, not on every poll', async () => {
    await call('GET', '/prs');
    await call('GET', '/prs');
    expect(current.lite.mock.calls.filter(c => c[2] === true)).toHaveLength(1);
  });
  it('reads nothing and suggests nothing with the flag off', async () => {
    current.suggestionsOn = false;
    const body = await (await call('GET', '/prs')).json();
    expect(body.suggestions).toEqual([]);
    expect(current.lite).not.toHaveBeenCalled();
  });
  it('keeps a dismissed suggestion away', async () => {
    const [s] = (await (await call('GET', '/prs')).json()).suggestions;
    expect((await call('POST', '/prs/group-suggestions/dismiss', { key: s.key })).status).toBe(204);
    expect((await (await call('GET', '/prs')).json()).suggestions).toEqual([]);
    expect((await call('POST', '/prs/group-suggestions/dismiss', {})).status).toBe(400);
  });
  it('suggests adding the rest to a group that holds some', async () => {
    await current.groups.create('u1', 'Desktop bridge', [{ repo: 'example-org/termag', number: 646, note: null, title: 't' }]);
    const [s] = (await (await call('GET', '/prs')).json()).suggestions;
    expect(s.target).toMatchObject({ name: 'Desktop bridge' });
    expect(s.members.map((m: { number: number }) => m.number)).toEqual([28576, 647]);
  });
  it('suggests nothing, and still lists, when GitHub fails the read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    current.lite = vi.fn(async () => { throw new GithubApiError('GitHub search failed (HTTP 502)', 502); });
    const res = await call('GET', '/prs');
    expect(res.status).toBe(200);
    expect((await res.json()).suggestions).toEqual([]);
    warn.mockRestore();
  });
});

