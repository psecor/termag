import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gitWorktreeRemoveLocal, lastGitError } from './worktreeRemove';

// Real git on a throwaway repo: the failure this guards against ("is not a
// working tree") comes from git itself, so a mocked exec would prove nothing.
const git = (dir: string, args: string) =>
  execSync(`git -C "${dir}" ${args}`, { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString();

const branches = (dir: string) => git(dir, "branch --format='%(refname:short)'").trim().split('\n').sort();

describe('gitWorktreeRemoveLocal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'termag-wt-'));
    git(dir, 'init -q -b main');
    git(dir, 'config user.email t@example.com');
    git(dir, 'config user.name t');
    writeFileSync(join(dir, 'README'), 'x\n');
    git(dir, 'add README');
    git(dir, 'commit -q -m init');
    git(dir, `worktree add -q -b feat ${join(dir, '.worktrees', 'feat')} HEAD`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes a live worktree and its branch', async () => {
    const warning = await gitWorktreeRemoveLocal(dir, 'feat', 'feat', true);
    expect(warning).toBeNull();
    expect(existsSync(join(dir, '.worktrees', 'feat'))).toBe(false);
    expect(branches(dir)).toEqual(['main']);
  });

  it('a worktree whose directory is already gone counts as removed: prunes, deletes the branch, no throw', async () => {
    rmSync(join(dir, '.worktrees', 'feat'), { recursive: true, force: true });
    // git still has the stale registration; `worktree remove` on it would fail.
    expect(git(dir, 'worktree list --porcelain')).toContain('.worktrees/feat');

    const warning = await gitWorktreeRemoveLocal(dir, 'feat', 'feat', true);
    expect(warning).toBeNull();
    expect(git(dir, 'worktree list --porcelain')).not.toContain('.worktrees/feat');
    expect(branches(dir)).toEqual(['main']);
  });

  it('a live worktree with uncommitted changes is still refused without force', async () => {
    writeFileSync(join(dir, '.worktrees', 'feat', 'dirty'), 'y\n');
    await expect(gitWorktreeRemoveLocal(dir, 'feat', 'feat', false)).rejects.toThrow();
    expect(existsSync(join(dir, '.worktrees', 'feat'))).toBe(true);
  });

  it('an unmerged branch left behind without force is a warning, not an error', async () => {
    writeFileSync(join(dir, '.worktrees', 'feat', 'f'), 'z\n');
    git(join(dir, '.worktrees', 'feat'), 'add f');
    git(join(dir, '.worktrees', 'feat'), 'commit -q -m work');
    const warning = await gitWorktreeRemoveLocal(dir, 'feat', 'feat', false);
    expect(warning).toMatch(/not fully merged/);
    expect(branches(dir)).toEqual(['feat', 'main']);
  });
});

describe('lastGitError', () => {
  it('skips the hint lines newer git appends after the real error', () => {
    const msg = [
      "Command failed: git -C '/p' branch -d feat",
      "error: the branch 'feat' is not fully merged",
      'hint: If you are sure you want to delete it, run \'git branch -D feat\'',
      'hint: Disable this message with "git config set advice.forceDeleteBranch false"',
      '',
    ].join('\n');
    expect(lastGitError(msg)).toBe("error: the branch 'feat' is not fully merged");
    expect(lastGitError('fatal: boom\n')).toBe('fatal: boom');
    expect(lastGitError('   ')).toBeNull();
  });
  it('git 2.43 puts the advice on a bare line after the error', () => {
    const msg = "Command failed: git branch -d feat\nerror: the branch 'feat' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feat'\n";
    expect(lastGitError(msg)).toBe("error: the branch 'feat' is not fully merged.");
  });
  it('falls back to the last line when git prints no error: prefix', () => {
    expect(lastGitError('something odd happened\nand then this\n')).toBe('and then this');
  });
});
