import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { findSecrets, protectedArea, publishBundle, type PublishConfig, type PublishInput } from './askPublish';

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
let openPrs: unknown[];

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
  sh(work, ['commit', '-q', '-m', message], as(email));
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
  if (method === 'GET' && u.includes('/pulls?')) return json(200, openPrs);
  if (method === 'GET' && u.endsWith('/pulls/7')) return json(200, { number: 7, state: prState, html_url: 'https://github.com/org/repo/pull/7' });
  if (method === 'GET' && u.endsWith('/repos/org/repo')) return json(200, { default_branch: 'main' });
  if (method === 'POST' && u.endsWith('/pulls')) return json(201, { number: 42, html_url: 'https://github.com/org/repo/pull/42' });
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

const cfg = (): PublishConfig => ({ gitBaseUrl: `file://${ghBase}`, apiBaseUrl: 'https://api.example', fetch: fakeFetch });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  bundle: bundle(), baseSha, repo: 'org/repo', branch: 'termag-alice/thread1', token: 'gho_secret',
  askerEmail: ASKER, prTitle: '', prBody: 'body', prNumber: null, ...over,
});

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
  prState = 'open';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('publishBundle', () => {
  it('pushes the commits to the thread branch and opens a draft PR named after the first commit', async () => {
    commit('src/a.ts', 'export const a = 1;\n', 'feat: add a');
    commit('src/b.ts', 'export const b = 2;\n', 'feat: add b');
    const tip = sh(work, ['rev-parse', 'HEAD']);
    const out = await publishBundle(cfg(), input());
    expect(out).toEqual({ kind: 'published', headSha: tip, commits: 2, prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42', prCreated: true });
    expect(sh(remote, ['rev-parse', 'refs/heads/termag-alice/thread1'])).toBe(tip);
    const post = api.find(c => c.method === 'POST')!;
    expect(post.body).toEqual({ title: 'feat: add a (+1 more)', head: 'termag-alice/thread1', base: 'main', body: 'body', draft: true });
    expect(post.auth).toBe('Bearer gho_secret');
  });

  it('reuses the open PR for the branch and fast-forwards it on a follow-up', async () => {
    commit('a.txt', '1\n', 'one');
    await publishBundle(cfg(), input());
    commit('a.txt', '2\n', 'two');
    openPrs = [{ number: 42, html_url: 'https://github.com/org/repo/pull/42' }];
    const out = await publishBundle(cfg(), input());
    expect(out).toMatchObject({ kind: 'published', commits: 2, prNumber: 42, prCreated: false });
    expect(api.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it('keeps the remembered PR while it is open, and opens a new draft once it was closed', async () => {
    commit('a.txt', '1\n', 'one');
    expect(await publishBundle(cfg(), input({ prNumber: 7 }))).toMatchObject({ prNumber: 7, prCreated: false });
    commit('a.txt', '2\n', 'two');
    prState = 'closed';
    expect(await publishBundle(cfg(), input({ prNumber: 7 }))).toMatchObject({ prNumber: 42, prCreated: true });
  });

  it('refuses to overwrite a branch that moved', async () => {
    commit('a.txt', '1\n', 'one');
    await publishBundle(cfg(), input());
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('a.txt', 'other\n', 'diverged');
    const out = await publishBundle(cfg(), input());
    expect(out.kind).toBe('refused');
    expect((out as { reason: string }).reason).toContain('not overwriting');
  });

  it('refuses protected paths', async () => {
    commit('.github/workflows/x.yml', 'on: push\n', 'ci');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    expect(api).toEqual([]);
  });

  it('refuses a protected path whose name git would quote, or that a later commit removes', async () => {
    commit('.github/workflows/caf\u00e9.yml', 'on: push\n', 'ci');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('.github/workflows/tab\there.yml', 'on: push\n', 'add');
    sh(work, ['rm', '-q', '.github/workflows/tab\there.yml']);
    sh(work, ['commit', '-q', '-m', 'remove'], as(ASKER));
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.github/workflows') });
    expect(api).toEqual([]);
  });

  it('refuses commits by someone else', async () => {
    commit('a.txt', '1\n', 'one', 'mallory@example.com');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('mallory@example.com') });
  });

  it('refuses an added secret', async () => {
    commit('cfg.env', `KEY=AKIA${'ABCDEFGHIJKLMNOP'}\n`, 'oops');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('AWS access key id') });
  });

  it('refuses a secret in a commit message, which would also become the PR title', async () => {
    commit('a.txt', '1\n', `tmag_${'b'.repeat(64)}`);
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret in an author or committer name, even with the asker email', async () => {
    commit('a.txt', '1\n', 'one');
    sh(work, ['commit', '-q', '--amend', '--no-edit', `--author=tmag_${'e'.repeat(64)} <${ASKER}>`], as(ASKER));
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    sh(work, ['reset', '-q', '--hard', baseSha]);
    commit('a.txt', '2\n', 'two');
    sh(work, ['commit', '-q', '--amend', '--no-edit'], { ...as(ASKER), GIT_COMMITTER_NAME: `tmag_${'f'.repeat(64)}` });
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret an earlier commit added and a later one removed', async () => {
    commit('cfg.env', `KEY=AKIA${'ABCDEFGHIJKLMNOP'}\n`, 'add');
    commit('cfg.env', 'KEY=\n', 'remove');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('AWS access key id') });
  });

  it('refuses a secret used as the name of an empty file, or of a file a later commit removes', async () => {
    commit(`tmag_${'d'.repeat(32)}`, '', 'empty');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    sh(work, ['rm', '-q', `tmag_${'d'.repeat(32)}`]);
    sh(work, ['commit', '-q', '-m', 'gone'], as(ASKER));
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
    expect(api.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a secret inside a binary file', async () => {
    commit('blob.bin', `\u0000\u0001tmag_${'c'.repeat(64)}\u0000`, 'binary');
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('termag agent token') });
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
    expect(await publishBundle(cfg(), input())).toMatchObject({ kind: 'refused', reason: expect.stringContaining('merge commit') });
    expect(sh(remote, ['branch', '--list', 'termag-alice/thread1'])).toBe('');
    expect(api).toEqual([]);
  });

  it('refuses a bundle with two branches', async () => {
    commit('a.txt', '1\n', 'one');
    sh(work, ['branch', 'other']);
    const file = join(root, 'two.bundle');
    sh(work, ['bundle', 'create', '-q', file, `${baseSha}..main`, `${baseSha}..other`]);
    expect(await publishBundle(cfg(), input({ bundle: readFileSync(file) }))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('exactly one') });
  });

  it('fails cleanly when the base is not on the remote', async () => {
    commit('a.txt', '1\n', 'one');
    const out = await publishBundle(cfg(), input({ baseSha: 'f'.repeat(40) }));
    expect(out.kind).toBe('failed');
    expect(JSON.stringify(out)).not.toContain('gho_secret');
  });
});
