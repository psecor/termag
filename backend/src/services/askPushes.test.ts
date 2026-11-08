import { describe, expect, it, vi } from 'vitest';
import { confirmPushes, pushKey, pushSummary, type GithubConfig } from './askPushes';

const SHA = (c: string) => c.repeat(40);
const own = 'termag-ada/thr0000000001';

/** A fake GitHub: branch tips by name, PRs by head branch. */
function github(tips: Record<string, string>, prs: Record<string, { number: number; state: string; head?: { sha: string } }[]>, status: Record<string, number> = {}, prefixArrays = false) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    const ref = /^\/repos\/org\/api\/git\/ref\/heads\/(.+)$/.exec(u.pathname);
    if (ref) {
      const b = ref[1].split('/').map(decodeURIComponent).join('/');
      if (status[b]) return new Response('{}', { status: status[b] });
      if (tips[b]) return Response.json({ ref: `refs/heads/${b}`, object: { sha: tips[b] } });
      // GitHub can answer a missing ref with the refs it prefixes.
      const prefixed = Object.keys(tips).filter(t => t.startsWith(b));
      if (prefixArrays && prefixed.length) return Response.json(prefixed.map(t => ({ ref: `refs/heads/${t}`, object: { sha: tips[t] } })));
      return new Response('{}', { status: 404 });
    }
    if (u.pathname === '/repos/org/api/pulls') {
      const b = (u.searchParams.get('head') ?? '').replace(/^org:/, '');
      return Response.json((prs[b] ?? []).map(p => ({ ...p, html_url: `https://github.com/org/api/pull/${p.number}` })));
    }
    return new Response('{}', { status: 404 });
  });
  return { cfg: { apiBaseUrl: 'https://api.test', fetch: fetch as unknown as typeof globalThis.fetch } satisfies GithubConfig, calls, fetch };
}

describe('pushKey', () => {
  const input = { ownBranch: own, prefix: own };
  it("is '' for the thread's own branch and <name> for <prefix>-<name>", () => {
    expect(pushKey(own, input, new Map())).toBe('');
    expect(pushKey(`${own}-docs`, input, new Map())).toBe('docs');
  });

  it('keeps the key a branch already has on the thread', () => {
    expect(pushKey('feature/x', input, new Map([['x', 'feature/x']]))).toBe('x');
  });

  it("gives another PR's branch its last segment as a key, unique on the thread", () => {
    expect(pushKey('someone/Fix_Login', input, new Map())).toBe('fix-login');
    expect(pushKey('other/fix-login', input, new Map([['fix-login', 'someone/fix-login']]))).toBe('fix-login-2');
  });

  it("never gives '' to another branch, so the thread's own PR keeps it", () => {
    expect(pushKey('termag-ada/old', input, new Map())).toBe('old');
  });
});

describe('confirmPushes', () => {
  it('takes the tip and the PR from GitHub, an open PR before a closed one', async () => {
    const { cfg, calls } = github(
      { [own]: SHA('c'), [`${own}-docs`]: SHA('d') },
      { [own]: [{ number: 7, state: 'closed' }, { number: 9, state: 'open' }], [`${own}-docs`]: [{ number: 10, state: 'open' }] },
    );
    const out = await confirmPushes(cfg, {
      repo: 'org/api', token: 'gho_x', ownBranch: own, prefix: own, rows: [],
      pushes: [{ branch: own, sha: SHA('a') }, { branch: `${own}-docs`, sha: SHA('d') }],
    });
    expect(out).toEqual([
      { kind: 'recorded', branch: own, key: '', headSha: SHA('c'), prNumber: 9, prUrl: 'https://github.com/org/api/pull/9', state: 'open' },
      { kind: 'recorded', branch: `${own}-docs`, key: 'docs', headSha: SHA('d'), prNumber: 10, prUrl: 'https://github.com/org/api/pull/10', state: 'open' },
    ]);
    expect(calls).toContain(`/repos/org/api/pulls?head=org%3A${encodeURIComponent(own)}&state=all&per_page=10`);
  });

  it("sends the asker's token, never the box's", async () => {
    const { cfg, fetch } = github({ [own]: SHA('c') }, {});
    await confirmPushes(cfg, { repo: 'org/api', token: 'gho_x', ownBranch: own, prefix: own, rows: [], pushes: [{ branch: own, sha: SHA('c') }] });
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer gho_x' } });
  });

  it('says a branch has no PR yet, one deleted with no PR is gone, and a GitHub error is failed', async () => {
    const { cfg } = github({ [own]: SHA('c'), 'termag-ada/x': SHA('e') }, {}, { 'termag-ada/x': 502 });
    const out = await confirmPushes(cfg, {
      repo: 'org/api', token: 't', ownBranch: own, prefix: own, rows: [],
      pushes: [{ branch: own, sha: SHA('c') }, { branch: 'gone/branch', sha: SHA('f') }, { branch: 'termag-ada/x', sha: SHA('e') }],
    });
    expect(out.map(o => o.kind)).toEqual(['no-pr', 'gone', 'failed']);
    expect(out[2]).toMatchObject({ reason: expect.stringContaining('502') });
  });

  it("keeps a deleted branch's PR, at the PR's last head (merged and cleaned up)", async () => {
    const { cfg } = github({}, { [own]: [{ number: 9, state: 'closed', head: { sha: SHA('9') } }] });
    const out = await confirmPushes(cfg, { repo: 'org/api', token: 't', ownBranch: own, prefix: own, rows: [{ key: '', branch: own }], pushes: [{ branch: own, sha: SHA('c') }] });
    expect(out).toEqual([{ kind: 'recorded', branch: own, key: '', headSha: SHA('9'), prNumber: 9, prUrl: 'https://github.com/org/api/pull/9', state: 'closed' }]);
  });

  it("never takes a sibling branch's tip from a prefix match for a deleted branch", async () => {
    const { cfg } = github({ [`${own}-docs`]: SHA('d') }, {}, {}, true);
    const out = await confirmPushes(cfg, { repo: 'org/api', token: 't', ownBranch: own, prefix: own, rows: [], pushes: [{ branch: own, sha: SHA('c') }] });
    expect(out).toEqual([{ kind: 'gone', branch: own }]);
  });

  it('turns a network error into a failed branch rather than throwing', async () => {
    const cfg = { apiBaseUrl: 'https://api.test', fetch: vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch };
    const out = await confirmPushes(cfg, { repo: 'org/api', token: 't', ownBranch: own, prefix: own, rows: [], pushes: [{ branch: own, sha: SHA('c') }] });
    expect(out).toEqual([{ kind: 'failed', branch: own, reason: expect.stringContaining('ECONNRESET') }]);
  });
});

describe('pushSummary', () => {
  const rec = (n: number) => ({ kind: 'recorded' as const, branch: `b${n}`, key: `k${n}`, headSha: SHA('c'), prNumber: n, prUrl: `u${n}`, state: 'open' });
  it('is none, published, partial or failed', () => {
    expect(pushSummary([], 0)).toEqual({ publish: 'none', detail: null });
    expect(pushSummary([rec(1)], 1)).toEqual({ publish: 'published', detail: 'b1: PR #1' });
    expect(pushSummary([rec(1), { kind: 'no-pr', branch: 'b2', headSha: SHA('d') }], 1).publish).toBe('partial');
    expect(pushSummary([{ kind: 'no-pr', branch: 'b2', headSha: SHA('d') }], 0).publish).toBe('partial');
    expect(pushSummary([{ kind: 'failed', branch: 'b3', reason: 'r' }], 0)).toEqual({ publish: 'failed', detail: 'b3: r' });
  });

  it('leaves out branches deleted on GitHub: a later turn re-reporting one is not a failure', () => {
    expect(pushSummary([{ kind: 'gone', branch: 'old' }], 0)).toEqual({ publish: 'none', detail: null });
    expect(pushSummary([rec(1), { kind: 'gone', branch: 'old' }], 1)).toEqual({ publish: 'published', detail: 'b1: PR #1' });
  });

  it('notes, without refusing, a thread past ten PRs', () => {
    const s = pushSummary([rec(11)], 11);
    expect(s.publish).toBe('published');
    expect(s.detail).toContain('11 pull requests, more than the 10');
  });

  // Reports cmvvbgpzk586mbcmx8srqaaen and cmvvda09x16on6l7h9bts6yc3: a turn that only committed (or
  // whose canceled predecessor did) was `none` with no detail, and read as pushed.
  it('is unpushed, never none, when the clone has commits it did not push, and names the push', () => {
    expect(pushSummary([], 0, [{ branch: own, commits: 2 }], own)).toEqual({
      publish: 'unpushed', detail: `${own}: 2 commit(s) committed but not pushed (git push origin ${own})`,
    });
    const s = pushSummary([], 0, [{ branch: 'ask', commits: 1 }, { branch: `${own}-docs`, commits: 1 }, { branch: 'HEAD', commits: 3 }], own);
    expect(s.publish).toBe('unpushed');
    expect(s.detail).toBe([
      `ask: 1 commit(s) committed but not pushed (the thread's branch is ${own}: git push origin ask:${own})`,
      `${own}-docs: 1 commit(s) committed but not pushed (git push origin ${own}-docs)`,
      `a detached HEAD has 3 commit(s) on no branch, not pushed (git push origin HEAD:${own})`,
    ].join(' | '));
  });

  // A branch `gh pr checkout` made tracks its own origin branch: its commits go there, not
  // onto the thread's branch. The box knows which branches origin has, so its `to` decides.
  it("names the push the box gives, so a checked-out PR branch's commits go to that PR's branch", () => {
    expect(pushSummary([], 0, [
      { branch: 'fix/other', commits: 1, to: 'fix/other' },
      { branch: 'scratch', commits: 1, to: own },
      { branch: 'HEAD', commits: 1, to: own },
    ], own).detail).toBe([
      'fix/other: 1 commit(s) committed but not pushed (git push origin fix/other)',
      `scratch: 1 commit(s) committed but not pushed (the thread's branch is ${own}: git push origin scratch:${own})`,
      `a detached HEAD has 1 commit(s) on no branch, not pushed (git push origin HEAD:${own})`,
    ].join(' | '));
  });

  it('keeps a turn that pushed but left commits behind from published, and says which', () => {
    const s = pushSummary([rec(1)], 1, [{ branch: 'scratch', commits: 1 }], own);
    expect(s.publish).toBe('partial');
    expect(s.detail).toBe(`scratch: 1 commit(s) committed but not pushed (the thread's branch is ${own}: git push origin scratch:${own}) | b1: PR #1`);
    expect(pushSummary([{ kind: 'failed', branch: 'b3', reason: 'r' }], 0, [{ branch: own, commits: 1 }], own).publish).toBe('failed');
  });
});
