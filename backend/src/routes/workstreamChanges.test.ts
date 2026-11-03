import { describe, it, expect, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../db', () => ({ prisma: {} }));

const { branchParam, parseChanges, workstreamChangesRouter, worktreeUnder } = await import('./workstreamChanges');
type Deps = NonNullable<Parameters<typeof workstreamChangesRouter>[0]>;

const DIR = '/home/ada/termag/projects/webapp';
const HOST = { userId: 'owner', instanceId: 'box-1' };
const ANSWER = {
  toplevel: `${DIR}/.worktrees/topic`, worktree: true, branch: 'topic', head: 'a'.repeat(40), upstream: 'origin/topic', against: 'origin/topic',
  commits: 1,
  committed: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }],
  uncommitted: [{ path: 'notes.md', status: '?', additions: 2, deletions: 0 }, { path: 'img.png', status: 'A', additions: null, deletions: null }],
  truncated: false,
};

function deps(over: Partial<Deps> = {}): Deps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    enabled: async () => true,
    find: async () => ({ host: HOST, dir: DIR }),
    connected: () => true,
    capabilities: () => ['git-changes-v1'],
    send: async (_h, type, payload) => { sent.push({ type, payload }); return ANSWER; },
    ...over,
  };
}

/** The route's own handlers, run in order as express would. */
async function get(d: Deps, query: Record<string, unknown> = {}) {
  const router = workstreamChangesRouter(d);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> }).stack
    .find(l => l.route?.path === '/projects/:projectId/workstreams/:workstream/changes')!;
  let status = 200; let body: unknown = null;
  const req = { params: { projectId: 'p1', workstream: 'main' }, query, user: { id: 'u1' } };
  // requireAuth is the first handler; the route's own (in asyncHandler) is the last. It answers with res.json.
  const own = layer.route!.stack[layer.route!.stack.length - 1].handle;
  await new Promise<void>((resolve, reject) => {
    const res = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; resolve(); return this; } };
    own(req as never, res as never, (err?: unknown) => reject(err ?? new Error('next() without an answer')));
  });
  return { status, body };
}

describe('GET …/workstreams/:workstream/changes', () => {
  it("answers the box's in-flight changes, with the worktree it read", async () => {
    const d = deps();
    const { status, body } = await get(d, { branch: 'topic' });
    expect(status).toBe(200);
    expect(body).toEqual({
      available: true, branch: 'topic', upstream: 'origin/topic', against: 'origin/topic', commits: 1,
      committed: ANSWER.committed, uncommitted: ANSWER.uncommitted, truncated: false, partial: false, worktree: '.worktrees/topic',
    });
    expect(d.sent).toEqual([{ type: 'git-changes', payload: { cwd: DIR, branch: 'topic' } }]);
  });

  it('passes no branch it would not trust', async () => {
    const d = deps();
    await get(d, { branch: '--upload-pack=x' });
    await get(d, { branch: ['a', 'b'] });
    expect(d.sent).toEqual([{ type: 'git-changes', payload: { cwd: DIR } }, { type: 'git-changes', payload: { cwd: DIR } }]);
  });

  it('is a 404 with the flag off, or for a project the caller cannot see', async () => {
    expect((await get(deps({ enabled: async () => false }))).status).toBe(404);
    expect((await get(deps({ find: async () => null }))).status).toBe(404);
  });

  it('never wakes a box: a box that is down or an agent without git-changes-v1 says so, unasked', async () => {
    const off = deps({ connected: () => false });
    expect((await get(off)).body).toEqual({ available: false, reason: 'offline' });
    const old = deps({ capabilities: () => ['git-branch-state-v1'] });
    expect((await get(old)).body).toEqual({ available: false, reason: 'outdated-agent' });
    expect([...off.sent, ...old.sent]).toEqual([]);
  });

  it('a failed or malformed answer is unreadable', async () => {
    expect((await get(deps({ send: async () => { throw new Error('Unknown command'); } }))).body).toEqual({ available: false, reason: 'unreadable' });
    expect((await get(deps({ send: async () => ({ nope: true }) }))).body).toEqual({ available: false, reason: 'unreadable' });
  });
});

describe('parseChanges', () => {
  it('drops files it cannot vouch for, and cuts each list at 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}`, status: 'M', additions: 1, deletions: 0 }));
    const got = parseChanges({
      ...ANSWER, worktree: false,
      committed: [{ path: '', status: 'M' }, { path: 'x', status: 'Z' }, { path: 'ok', status: 'R', from: 'old', additions: -1, deletions: 2.5 }],
      uncommitted: many,
    }, DIR);
    expect(got.available && got.committed).toEqual([{ path: 'ok', from: 'old', status: 'R', additions: null, deletions: null }]);
    expect(got.available && got.uncommitted.length).toBe(200);
    expect(got.available && got.worktree).toBeNull();
  });
  it("passes on that the committed files couldn't be read", () => {
    const got = parseChanges({ ...ANSWER, committed: [], partial: true }, DIR);
    expect(got.available && [got.partial, got.commits, got.committed]).toEqual([true, 1, []]);
  });
});

describe('worktreeUnder', () => {
  it("names a worktree under the workstream's checkout, and nothing else", () => {
    expect(worktreeUnder(DIR, `${DIR}/.worktrees/topic`)).toBe('.worktrees/topic');
    expect(worktreeUnder(`${DIR}/`, `${DIR}/.worktrees/topic`)).toBe('.worktrees/topic');
    expect(worktreeUnder(DIR, '/home/ada/src/webapp-topic')).toBeNull();
    expect(worktreeUnder(DIR, DIR)).toBeNull();
    expect(worktreeUnder(DIR, `${DIR}/../other`)).toBeNull();
    expect(worktreeUnder(DIR, 42)).toBeNull();
  });
});

describe('branchParam', () => {
  it('takes a plain branch name', () => {
    expect(branchParam('jonny/pr-info-refresh')).toBe('jonny/pr-info-refresh');
    for (const bad of ['', '-x', 'a b', 'a..b', 'a;b', 'x'.repeat(256), 1, null, ['a']]) expect(branchParam(bad)).toBeNull();
  });
});
