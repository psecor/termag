import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { RouteResult } from './routeResult';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
type CliPrs = import('./cliPrs').CliPrs;
type PrsWrites = import('./prs').PrsWrites;
const { bakeNow, prWorkstreamFor, prsWrites } = await import('./prs');
const { GithubApiError } = await import('../services/githubCredential');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');
const jwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-29T00:00:00Z');

const session: CliSessionRecord = {
  id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
  createdAt: now, lastUsedAt: now, revokedAt: null,
};

const store: CliStore = {
  async findSessionByHash(hash) { return hash === sha256Hex(DEVICE) ? session : null; },
  async findSessionById(id) { return id === session.id ? session : null; },
  async validateAgentToken(raw) { return raw === BOX ? { user: alice, instanceId: 'i-devbox' } : null; },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let calls: Array<[string, ...unknown[]]>;
let next: RouteResult;

const recorded = (name: keyof PrsWrites) => async (...args: unknown[]) => { calls.push([name, ...args]); return next; };
const prs: CliPrs = {
  writes: {
    defer: recorded('defer'),
    undefer: recorded('undefer'),
    createGroup: recorded('createGroup'),
    patchGroup: recorded('patchGroup'),
    putMembers: recorded('putMembers'),
    deleteGroup: recorded('deleteGroup'),
    dismissSuggestion: recorded('dismissSuggestion'),
  },
  async bake(userId) { calls.push(['bake', userId]); return next; },
  async prWorkstream(user, params, body) { calls.push(['prWorkstream', user.id, params, body]); return next; },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), jwt: Promise.resolve(jwt), now: () => now, prs }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  next = { status: 200, body: { ok: true } };
});

function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}/api/cli/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('the desktop PR page routes', () => {
  it('hand each write to the cookie route\'s handler, as the signed-in user', async () => {
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    const steps: [string, string, unknown?][] = [
      ['PUT', '/prs/deferrals', { key: 'example-org/termag#1', days: 2 }],
      ['DELETE', '/prs/deferrals?key=example-org%2Ftermag%231'],
      ['POST', '/prs/groups', { name: 'Desktop bridge' }],
      ['PATCH', '/prs/groups/g1', { closed: true }],
      ['PUT', '/prs/groups/g1/members', { members: [] }],
      ['DELETE', '/prs/groups/g1'],
      ['POST', '/prs/group-suggestions/dismiss', { key: 'k' }],
      ['POST', '/prs/bake'],
      ['POST', '/prs/example-org/termag/42/workstream', { projectId: 'p1', name: 'termag-pr42-x' }],
    ];
    for (const [method, path, body] of steps) {
      const res = await call(method, path, token, body);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(calls).toEqual([
      ['defer', 'alice', { key: 'example-org/termag#1', days: 2 }],
      ['undefer', 'alice', 'example-org/termag#1'],
      ['createGroup', 'alice', { name: 'Desktop bridge' }],
      ['patchGroup', 'alice', 'g1', { closed: true }],
      ['putMembers', 'alice', 'g1', { members: [] }],
      ['deleteGroup', 'alice', 'g1'],
      ['dismissSuggestion', 'alice', { key: 'k' }],
      ['bake', 'alice'],
      ['prWorkstream', 'alice', { owner: 'example-org', repo: 'termag', number: '42' }, { projectId: 'p1', name: 'termag-pr42-x' }],
    ]);
  });

  it('refuse a box credential before reading the flag', async () => {
    for (const [method, path, body] of [['PUT', '/prs/deferrals', { key: 'example-org/termag#1' }], ['POST', '/prs/bake', undefined]] as const) {
      const res = await call(method, path, BOX, body);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'device_sign_in_required' });
    }
    expect(calls).toEqual([]);
  });

  it('need a credential', async () => {
    const res = await call('DELETE', '/prs/groups/g1', null);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('give a refusal the CLI\'s code', async () => {
    next = { status: 400, body: { error: 'days must be a whole number from 1 to 30' } };
    const res = await call('PUT', '/prs/deferrals', DEVICE, { key: 'example-org/termag#1', days: 99 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'days must be a whole number from 1 to 30', code: 'invalid_request' });
  });
});

describe('prWorkstreamFor', () => {
  const owner = { id: 'alice' } as Express.User;
  const head = vi.fn(async () => ({ branch: 'feat/x', state: 'OPEN', sameRepo: true, headOid: 'abc123' }));
  const links = { record: vi.fn(async () => true) } as never;

  it('makes the workstream on the PR\'s branch with the caller\'s agent, and attaches the PR', async () => {
    const create = vi.fn(async () => ({ status: 201, body: { id: 'w1', name: 'termag-pr42-x', branch: 'feat/x' } }));
    const result = await prWorkstreamFor(
      owner, { owner: 'example-org', repo: 'termag', number: '42' }, { projectId: 'p1', name: 'termag-pr42-x' },
      { provider: 'claude-chat' }, async () => 'gho_token', head as never, create as never, links,
    );
    expect(result.status).toBe(201);
    expect(create).toHaveBeenCalledWith(owner, 'p1', expect.objectContaining({
      name: 'termag-pr42-x', branch: 'feat/x', provider: 'claude-chat',
      pr: { repo: 'example-org/termag', number: 42, sameRepo: true, headOid: 'abc123' },
    }));
  });

  it('refuses a merged PR, and a PR outside the orgs termag reads', async () => {
    const create = vi.fn();
    const merged = vi.fn(async () => ({ branch: 'feat/x', state: 'MERGED', sameRepo: true, headOid: 'abc123' }));
    expect(await prWorkstreamFor(
      owner, { owner: 'example-org', repo: 'termag', number: '42' }, { projectId: 'p1', name: 'n' },
      {}, async () => 'gho_token', merged as never, create as never, links,
    )).toEqual({ status: 409, body: { error: 'The pull request is merged: nothing to work on.' } });
    expect((await prWorkstreamFor(
      owner, { owner: 'someone', repo: 'else', number: '1' }, { projectId: 'p1', name: 'n' },
      {}, async () => 'gho_token', head as never, create as never, links,
    )).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('bakeNow', () => {
  it('dispatches the bake with the user\'s token and answers where it runs', async () => {
    const bake = vi.fn(async () => {});
    expect(await bakeNow('alice', async () => 'gho_token', bake)).toEqual({
      status: 202, body: { ok: true, workflowUrl: expect.stringContaining('publish-ami.yml') },
    });
    expect(bake).toHaveBeenCalledWith('gho_token');
  });

  it('needs GitHub connected, and keeps GitHub\'s refusal', async () => {
    expect(await bakeNow('alice', async () => null, vi.fn())).toEqual({ status: 409, body: { error: 'Connect GitHub in Settings first.' } });
    const refused = vi.fn(async () => { throw new GithubApiError('You need write access to example-org/termag to bake.', 403); });
    expect(await bakeNow('alice', async () => 'gho_token', refused)).toEqual({
      status: 403, body: { error: 'You need write access to example-org/termag to bake.' },
    });
  });
});

describe('prsWrites', () => {
  const deferrals = {
    list: vi.fn(async () => []),
    defer: vi.fn(async (_u: string, input: { key: string; days: number }) => ({ key: input.key, until: '2026-10-30T00:00:00.000Z' })),
    undefer: vi.fn(async () => {}),
  };
  const groups = {
    list: vi.fn(async () => [{ id: 'g1', userId: 'alice', name: 'G', closedAt: null, createdAt: now, members: [] }]),
    create: vi.fn(async () => { throw new (await import('../services/prReview')).PrInputError('You can have at most 10 open groups: close one first'); }),
    update: vi.fn(async () => false),
    setMembers: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
  };
  const dismissals = { list: vi.fn(async () => []), dismiss: vi.fn(async () => {}) };
  const deps = { now: () => now } as unknown as Parameters<typeof prsWrites>[0];
  const writes = prsWrites(deps, async () => 'gho_token', deferrals, groups as never, dismissals);

  it('defer and bring back a row, refusing a key that is no row', async () => {
    expect(await writes.defer('alice', { key: 'example-org/termag#7' })).toEqual({
      status: 200, body: { key: 'example-org/termag#7', until: '2026-10-30T00:00:00.000Z' },
    });
    expect(deferrals.defer).toHaveBeenCalledWith('alice', { key: 'example-org/termag#7', days: 1 }, now);
    expect(await writes.undefer('alice', 'example-org/termag#7')).toEqual({ status: 204, body: null });
    expect(await writes.undefer('alice', 'not a key')).toEqual({ status: 400, body: { error: 'Not a pull request or branch' } });
  });

  it('turn the group cap into a 400, and a group that is not yours into a 404', async () => {
    expect(await writes.createGroup('alice', { name: 'Eleventh' })).toEqual({
      status: 400, body: { error: 'You can have at most 10 open groups: close one first' },
    });
    expect(await writes.patchGroup('alice', 'nope', { closed: true })).toEqual({ status: 404, body: { error: 'No such group of yours' } });
    expect(await writes.putMembers('alice', 'nope', { members: [] })).toEqual({ status: 404, body: { error: 'No such group of yours' } });
    expect(await writes.putMembers('alice', 'g1', { members: [] })).toEqual({ status: 200, body: { ok: true } });
  });

  it('dismiss a suggestion only by its key', async () => {
    expect(await writes.dismissSuggestion('alice', {})).toEqual({ status: 400, body: { error: 'key required' } });
    expect(await writes.dismissSuggestion('alice', { key: 'k' })).toEqual({ status: 204, body: null });
    expect(dismissals.dismiss).toHaveBeenCalledWith('alice', 'k');
  });

  describe('recordReviewRound (a review the desktop posted to GitHub itself)', () => {
    const HEAD = 'a'.repeat(40);
    const round = { id: 'r1', round: 2 };
    const rounds = { record: vi.fn(async () => round), latest: vi.fn(async () => []) };
    let reviewsOn = true;
    const withRounds = prsWrites({ now: () => now, reviewsOn: async () => reviewsOn } as unknown as Parameters<typeof prsWrites>[0],
      async () => 'gho_token', deferrals, groups as never, dismissals, rounds as never);
    const params = { owner: 'example-org', repo: 'termag', number: '42' };
    const body = { headSha: HEAD, event: 'REQUEST_CHANGES', comments: 3, title: 'fix: the thing', author: 'octocat' };

    it("records it as the PR's next round, with no GitHub write", async () => {
      reviewsOn = true;
      rounds.record.mockClear();
      expect(await withRounds.recordReviewRound('alice', params, body)).toEqual({ status: 200, body: { round } });
      expect(rounds.record).toHaveBeenCalledWith('alice', {
        repo: 'example-org/termag', number: 42, headSha: HEAD, event: 'REQUEST_CHANGES', comments: 3, title: 'fix: the thing', author: 'octocat',
      });
    });

    it('takes a review with no author, and refuses anything it would record wrong', async () => {
      reviewsOn = true;
      expect((await withRounds.recordReviewRound('alice', params, { ...body, author: null })).status).toBe(200);
      // A head in capitals is recorded lowercased, as web's review records it.
      rounds.record.mockClear();
      expect((await withRounds.recordReviewRound('alice', params, { ...body, headSha: 'A'.repeat(40) })).status).toBe(200);
      expect(rounds.record).toHaveBeenCalledWith('alice', expect.objectContaining({ headSha: 'a'.repeat(40) }));
      for (const bad of [{ headSha: 'abc' }, { event: 'MERGE' }, { comments: -1 }, { comments: 1.5 }, { title: 7 }, { author: 7 }]) {
        expect((await withRounds.recordReviewRound('alice', params, { ...body, ...bad })).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await withRounds.recordReviewRound('alice', { ...params, number: 'x' }, body)).status).toBe(400);
    });

    it('is not found with PR reviews off, and records nothing', async () => {
      reviewsOn = false;
      rounds.record.mockClear();
      expect(await withRounds.recordReviewRound('alice', params, body)).toEqual({ status: 404, body: { error: 'PR reviews are not on for you.', code: 'reviews-off' } });
      expect(rounds.record).not.toHaveBeenCalled();
    });
  });
});
