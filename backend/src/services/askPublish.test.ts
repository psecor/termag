import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { findSecrets, protectedArea, publishBundle, publishSummary, type PrOutcome, type PublishConfig, type PublishInput, type PublishOutcome } from './askPublish';
import { MAX_ASK_PRS, PR_DESCRIPTION_MAX, askPrBranch, prBody } from './agentMessages';

describe('protectedArea', () => {
  it('names the protected paths', () => {
    expect(protectedArea('.github/workflows/ci.yml')).toBe('.github/workflows');
    expect(protectedArea('docs/CODEOWNERS')).toBe('CODEOWNERS');
    expect(protectedArea('CODEOWNERS')).toBe('CODEOWNERS');
    expect(protectedArea('deploy/termag-reconcile')).toBe('deploy/');
    expect(protectedArea('etc/sudoers.d/termag')).toBe('sudoers.d');
    expect(protectedArea('x/sudoers')).toBe('sudoers');
  });

  it('leaves the rest alone', () => {
    for (const p of ['src/deploy/x.ts', '.github/dependabot.yml', 'CODEOWNERS.md', 'README.md']) expect(protectedArea(p)).toBeNull();
  });
});

describe('findSecrets', () => {
  it('looks at added lines only', () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(findSecrets(`-old ${key}\n+++ b/file\n context`)).toEqual([]);
    expect(findSecrets(`+aws = "${key}"`)).toEqual(['AWS access key id']);
    expect(findSecrets('+-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['private key']);
    expect(findSecrets(`+t = "tmag_${'a'.repeat(32)}"`)).toEqual(['termag agent token']);
  });

  it('scans an added line that starts with ++, which reads like a header', () => {
    expect(findSecrets(`+++tmag_${'a'.repeat(32)}`)).toEqual(['termag agent token']);
  });
});

const ASKER = 'alice@example.com';

let root: string;
let ghBase: string;
let remote: string;
let work: string;
let baseSha: string;
let api: Array<{ method: string; url: string; body: unknown; auth: string | null }>;
let prState = 'open';
let openPrs: Array<Record<string, unknown>>;
/** PR bodies as the fake GitHub holds them, by number. */
let bodies: Map<number, string>;
let patchStatus = 200;
let nextPr = 42;

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    encoding: 'utf8',
  }).trim();
}

const as = (email: string) => ({
  GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: email,
});

function commit(path: string, content: string, message: string, email = ASKER): void {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), content);
  sh(work, ['add', path]);
  sh(work, ['commit', '-q', '--cleanup=strip', '-m', message], as(email));
}

function bundle(): Buffer {
  const file = join(root, `b-${Date.now()}-${Math.random()}.bundle`);
  sh(work, ['bundle', 'create', '-q', file, `${baseSha}..HEAD`]);
  return readFileSync(file);
}

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  api.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization ?? null });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  if (method === 'GET' && u.includes('/pulls?')) {
    const head = decodeURIComponent(/head=([^&]+)/.exec(u)?.[1] ?? '').replace(/^[^:]*:/, '');
    return json(200, openPrs.filter(p => !p.head || p.head === head).map(p => ({ ...p, body: bodies.get(Number(p.number)) ?? null })));
  }
  if (method === 'GET' && u.endsWith('/pulls/7')) return json(200, { number: 7, state: prState, html_url: 'https://github.com/org/repo/pull/7', body: bodies.get(7) ?? null });
  if (method === 'GET' && u.endsWith('/repos/org/repo')) return json(200, { default_branch: 'main' });
  if (method === 'POST' && u.endsWith('/pulls')) {
    const n = nextPr++;
    bodies.set(n, String(body?.body));
    return json(201, { number: n, html_url: `https://github.com/org/repo/pull/${n}` });
  }
  const patch = /\/pulls\/(\d+)$/.exec(u);
  if (method === 'PATCH' && patch) {
    if (patchStatus === 200) bodies.set(Number(patch[1]), String(body?.body));
    return json(patchStatus, {});
  }
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

const cfg = (): PublishConfig => ({ gitBaseUrl: `file://${ghBase}`, apiBaseUrl: 'https://api.example', fetch: fakeFetch });
const meta = { senderUsername: 'alice', target: 'dev/repo', threadId: 'thread1', box: 'i-0abc', project: 'repo' };
const bodyFor = (description: string, key = '') => prBody({ ...meta, description, prKey: key || undefined });
/** One-branch input, as a run without pr/<name> branches sends it. */
const input = (over: Partial<PublishInput> & { prDescription?: string | null; prNumber?: number | null } = {}): PublishInput => {
  const { prDescription, prNumber, ...rest } = over;
  return {
    bundle: bundle(), baseSha, repo: 'org/repo', token: 'gho_secret', askerEmail: ASKER,
    branchFor: key => askPrBranch('alice', 'thread1', key), prBody: bodyFor,
    prDescriptions: prDescription ? { '': prDescription } : {},
    prNumbers: prNumber ? { '': prNumber } : {},
    ...rest,
  };
};
/** The single branch's outcome, or the whole-bundle refusal/failure. */
const one = (o: PublishOutcome): PrOutcome | PublishOutcome => {
  if (o.kind !== 'done') return o;
  expect(o.prs).toHaveLength(1);
  return o.prs[0];
};
const pub = async (i: PublishInput) => one(await publishBundle(cfg(), i));
const posted = () => api.find(c => c.method === 'POST')!.body as Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-publish-test-'));
  ghBase = join(root, 'gh');
  remote = join(ghBase, 'org', 'repo.git');
  mkdirSync(remote, { recursive: true });
  sh(remote, ['init', '-q', '--bare', '-b', 'main']);
  work = join(root, 'work');
  sh(root, ['init', '-q', '-b', 'main', work]);
  commit('README.md', 'hello\n', 'initial', 'owner@example.com');
  sh(work, ['push', '-q', remote, 'main']);
  baseSha = sh(work, ['rev-parse', 'HEAD']);
  api = [];
  openPrs = [];
  bodies = new Map();
  prState = 'open';
  patchStatus = 200;
  nextPr = 42;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('publishBundle', () => {
  it('pushes the commits to the thread branch and opens a draft PR named after the first commit', async () => {
    commit('src/a.ts', 'export const a = 1;\n', 'feat: add a');
    commit('src/b.ts', 'export const b = 2;\n', 'feat: add b');
    const tip = sh(work, ['rev-parse', 'HEAD']);
    const out = await pub(input());
    expect(out).toEqual({ kind: 'published', key: '', branch: 'termag-alice/thread1', headSha: tip, commits: 2, prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42', prCreated: true });
    expect(sh(remote, ['rev-parse', 'refs/heads/termag-alice/thread1'])).toBe(tip);
    const post = api.find(c => c.method === 'POST')!;
    expect(post.body).toEqual({
      title: 'feat: add a (+1 more)', head: 'termag-alice/thread1', base: 'main', draft: true,
      body: bodyFor('## Commits\n\n- feat: add a\n- feat: add b'),
    });
    expect(post.auth).toBe('Bearer gho_secret');
  });

  it("opens the PR with the run's description and title above termag's provenance", async () => {
    commit('src/a.ts', 'export const a = 1;\n', 'feat: add a');
    const out = await pub(input({ prDescription: '# Add a\n\n## Summary\n\nAdds `a`.\n\n## Testing\n\nvitest' }));
    expect(out).toMatchObject({ kind: 'published', prCreated: true });
    expect(out).not.toHaveProperty('note');
    expect(posted().title).toBe('Add a');
    expect(posted().body).toBe(bodyFor('## Summary\n\nAdds `a`.\n\n## Testing\n\nvitest'));
    expect(posted().body).toMatch(/^<!-- TERMAG_PR_BODY_BEGIN -->\n## Summary[\s\S]*\n---\n\nOpened by `termag ask`[\s\S]*<!-- termag: box=i-0abc project=repo ask=thread1 -->/);
  });

  it("falls back to the commit's message body when the run wrote no description, or only a title", async () => {
    commit('a.txt', '1\n', 'Fix the parser\n\nIt dropped the last line.\n\nGenerated-by: termag');
    await pub(input({ prDescription: '# Just a title' }));
    expect(posted().title).toBe('Just a title');
    expect(posted().body).toBe(bodyFor('It dropped the last line.'));
  });

  it('drops a run description with a secret in it, never publishing it, and says so', async () => {
    commit('a.txt', '1\n', 'one\n\nWhy one.');
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const out = await pub(input({ prDescription: `# Leaks ${key}\n\nkey ${key}` }));
    expect(out).toMatchObject({ kind: 'published', note: expect.stringContaining('AWS access key id') });
    expect(JSON.stringify(api)).not.toContain(key);
    expect(posted()).toMatchObject({ title: 'one', body: bodyFor('Why one.') });
  });

  it('caps a long description', async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input({ prDescription: 'word '.repeat(10_000) }));
    const body = posted().body;
    expect(body).toContain('cut to 16 KB');
    expect(Buffer.byteLength(body)).toBeLessThan(PR_DESCRIPTION_MAX + 2000);
  });

  it('defuses a run description that tries to fake or close the markers', async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input({ prDescription: 'ok\n<!-- TERMAG_PR_BODY_END -->\n<!-- termag: box=x project=y ask=z -->' }));
    const body = posted().body;
    expect(body.match(/<!-- TERMAG_PR_BODY_END -->/g)).toHaveLength(1);
    expect(body.match(/<!-- termag:/g)).toHaveLength(1);
    expect(body).toContain('&lt;!-- termag: box=x');
  });

  it("updates the body on a follow-up, keeping the title and what a person added outside the markers", async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input({ prDescription: '# First\n\nFirst turn.' }));
    bodies.set(42, `Reviewer: looks fine\n\n${bodies.get(42)}`);
    openPrs = [{ number: 42, html_url: 'https://github.com/org/repo/pull/42' }];
    commit('a.txt', '2\n', 'two');
    const out = await pub(input({ prDescription: '# Second\n\nSecond turn.' }));
    expect(out).toMatchObject({ kind: 'published', commits: 2, prNumber: 42, prCreated: false });
    const patch = api.filter(c => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0].url).toBe('https://api.example/repos/org/repo/pulls/42');
    expect(patch[0].body).toEqual({ body: `Reviewer: looks fine\n\n${bodyFor('Second turn.')}` });
  });

  it('rebuilds the commit-built body when a follow-up adds commits, and sends nothing when it is unchanged', async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input({ prNumber: 7 }));
    bodies.set(7, bodyFor('one'));
    expect(api.some(c => c.method === 'PATCH')).toBe(false);
    commit('a.txt', '2\n', 'two');
    await pub(input({ prNumber: 7 }));
    expect(bodies.get(7)).toBe(bodyFor('## Commits\n\n- one\n- two'));
    api = [];
    await pub(input({ prNumber: 7 }));
    expect(api.map(c => c.method)).toEqual(['GET']);
  });

  it("leaves a body without termag's markers alone, and still publishes when the update fails", async () => {
    commit('a.txt', '1\n', 'one');
    bodies.set(7, 'Rewritten by hand');
    expect(await pub(input({ prNumber: 7 }))).toMatchObject({ kind: 'published', note: expect.stringContaining('left alone') });
    expect(bodies.get(7)).toBe('Rewritten by hand');
    bodies.set(7, bodyFor('old'));
    patchStatus = 403;
    expect(await pub(input({ prNumber: 7 }))).toMatchObject({ kind: 'published', prNumber: 7, note: expect.stringContaining('PATCH answered 403') });
  });

  it('reuses the open PR for the branch and fast-forwards it on a follow-up', async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input());
    commit('a.txt', '2\n', 'two');
    openPrs = [{ number: 42, html_url: 'https://github.com/org/repo/pull/42' }];
    const out = await pub(input());
    expect(out).toMatchObject({ kind: 'published', commits: 2, prNumber: 42, prCreated: false });
    expect(api.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it('keeps the remembered PR while it is open, and opens a new draft once it was closed', async () => {
    commit('a.txt', '1\n', 'one');
    expect(await pub(input({ prNumber: 7 }))).toMatchObject({ prNumber: 7, prCreated: false });
    commit('a.txt', '2\n', 'two');
    prState = 'closed';
    expect(await pub(input({ prNumber: 7 }))).toMatchObject({ prNumber: 42, prCreated: true });
  });

  it('refuses to overwrite a branch that moved', async () => {
    commit('a.txt', '1\n', 'one');
    await pub(input());
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('a.txt', 'other\n', 'diverged');
    const out = await pub(input());
    expect(out.kind).toBe('refused');
    expect((out as { reason: string }).reason).toContain('not overwriting');
  });

  it('refuses protected paths', async () => {
    commit('.github/workflows/x.yml', 'on: push\n', 'ci');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    expect(api).toEqual([]);
  });

  it('refuses a protected path whose name git would quote, or that a later commit removes', async () => {
    commit('.github/workflows/caf\u00e9.yml', 'on: push\n', 'ci');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('.github/workflows/tab\there.yml', 'on: push\n', 'add');
    sh(work, ['rm', '-q', '.github/workflows/tab\there.yml']);
    sh(work, ['commit', '-q', '-m', 'remove'], as(ASKER));
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    expect(api).toEqual([]);
  });

  it('refuses commits by someone else', async () => {
    commit('a.txt', '1\n', 'one', 'mallory@example.com');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('mallory@example.com') });
  });

  it('refuses an added secret', async () => {
    commit('cfg.env', `KEY=AKIA${'ABCDEFGHIJKLMNOP'}\n`, 'oops');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('AWS access key id') });
  });

  it('refuses a secret in a commit message, which would also become the PR title', async () => {
    commit('a.txt', '1\n', `tmag_${'b'.repeat(64)}`);
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret in an author or committer name, even with the asker email', async () => {
    commit('a.txt', '1\n', 'one');
    sh(work, ['commit', '-q', '--amend', '--no-edit', `--author=tmag_${'e'.repeat(64)} <${ASKER}>`], as(ASKER));
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('a.txt', '2\n', 'two');
    sh(work, ['commit', '-q', '--amend', '--no-edit'], { ...as(ASKER), GIT_COMMITTER_NAME: `tmag_${'f'.repeat(64)}` });
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret an earlier commit added and a later one removed', async () => {
    commit('cfg.env', `KEY=AKIA${'ABCDEFGHIJKLMNOP'}\n`, 'add');
    commit('cfg.env', 'KEY=\n', 'remove');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('AWS access key id') });
  });

  it('refuses a secret used as the name of an empty file, or of a file a later commit removes', async () => {
    commit(`tmag_${'d'.repeat(32)}`, '', 'empty');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    sh(work, ['rm', '-q', `tmag_${'d'.repeat(32)}`]);
    sh(work, ['commit', '-q', '-m', 'gone'], as(ASKER));
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret inside a binary file', async () => {
    commit('blob.bin', `\u0000\u0001tmag_${'c'.repeat(64)}\u0000`, 'binary');
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
  });

  it('refuses a merge commit, whose own changes a per-commit patch never shows', async () => {
    commit('a.txt', '1\n', 'one');
    sh(work, ['checkout', '-q', '-b', 'side', baseSha]);
    commit('b.txt', '2\n', 'two');
    sh(work, ['checkout', '-q', 'main']);
    sh(work, ['merge', '-q', '--no-ff', '--no-commit', 'side'], as(ASKER));
    writeFileSync(join(work, 'cfg.env'), `KEY=AKIA${'ABCDEFGHIJKLMNOP'}\n`);
    sh(work, ['add', 'cfg.env']);
    sh(work, ['commit', '-q', '-m', 'merge side'], as(ASKER));
    expect(await pub(input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('merge commit') });
    expect(sh(remote, ['branch', '--list', 'termag-alice/thread1'])).toBe('');
    expect(api).toEqual([]);
  });

  it("refuses a bundle with a branch that is neither the run's own nor pr/<name>", async () => {
    commit('a.txt', '1\n', 'one');
    sh(work, ['branch', 'other']);
    const file = join(root, 'two.bundle');
    sh(work, ['bundle', 'create', '-q', file, `${baseSha}..main`, `${baseSha}..other`]);
    expect(await publishBundle(cfg(), input({ bundle: readFileSync(file) }))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('refs/heads/main') });
  });

  it('fails cleanly when the base is not on the remote', async () => {
    commit('a.txt', '1\n', 'one');
    const out = await pub(input({ baseSha: 'f'.repeat(40) }));
    expect(out.kind).toBe('failed');
    expect(JSON.stringify(out)).not.toContain('gho_secret');
  });
});

/** A bundle of named branches, as the box sends one with pr/<name> branches. */
function bundleOf(...branches: string[]): Buffer {
  const file = join(root, `m-${Date.now()}-${Math.random()}.bundle`);
  sh(work, ['bundle', 'create', '-q', file, ...branches, `^${baseSha}`]);
  return readFileSync(file);
}

function onBranch(branch: string, from = baseSha): void {
  sh(work, ['checkout', '-q', '-B', branch, from]);
}

describe('publishBundle with several branches', () => {
  beforeEach(() => {
    onBranch('ask');
    commit('src/a.ts', 'export const a = 1;\n', 'feat: add a');
    onBranch('pr/docs');
    commit('docs/a.md', '# a\n', 'docs: describe a');
  });

  it('opens one draft PR per branch, the run\'s own first, each with its own description', async () => {
    const out = await publishBundle(cfg(), input({
      bundle: bundleOf('ask', 'pr/docs'),
      prDescriptions: { '': '# Add a\n\nThe code.', docs: '# Document a\n\nThe docs.' },
    }));
    expect(out).toMatchObject({ kind: 'done', prs: [
      { kind: 'published', key: '', branch: 'termag-alice/thread1', prNumber: 42, commits: 1 },
      { kind: 'published', key: 'docs', branch: 'termag-alice/thread1-docs', prNumber: 43, commits: 1 },
    ] });
    expect(sh(remote, ['rev-parse', 'refs/heads/termag-alice/thread1-docs'])).toBe(sh(work, ['rev-parse', 'pr/docs']));
    const posts = api.filter(c => c.method === 'POST').map(c => c.body as Record<string, string>);
    expect(posts.map(p => [p.title, p.head])).toEqual([['Add a', 'termag-alice/thread1'], ['Document a', 'termag-alice/thread1-docs']]);
    expect(posts[1].body).toBe(bodyFor('The docs.', 'docs'));
    expect(posts[1].body).toContain('from the run\'s branch `pr/docs`');
    expect(publishSummary(out)).toEqual({
      publish: 'published',
      detail: expect.stringMatching(/^ask: 1 commit\(s\) at [0-9a-f]{12} on termag-alice\/thread1 \| pr\/docs: 1 commit\(s\) at [0-9a-f]{12} on termag-alice\/thread1-docs$/),
    });
  });

  it('publishes the branches that pass when another one is refused', async () => {
    onBranch('pr/ci');
    commit('.github/workflows/x.yml', 'on: push\n', 'ci');
    const out = await publishBundle(cfg(), input({ bundle: bundleOf('ask', 'pr/ci', 'pr/docs') }));
    expect(out).toMatchObject({ kind: 'done', prs: [
      { kind: 'published', key: '' },
      { kind: 'refused', key: 'ci', reason: expect.stringContaining('.github/workflows') },
      { kind: 'published', key: 'docs' },
    ] });
    expect(sh(remote, ['branch', '--list', 'termag-alice/thread1-ci'])).toBe('');
    expect(publishSummary(out).publish).toBe('partial');
  });

  it('publishes a pr/<name> branch without the run\'s own when only it has commits', async () => {
    const out = await publishBundle(cfg(), input({ bundle: bundleOf('pr/docs') }));
    expect(out).toMatchObject({ kind: 'done', prs: [{ kind: 'published', key: 'docs', prNumber: 42 }] });
    expect(sh(remote, ['branch', '--list', 'termag-alice/thread1'])).toBe('');
  });

  it('updates each branch\'s own PR on a follow-up, and leaves an unchanged one alone', async () => {
    await publishBundle(cfg(), input({ bundle: bundleOf('ask', 'pr/docs') }));
    openPrs = [
      { number: 42, head: 'termag-alice/thread1', html_url: 'https://github.com/org/repo/pull/42' },
      { number: 43, head: 'termag-alice/thread1-docs', html_url: 'https://github.com/org/repo/pull/43' },
    ];
    commit('docs/a.md', '# a\n\nMore.\n', 'docs: more on a');
    api = [];
    const out = await publishBundle(cfg(), input({ bundle: bundleOf('ask', 'pr/docs'), prNumbers: { '': 42, docs: 43 } }));
    expect(out).toMatchObject({ kind: 'done', prs: [
      { kind: 'published', key: '', prNumber: 42, prCreated: false, commits: 1 },
      { kind: 'published', key: 'docs', prNumber: 43, prCreated: false, commits: 2 },
    ] });
    expect(api.filter(c => c.method === 'POST')).toEqual([]);
    const patches = api.filter(c => c.method === 'PATCH');
    expect(patches.map(c => c.url)).toEqual(['https://api.example/repos/org/repo/pulls/43']);
    expect(bodies.get(43)).toBe(bodyFor('## Commits\n\n- docs: describe a\n- docs: more on a', 'docs'));
  });

  it(`opens no new PR once the thread has ${MAX_ASK_PRS}, but still updates the ones it has`, async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_ASK_PRS - 1 }, (_, i) => [`old${i}`, 100 + i]));
    const out = await publishBundle(cfg(), input({ bundle: bundleOf('ask', 'pr/docs'), prNumbers: { ...full, '': 7 } }));
    expect(out).toMatchObject({ kind: 'done', prs: [
      { kind: 'published', key: '', prNumber: 7 },
      { kind: 'refused', key: 'docs', reason: expect.stringContaining(`${MAX_ASK_PRS} PRs`) },
    ] });
  });

  it(`refuses a bundle with more than ${MAX_ASK_PRS} branches`, async () => {
    const names = Array.from({ length: MAX_ASK_PRS + 1 }, (_, i) => `pr/b${i}`);
    for (const n of names) sh(work, ['branch', '-f', n, 'pr/docs']);
    expect(await publishBundle(cfg(), input({ bundle: bundleOf(...names) }))).toMatchObject({ kind: 'refused', reason: expect.stringContaining(`${MAX_ASK_PRS + 1} branches`) });
    expect(api).toEqual([]);
  });

  it('refuses a bundle whose branch name is not a valid key', async () => {
    sh(work, ['branch', '-f', 'pr/Bad_Name', 'pr/docs']);
    expect(await publishBundle(cfg(), input({ bundle: bundleOf('ask', 'pr/Bad_Name') }))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('pr/Bad_Name') });
  });
});

describe('publishSummary', () => {
  it('passes a whole-bundle refusal through, and shows a single branch without its name', () => {
    expect(publishSummary({ kind: 'refused', reason: 'no' })).toEqual({ publish: 'refused', detail: 'no' });
    expect(publishSummary({ kind: 'done', prs: [{ kind: 'refused', key: '', branch: 'b', reason: 'protected' }] })).toEqual({ publish: 'refused', detail: 'protected' });
  });

  it('is failed when no branch published and one failed', () => {
    expect(publishSummary({ kind: 'done', prs: [
      { kind: 'refused', key: 'a', branch: 'b-a', reason: 'x' },
      { kind: 'failed', key: 'c', branch: 'b-c', reason: 'y' },
    ] })).toEqual({ publish: 'failed', detail: 'pr/a: x | pr/c: y' });
  });
});
