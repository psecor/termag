import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureInitialCommit, ensureProjectRepo, hasCommits, INITIAL_COMMIT_MESSAGE } from './gitRepo';

const execAsync = promisify(exec);

// These tests drive a real git binary against throwaway repos: the behaviour
// under test (an unborn HEAD is not a valid worktree base) is git's, so a
// mocked exec would only assert the strings we already wrote.
describe('ensureInitialCommit', () => {
  let root: string;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'termag-gitrepo-'));
    // Run against a blank config so the machine's own identity (or lack of
    // one) can't change the outcome; each test opts in explicitly.
    await writeFile(join(root, 'gitconfig'), '');
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  });

  afterEach(async () => {
    process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    process.env.GIT_CONFIG_SYSTEM = savedSystem;
    await rm(root, { recursive: true, force: true });
  });

  async function freshProject(name = 'proj'): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await execAsync(`git init ${dir}`);
    await writeFile(join(dir, 'AGENTS.md'), '# proj\n');
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    return dir;
  }

  it('is what makes a worktree possible in a freshly created project', async () => {
    const dir = await freshProject();

    // The bug: branching off a new project fails on the unborn HEAD.
    await expect(
      execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`),
    ).rejects.toThrow();

    expect(await ensureInitialCommit(dir)).toBe('created');

    await execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`);
    const { stdout } = await execAsync(`git -C ${dir}/.worktrees/feature rev-parse --abbrev-ref HEAD`);
    expect(stdout.trim()).toBe('feature');
  });

  it('commits the seeded wiki files', async () => {
    const dir = await freshProject();
    await ensureInitialCommit(dir);

    const { stdout: files } = await execAsync(`git -C ${dir} show --name-only --format= HEAD`);
    expect(files.split('\n').map(s => s.trim()).filter(Boolean).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);

    const { stdout: subject } = await execAsync(`git -C ${dir} log -1 --format=%s`);
    expect(subject.trim()).toBe(INITIAL_COMMIT_MESSAGE);

    const { stdout: status } = await execAsync(`git -C ${dir} status --porcelain`);
    expect(status.trim()).toBe('');
  });

  it('falls back to a termag identity when the host has none', async () => {
    const dir = await freshProject();
    await ensureInitialCommit(dir);

    const { stdout } = await execAsync(`git -C ${dir} log -1 --format='%an <%ae>'`);
    expect(stdout.trim()).toBe('termag <termag@localhost>');
  });

  it('uses the host identity when one is configured', async () => {
    await writeFile(
      join(root, 'gitconfig'),
      '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
    );
    const dir = await freshProject();
    await ensureInitialCommit(dir);

    const { stdout } = await execAsync(`git -C ${dir} log -1 --format='%an <%ae>'`);
    expect(stdout.trim()).toBe('Ada Lovelace <ada@example.com>');
  });

  it('commits an empty tree when there is nothing to stage', async () => {
    const dir = join(root, 'bare-project');
    await mkdir(dir, { recursive: true });
    await execAsync(`git init ${dir}`);

    expect(await ensureInitialCommit(dir)).toBe('created');
    expect(await hasCommits(dir)).toBe(true);
  });

  it('is idempotent and leaves an existing history alone', async () => {
    const dir = await freshProject();
    await ensureInitialCommit(dir);
    const { stdout: first } = await execAsync(`git -C ${dir} rev-parse HEAD`);

    expect(await ensureInitialCommit(dir)).toBe('existing');

    const { stdout: second } = await execAsync(`git -C ${dir} rev-parse HEAD`);
    expect(second.trim()).toBe(first.trim());
    const { stdout: count } = await execAsync(`git -C ${dir} rev-list --count HEAD`);
    expect(count.trim()).toBe('1');
  });

  it('skips a directory that is not a repo at all', async () => {
    const dir = join(root, 'plain');
    await mkdir(dir, { recursive: true });
    expect(await ensureInitialCommit(dir)).toBe('skipped');
  });

  // A project created with no agent workflow never reaches tmux session
  // creation, so init-wiki is the only thing that can make its dir a repo.
  it('initializes a dir that is not a repo yet, then commits', async () => {
    const dir = join(root, 'never-inited');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), '# proj\n');

    expect(await ensureProjectRepo(dir)).toBe('created');

    await execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`);
    const { stdout } = await execAsync(`git -C ${dir} show --name-only --format= HEAD`);
    expect(stdout.trim()).toBe('AGENTS.md');
  });

  it('leaves an existing repo with history untouched', async () => {
    const dir = await freshProject();
    await ensureProjectRepo(dir);
    const { stdout: first } = await execAsync(`git -C ${dir} rev-parse HEAD`);

    expect(await ensureProjectRepo(dir)).toBe('existing');

    const { stdout: second } = await execAsync(`git -C ${dir} rev-parse HEAD`);
    expect(second.trim()).toBe(first.trim());
  });

  it('skips a directory merely nested inside another repo', async () => {
    const outer = join(root, 'outer');
    await mkdir(outer, { recursive: true });
    await execAsync(`git init ${outer}`);
    const nested = join(outer, 'projects', 'proj');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'AGENTS.md'), '# proj\n');

    expect(await ensureInitialCommit(nested)).toBe('skipped');
    // The outer repo must be untouched — no stray commit, nothing staged.
    expect(await hasCommits(outer)).toBe(false);
    const { stdout } = await execAsync(`git -C ${outer} diff --cached --name-only`);
    expect(stdout.trim()).toBe('');
  });

  // Start empty after a failed pane checkout leaves `origin` behind with no
  // commits. The clone is abandoned, so the project needs its first commit like
  // any other, or it can never branch off.
  it('commits into a repo with a remote and no commits, an abandoned clone', async () => {
    const dir = await freshProject();
    await execAsync(`git -C ${dir} remote add origin https://example.invalid/repo.git`);

    expect(await ensureProjectRepo(dir)).toBe('created');
    expect(await hasCommits(dir)).toBe(true);
    await execAsync(`git -C ${dir} worktree add -b ws1 ${join(dir, '.worktrees', 'ws1')} HEAD`);
  });
});
