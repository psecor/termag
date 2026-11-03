// Publishing to another PR (`termag ask --update-pr`, docs/agent-messaging.md,
// "Publishing to another PR"), with real git: a fake GitHub serves a bare repo
// over file://, and the thread's clone is made the way termag-subagent-run
// makes it (one commit of the base) before the run fetches the PR's branch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  bundlePrerequisites, publishBundle, resolveTargetPr, targetPrRefusal,
  type PrOutcome, type PublishConfig, type PublishInput,
} from './askPublish';
import { askPrBranch, prBody, runSystemPrompt } from './agentMessages';

const ASKER = 'alice@example.com';
const PR = 753;
const PR_BRANCH = 'termag-alice/oldthread';

let root: string;
let ghBase: string;
let remote: string;
let seed: string;
let clone: string;
let baseSha: string;
let api: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;
/** PR #753 as the fake GitHub has it; head.sha is read from the bare repo on each GET. */
let pr: Record<string, unknown>;
let body: string | null;
let login: string;
/** Other open PRs on the fake GitHub (a stack on #753, someone else's), by number. */
let others: Array<Record<string, unknown>>;

function git(cwd: string, args: string[], email = ASKER): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: email,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function commitIn(dir: string, path: string, content: string, message: string, email = ASKER): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, ['add', path], email);
  git(dir, ['commit', '-q', '-m', message], email);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The thread's clone as the runner leaves it, then the run's fetch of the PR (the system prompt's command). */
function cloneAndFetchPr(): void {
  clone = join(root, `clone-${Math.random().toString(36).slice(2)}`);
  git(root, ['init', '-q', clone]);
  git(clone, ['fetch', '-q', '--depth=1', '--no-tags', `file://${remote}`, baseSha]);
  git(clone, ['checkout', '-q', '-b', 'ask', 'FETCH_HEAD']);
  git(clone, ['fetch', '-q', '--unshallow', '--no-tags', `file://${remote}`, `+refs/heads/${PR_BRANCH}:refs/remotes/termag/target`]);
  git(clone, ['reset', '-q', '--hard', 'refs/remotes/termag/target']);
}

/** A thread's clone at `sha`, as the runner makes it, with no PR fetched. */
function cloneOf(sha: string): string {
  const dir = join(root, `base-${Math.random().toString(36).slice(2)}`);
  git(root, ['init', '-q', dir]);
  git(dir, ['fetch', '-q', '--depth=1', '--no-tags', `file://${remote}`, sha]);
  git(dir, ['checkout', '-q', '-b', 'ask', 'FETCH_HEAD']);
  return dir;
}

function bundleOf(dir: string): Buffer {
  const file = join(root, `b-${Math.random().toString(36).slice(2)}.bundle`);
  git(dir, ['bundle', 'create', '-q', file, 'refs/heads/ask', `^${baseSha}`]);
  return readFileSync(file);
}

/** The bundle as the runner makes it: the clone's branches, `^<base>`. */
function bundle(refs = ['refs/heads/ask']): Buffer {
  const file = join(root, `b-${Math.random().toString(36).slice(2)}.bundle`);
  git(clone, ['bundle', 'create', '-q', file, ...refs, `^${baseSha}`]);
  return readFileSync(file);
}

const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
const tip = (ref: string) => { try { return git(remote, ['rev-parse', `refs/heads/${ref}`]); } catch { return null; } };
const resolveRef = (r: string) => (/^[0-9a-f]{40}$/.test(r) ? r : tip(r));

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  const b = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  api.push({ method, url: u, body: b });
  if (method === 'GET' && u.endsWith(`/pulls/${PR}`)) return json(200, view(pr));
  const other = /\/pulls\/(\d+)$/.exec(u);
  if (method === 'GET' && other) {
    const o = others.find(p => p.number === Number(other[1]));
    return o ? json(200, view(o)) : json(404, { message: 'Not Found' });
  }
  const files = /\/pulls\/(\d+)\/files\?/.exec(u);
  if (method === 'GET' && files) {
    const p = [pr, ...others].find(x => x.number === Number(files[1]));
    if (!p || /[?&]page=([2-9]|\d\d)/.test(u)) return json(200, []);
    const head = String((p.head as Record<string, unknown>).ref);
    const names = git(remote, ['diff', '--name-only', `main...${head}`]).split('\n').filter(Boolean);
    return json(200, names.map(filename => ({ filename })));
  }
  if (method === 'PATCH' && u.endsWith(`/pulls/${PR}`)) { body = String(b?.body); return json(200, {}); }
  if (method === 'GET' && u.endsWith('/user')) return json(200, { login });
  if (method === 'GET' && u.endsWith('/repos/org/repo')) return json(200, { default_branch: 'main' });
  // compare a...b: `ahead` when b descends from a, `behind` when a descends from b, as GitHub answers.
  const cmp = /\/repos\/org\/repo\/compare\/([^?]+)\.\.\.([0-9a-f]{40})\?/.exec(u);
  if (method === 'GET' && cmp) {
    const a = resolveRef(decodeURIComponent(cmp[1]));
    const c = cmp[2];
    try { git(remote, ['cat-file', '-e', `${c}^{commit}`]); } catch { return json(404, { message: 'Not Found' }); }
    if (!a) return json(404, { message: 'Not Found' });
    if (a === c) return json(200, { status: 'identical' });
    const anc = (x: string, y: string) => { try { git(remote, ['merge-base', '--is-ancestor', x, y]); return true; } catch { return false; } };
    return json(200, { status: anc(a, c) ? 'ahead' : anc(c, a) ? 'behind' : 'diverged' });
  }
  if (method === 'GET' && u.includes('/pulls?')) {
    const head = decodeURIComponent(/head=([^&]+)/.exec(u)?.[1] ?? '').replace(/^[^:]*:/, '');
    const open = [pr, ...others].filter(p => p.state === 'open' && (!head || (p.head as Record<string, unknown>).ref === head));
    return json(200, /[?&]page=([2-9]|\d\d)/.test(u) ? [] : open.map(view));
  }
  // Only a run's pr/<name> branch opens one; the tests check no other POST is made.
  if (method === 'POST' && u.endsWith('/pulls')) return json(201, { number: 900, html_url: 'https://github.com/org/repo/pull/900' });
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

/** A PR as GET /pulls answers: its head's sha read from the bare repo now, and #753's body. */
function view(p: Record<string, unknown>): Record<string, unknown> {
  const head = p.head as Record<string, unknown>;
  return { ...p, head: { ...head, sha: tip(String(head.ref)) }, ...(p.number === PR ? { body } : {}) };
}

const cfg = (): PublishConfig => ({ gitBaseUrl: `file://${ghBase}`, apiBaseUrl: 'https://api.example', fetch: fakeFetch });
const meta = { senderUsername: 'alice', target: 'dev/repo', threadId: 'newthread', box: 'i-0abc', project: 'repo' };
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  bundle: bundle(), baseSha, repo: 'org/repo', token: 'gho_secret', askerEmail: ASKER,
  branchFor: key => askPrBranch('alice', 'newthread', key),
  prBody: (description, key, onTarget) => prBody({ ...meta, description, prKey: key || undefined, targetPr: onTarget }),
  prDescriptions: {}, prNumbers: { '': PR },
  askerUnix: 'alice',
  target: { number: PR, askerUnix: 'alice', firstPublish: false },
  ...over,
});
const only = async (i: PublishInput): Promise<PrOutcome> => {
  const o = await publishBundle(cfg(), i);
  if (o.kind !== 'done') throw new Error(`${o.kind}: ${o.reason}`);
  expect(o.prs).toHaveLength(1);
  return o.prs[0];
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-target-pr-test-'));
  ghBase = join(root, 'gh');
  remote = join(ghBase, 'org', 'repo.git');
  mkdirSync(remote, { recursive: true });
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  seed = join(root, 'seed');
  git(root, ['init', '-q', '-b', 'main', seed]);
  // main: X, then the PR forks at X, then main changes a workflow (Y) and moves on to the thread's base (B).
  commitIn(seed, 'README.md', 'hello\n', 'initial', 'owner@example.com');
  const x = commitIn(seed, 'src/x.ts', 'x\n', 'x', 'owner@example.com');
  git(seed, ['checkout', '-q', '-b', PR_BRANCH]);
  commitIn(seed, 'src/feature.ts', 'export const f = 1;\n', 'feat: the PR, first commit');
  commitIn(seed, 'src/feature.ts', 'export const f = 2;\n', 'feat: the PR, second commit');
  git(seed, ['checkout', '-q', 'main']);
  expect(git(seed, ['rev-parse', 'HEAD'])).toBe(x);
  commitIn(seed, '.github/workflows/ci.yml', 'on: push\n', 'ci: a workflow on main', 'owner@example.com');
  baseSha = commitIn(seed, 'src/y.ts', 'y\n', 'y', 'owner@example.com');
  git(seed, ['push', '-q', remote, 'main', PR_BRANCH]);
  api = [];
  body = null;
  login = 'alice-gh';
  others = [];
  pr = {
    number: PR, state: 'open', html_url: `https://github.com/org/repo/pull/${PR}`, user: { login: 'alice-gh' }, commits: 2,
    head: { ref: PR_BRANCH, repo: { full_name: 'org/repo' } },
    base: { ref: 'main', repo: { full_name: 'org/repo', default_branch: 'main' } },
  };
  cloneAndFetchPr();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('targetPrRefusal: whose PR it is', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    number: PR, state: 'open', html_url: 'u', user: { login: 'alice-gh' },
    head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: { full_name: 'org/repo' } },
    base: { ref: 'main', repo: { full_name: 'org/repo', default_branch: 'main' } },
    ...over,
  });
  const ctx = { repo: 'org/repo', number: PR, askerUnix: 'alice', askerLogin: 'alice-gh' };
  const refusal = (v: Record<string, unknown> | null, c = ctx) => {
    const r = targetPrRefusal(v, c);
    return 'refused' in r ? r.refused : null;
  };

  it("takes a PR the asker opened, or any on a termag-<asker>/ branch, in the same repository", () => {
    expect(targetPrRefusal(view(), ctx)).toEqual({ target: { number: PR, url: 'u', branch: 'feature/x', headSha: 'a'.repeat(40), baseBranch: 'main' } });
    expect(refusal(view({ user: { login: 'bob' }, head: { ref: 'termag-alice/t1', sha: 'b'.repeat(40), repo: { full_name: 'Org/Repo' } } }), { ...ctx, askerLogin: null })).toBeNull();
    expect(refusal(view(), { ...ctx, askerLogin: 'ALICE-GH' })).toBeNull();
  });

  it("refuses someone else's PR, and another user's termag branch", () => {
    expect(refusal(view({ user: { login: 'bob' } }))).toMatch(/is not yours: it was opened by bob on feature\/x/);
    expect(refusal(view({ user: { login: 'bob' }, head: { ref: 'termag-bob/t1', sha: 'b'.repeat(40), repo: { full_name: 'org/repo' } } }))).toMatch(/not yours/);
    expect(refusal(view(), { ...ctx, askerLogin: null })).toMatch(/not yours/);
  });

  it('refuses a fork, a deleted fork, another repository, a closed or merged PR', () => {
    expect(refusal(view({ head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: { full_name: 'alice-gh/repo' } } }))).toMatch(/comes from a fork \(alice-gh\/repo\)/);
    expect(refusal(view({ head: { ref: 'feature/x', sha: 'a'.repeat(40), repo: null } }))).toMatch(/no longer exists/);
    expect(refusal(view({ base: { ref: 'main', repo: { full_name: 'org/other', default_branch: 'main' } } }))).toMatch(/is in org\/other, not org\/repo/);
    expect(refusal(view({ state: 'closed' }))).toMatch(/is closed/);
    expect(refusal(view({ state: 'closed', merged_at: '2026-10-01T00:00:00Z' }))).toMatch(/is merged/);
    expect(refusal(null)).toMatch(/not a pull request/);
  });

  it('refuses a head that is a base branch or a name it could not quote safely', () => {
    expect(refusal(view({ head: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'org/repo' } }, base: { ref: 'release', repo: { full_name: 'org/repo', default_branch: 'main' } } }))).toMatch(/a base branch/);
    expect(refusal(view({ head: { ref: "x'; rm -rf ~", sha: 'a'.repeat(40), repo: { full_name: 'org/repo' } } }))).toMatch(/could not be read/);
  });
});

describe('resolveTargetPr: the ask-time check', () => {
  it("takes the asker's PR whatever its earlier commits, and refuses an unknown number", async () => {
    git(seed, ['checkout', '-q', PR_BRANCH]);
    commitIn(seed, 'src/bob.ts', 'b\n', 'bob was here', 'bob@example.com');
    git(seed, ['push', '-q', remote, PR_BRANCH]);
    const t = await resolveTargetPr(cfg(), { repo: 'org/repo', token: 't', number: PR, askerUnix: 'alice' });
    expect(t).toMatchObject({ number: PR, branch: PR_BRANCH, headSha: tip(PR_BRANCH) });
    expect(api.some(c => c.url.includes('/commits'))).toBe(false);
    expect(await resolveTargetPr(cfg(), { repo: 'org/repo', token: 't', number: 9, askerUnix: 'alice' })).toEqual({ refused: 'PR #9 is not a pull request in org/repo' });
  });
});

describe('bundlePrerequisites', () => {
  it("lists the commits a run's bundle on another PR builds on", () => {
    commitIn(clone, 'src/more.ts', 'm\n', 'more');
    const forkPoint = git(remote, ['merge-base', 'main', PR_BRANCH]);
    expect(bundlePrerequisites(bundle())).toEqual([forkPoint]);
    expect(bundlePrerequisites(Buffer.from('not a bundle'))).toEqual([]);
  });
});

describe('publishBundle to another PR', () => {
  it("fast-forwards the PR's branch, opens nothing, and checks the PR's own commits against its base branch", async () => {
    const before = tip(PR_BRANCH)!;
    const head = commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix: the follow-up');
    body = 'Hand-written intro\n\n<!-- TERMAG_PR_BODY_BEGIN -->\nold thread\n<!-- TERMAG_PR_BODY_END -->\n';
    const out = await only(input());
    expect(out).toMatchObject({ kind: 'published', key: '', branch: PR_BRANCH, headSha: head, commits: 1, prNumber: PR, prCreated: false });
    expect(tip(PR_BRANCH)).toBe(head);
    expect(git(remote, ['merge-base', '--is-ancestor', before, head])).toBe('');
    expect(api.some(c => c.method === 'POST')).toBe(false);
    // main's workflow change since the fork point is not the PR's, so it refuses nothing; the body names the new thread.
    expect(body).toMatch(/^Hand-written intro\n\n<!-- TERMAG_PR_BODY_BEGIN -->/);
    expect(body).toContain('thread `newthread`');
    expect(body).toContain('--thread newthread');
    expect(body).not.toContain('old thread');
  });

  it("takes a merge of main into the PR's branch", async () => {
    git(clone, ['merge', '-q', '--no-edit', baseSha]);
    const out = await only(input());
    expect(out).toMatchObject({ kind: 'published', branch: PR_BRANCH });
    expect(tip(PR_BRANCH)).toBe(git(clone, ['rev-parse', 'HEAD']));
  });

  it('refuses when the branch moved on GitHub since the thread fetched it, and leaves it alone', async () => {
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix: the follow-up');
    git(seed, ['checkout', '-q', PR_BRANCH]);
    const moved = commitIn(seed, 'src/other.ts', 'o\n', 'pushed by the babysitter');
    git(seed, ['push', '-q', remote, PR_BRANCH]);
    const out = await only(input());
    expect(out).toMatchObject({ kind: 'refused', branch: PR_BRANCH, reason: expect.stringMatching(/moved on GitHub since the thread fetched it/) });
    expect(tip(PR_BRANCH)).toBe(moved);
    expect(api.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('refuses a run that never started from the PR, without pushing', async () => {
    git(clone, ['reset', '-q', '--hard', baseSha]);
    commitIn(clone, 'src/a.ts', 'a\n', 'built on main instead');
    const before = tip(PR_BRANCH);
    const out = await only(input());
    expect(out).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/do not build on it/) });
    expect(tip(PR_BRANCH)).toBe(before);
  });

  it('refuses a protected path in a new commit, but not one already on the PR', async () => {
    commitIn(clone, 'CODEOWNERS', '* @alice\n', 'own everything');
    expect(await only(input())).toMatchObject({ kind: 'refused', reason: 'the commits change protected paths (CODEOWNERS)' });

    // A PR whose earlier commit touched a workflow: only what the run adds is checked.
    git(seed, ['checkout', '-q', PR_BRANCH]);
    commitIn(seed, '.github/workflows/pr.yml', 'on: pull_request\n', 'ci: by hand');
    git(seed, ['push', '-q', remote, PR_BRANCH]);
    cloneAndFetchPr();
    commitIn(clone, 'src/feature.ts', 'export const f = 4;\n', 'fix: harmless');
    expect(await only(input())).toMatchObject({ kind: 'published', branch: PR_BRANCH });
  });

  it("refuses a merge whose resolution adds a protected path, though main's own changes pass", async () => {
    git(clone, ['merge', '-q', '--no-commit', baseSha]);
    mkdirSync(join(clone, '.github/workflows'), { recursive: true });
    writeFileSync(join(clone, '.github/workflows/evil.yml'), 'on: push\n');
    git(clone, ['add', '.github/workflows/evil.yml']);
    git(clone, ['commit', '-q', '--no-edit']);
    expect(await only(input())).toMatchObject({ kind: 'refused', reason: 'the commits change protected paths (.github/workflows)' });
  });

  it("takes a PR with someone else's earlier commit, but not a new commit by someone else", async () => {
    git(seed, ['checkout', '-q', PR_BRANCH]);
    commitIn(seed, 'src/bob.ts', 'b\n', 'bob was here', 'bob@example.com');
    git(seed, ['push', '-q', remote, PR_BRANCH]);
    cloneAndFetchPr();
    commitIn(clone, 'src/feature.ts', 'export const f = 4;\n', 'fix');
    const mine = git(clone, ['rev-parse', 'HEAD']);
    expect(await only(input())).toMatchObject({ kind: 'published', headSha: mine, commits: 1 });
    expect(tip(PR_BRANCH)).toBe(mine);

    commitIn(clone, 'src/feature.ts', 'export const f = 5;\n', 'carol, on the run', 'carol@example.com');
    expect(await only(input())).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/authored and committed as alice@example.com; found carol@example.com/) });
    expect(tip(PR_BRANCH)).toBe(mine);
  });

  it("caps only the commits the run adds, not the PR's earlier ones (Bugbot: a PR over 200 commits)", async () => {
    git(seed, ['checkout', '-q', PR_BRANCH]);
    for (let i = 0; i < 205; i++) git(seed, ['commit', '-q', '--allow-empty', '-m', `step ${i}`]);
    git(seed, ['push', '-q', remote, PR_BRANCH]);
    cloneAndFetchPr();
    commitIn(clone, 'src/feature.ts', 'export const f = 9;\n', 'fix: one more');
    expect(await only(input())).toMatchObject({ kind: 'published', commits: 1 });
  });

  it("refuses someone else's PR and a fork's, before pushing anything", async () => {
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    const before = tip(PR_BRANCH);
    pr = { ...pr, user: { login: 'bob' }, head: { ref: 'bob/feature', repo: { full_name: 'org/repo' } } };
    git(seed, ['push', '-q', remote, `${PR_BRANCH}:refs/heads/bob/feature`]);
    expect(await only(input())).toMatchObject({ kind: 'refused', branch: 'PR #753', reason: expect.stringMatching(/is not yours: it was opened by bob/) });
    pr = { ...pr, user: { login: 'alice-gh' }, head: { ref: PR_BRANCH, repo: { full_name: 'alice-gh/repo' } } };
    expect(await only(input())).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/comes from a fork/) });
    expect(tip(PR_BRANCH)).toBe(before);
    expect(tip('bob/feature')).toBe(before);
  });

  it('refuses a closed PR and opens no new one', async () => {
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    pr = { ...pr, state: 'closed' };
    expect(await only(input())).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/is closed/) });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it("adds termag's part to a hand-made PR's body on the thread's first publish only", async () => {
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    body = 'Made by hand.';
    expect(await only(input({ target: { number: PR, askerUnix: 'alice', firstPublish: false } }))).toMatchObject({ kind: 'published', note: expect.stringMatching(/left alone/) });
    expect(body).toBe('Made by hand.');
    cloneAndFetchPr();
    commitIn(clone, 'src/feature.ts', 'export const f = 4;\n', 'fix again');
    expect(await only(input({ target: { number: PR, askerUnix: 'alice', firstPublish: true } }))).toMatchObject({ kind: 'published' });
    expect(body).toMatch(/^Made by hand\.\n\n<!-- TERMAG_PR_BODY_BEGIN -->[\s\S]*Updated by `termag ask`/);
  });

  it("still publishes the run's pr/<name> branches as their own new PRs", async () => {
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    git(clone, ['switch', '-q', '-c', 'pr/docs', baseSha]);
    commitIn(clone, 'docs/x.md', 'x\n', 'docs: x');
    const o = await publishBundle(cfg(), input({ bundle: bundle(['refs/heads/ask', 'refs/heads/pr/docs']) }));
    expect(o.kind).toBe('done');
    const prs = (o as { prs: PrOutcome[] }).prs;
    expect(prs[0]).toMatchObject({ kind: 'published', key: '', branch: PR_BRANCH });
    expect(prs[1]).toMatchObject({ kind: 'published', key: 'docs', branch: 'termag-alice/newthread-docs', prNumber: 900, prCreated: true });
    expect(api.filter(c => c.method === 'POST').map(c => c.body?.head)).toEqual(['termag-alice/newthread-docs']);
    expect(tip('termag-alice/newthread-docs')).toBe(git(clone, ['rev-parse', 'pr/docs']));
  });
});

describe('publishBundle finds the PR the run builds on', () => {
  const auto = (over: Partial<PublishInput> = {}) => input({ target: undefined, prNumbers: {}, ...over });
  const stack = () => {
    // #754, the asker's, stacked on #753's branch.
    git(seed, ['checkout', '-q', '-b', 'termag-alice/stacked', PR_BRANCH]);
    commitIn(seed, 'src/stack.ts', 's\n', 'feat: on top of #753');
    git(seed, ['push', '-q', remote, 'termag-alice/stacked']);
    others.push({ number: 754, state: 'open', html_url: 'https://github.com/org/repo/pull/754', user: { login: 'alice-gh' },
      head: { ref: 'termag-alice/stacked', repo: { full_name: 'org/repo' } }, base: { ref: PR_BRANCH, repo: { full_name: 'org/repo', default_branch: 'main' } } });
  };

  it("publishes to the one open PR of the asker's that the run builds on, with no --update-pr", async () => {
    const head = commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix: the follow-up');
    const out = await only(auto());
    expect(out).toMatchObject({ kind: 'published', key: '', branch: PR_BRANCH, headSha: head, prNumber: PR, prCreated: false, target: { number: PR, branch: PR_BRANCH } });
    expect(tip(PR_BRANCH)).toBe(head);
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('opens its own draft PR as before when the run builds on no PR', async () => {
    git(clone, ['reset', '-q', '--hard', baseSha]);
    commitIn(clone, 'src/a.ts', 'a\n', 'feat: on main');
    const out = await only(auto());
    expect(out).toMatchObject({ kind: 'published', branch: 'termag-alice/newthread', prNumber: 900, prCreated: true });
    expect(out).not.toHaveProperty('target');
  });

  it("refuses a run on a stack of the asker's PRs, naming them, and --update-pr picks one", async () => {
    stack();
    git(clone, ['fetch', '-q', '--no-tags', `file://${remote}`, '+refs/heads/termag-alice/stacked:refs/remotes/termag/stacked']);
    git(clone, ['reset', '-q', '--hard', 'refs/remotes/termag/stacked']);
    commitIn(clone, 'src/stack.ts', 's2\n', 'fix: the top of the stack');
    const before = tip('termag-alice/stacked');
    expect(await only(auto())).toMatchObject({ kind: 'refused', key: '', reason: expect.stringMatching(/build on several of your open PRs \(#753, #754\).*--update-pr/) });
    expect(tip('termag-alice/stacked')).toBe(before);
    expect(await only(auto({ target: { number: 754, askerUnix: 'alice', firstPublish: true }, prNumbers: { '': 754 } }))).toMatchObject({ kind: 'published', branch: 'termag-alice/stacked', prNumber: 754 });
  });

  it('ignores open PRs whose head is already in the base (Bugbot: a main → release PR, a branch parked on the base)', async () => {
    git(seed, ['push', '-q', remote, `${baseSha}:refs/heads/release`, `${baseSha}:refs/heads/bob/parked`]);
    others.push(
      { number: 760, state: 'open', html_url: 'https://github.com/org/repo/pull/760', user: { login: 'alice-gh' },
        head: { ref: 'main', repo: { full_name: 'org/repo' } }, base: { ref: 'release', repo: { full_name: 'org/repo', default_branch: 'main' } } },
      { number: 761, state: 'open', html_url: 'https://github.com/org/repo/pull/761', user: { login: 'bob' },
        head: { ref: 'bob/parked', repo: { full_name: 'org/repo' } }, base: { ref: 'main', repo: { full_name: 'org/repo', default_branch: 'main' } } },
    );
    // An ordinary ask from the base opens its own draft, untouched by either.
    const fromBase = cloneOf(baseSha);
    commitIn(fromBase, 'src/a.ts', 'a\n', 'feat: on main');
    expect(await only(auto({ bundle: bundleOf(fromBase) }))).toMatchObject({ kind: 'published', branch: 'termag-alice/newthread', prCreated: true });
    expect(tip('main')).toBe(baseSha);
    // And a run on #753 still finds #753 alone.
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    expect(await only(auto())).toMatchObject({ kind: 'published', branch: PR_BRANCH, target: { number: PR } });
  });

  it("refuses a run on someone else's PR, saying whose", async () => {
    pr = { ...pr, user: { login: 'bob' }, head: { ref: 'bob/feature', repo: { full_name: 'org/repo' } } };
    git(seed, ['push', '-q', remote, `${PR_BRANCH}:refs/heads/bob/feature`]);
    commitIn(clone, 'src/feature.ts', 'export const f = 3;\n', 'fix');
    expect(await only(auto())).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/build on PR #753, which termag does not update: PR #753 is not yours/) });
  });
});

describe('runSystemPrompt for another PR', () => {
  it("tells a thread with no target how to build on the sender's PR, and to keep a separate change on pr/<name>", () => {
    const p = runSystemPrompt({ senderUsername: 'alice', senderDisplayName: 'Alice', target: 'dev/repo', branch: 'termag-alice/newthread', checkout: '/home/alice/p' });
    expect(p).toContain("draft pull request on termag-alice/newthread");
    expect(p).toContain("git -C '/home/alice/p' remote get-url origin");
    expect(p).toContain('builds on exactly one open pull request the sender opened');
    expect(p).toContain('separate new pull request goes on a `pr/<name>` branch');
  });

  it('tells the run to start from the PR branch and how to fetch it', () => {
    const p = runSystemPrompt({
      senderUsername: 'alice', senderDisplayName: 'Alice', target: 'dev/repo', branch: 'termag-alice/newthread',
      targetPr: { number: PR, repo: 'org/repo', branch: PR_BRANCH, checkout: '/home/alice/termag/projects/repo' },
    });
    expect(p).toContain(`#${PR} in org/repo`);
    expect(p).toContain(`git fetch $([ -f .git/shallow ] && echo --unshallow) --no-tags "$(git -C '/home/alice/termag/projects/repo' remote get-url origin)" '+refs/heads/${PR_BRANCH}:refs/remotes/termag/target'`);
    expect(p).not.toContain('as a draft pull request on termag-alice/newthread;');
  });
});
