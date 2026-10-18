'use strict';
// Run with: node --test agent/
//
// Mirrors backend/src/services/gitRepo.test.ts. The two implementations are
// duplicated by hand (the agent ships standalone), so both carry their own
// coverage of the same contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureInitialCommit, ensureProjectRepo, hasCommits, INITIAL_COMMIT_MESSAGE } = require('./git-repo');

const execAsync = promisify(exec);

// Throwaway root per test, with git pointed at a blank config so the machine's
// own identity (or lack of one) can't change the outcome.
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-gitrepo-'));
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  return root;
}

async function freshProject(root, name = 'proj') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  await execAsync(`git init ${dir}`);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# proj\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  return dir;
}

test('initial commit is what makes a worktree possible in a fresh project', async () => {
  const root = mkRoot();
  const dir = await freshProject(root);

  // The bug: branching off a new project fails on the unborn HEAD.
  await assert.rejects(
    execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`)
  );

  assert.equal(await ensureInitialCommit(dir), 'created');

  await execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`);
  const { stdout } = await execAsync(`git -C ${dir}/.worktrees/feature rev-parse --abbrev-ref HEAD`);
  assert.equal(stdout.trim(), 'feature');
});

test('initial commit carries the seeded wiki files and a termag fallback identity', async () => {
  const root = mkRoot();
  const dir = await freshProject(root);
  await ensureInitialCommit(dir);

  const { stdout: files } = await execAsync(`git -C ${dir} show --name-only --format= HEAD`);
  assert.deepEqual(files.split('\n').map(s => s.trim()).filter(Boolean).sort(), ['AGENTS.md', 'CLAUDE.md']);

  const { stdout: subject } = await execAsync(`git -C ${dir} log -1 --format=%s`);
  assert.equal(subject.trim(), INITIAL_COMMIT_MESSAGE);

  const { stdout: author } = await execAsync(`git -C ${dir} log -1 --format='%an <%ae>'`);
  assert.equal(author.trim(), 'termag <termag@localhost>');
});

test('initial commit is idempotent and never rewrites existing history', async () => {
  const root = mkRoot();
  const dir = await freshProject(root);
  await ensureInitialCommit(dir);
  const { stdout: first } = await execAsync(`git -C ${dir} rev-parse HEAD`);

  assert.equal(await ensureInitialCommit(dir), 'existing');

  const { stdout: second } = await execAsync(`git -C ${dir} rev-parse HEAD`);
  assert.equal(second.trim(), first.trim());
});

// A project created with no agent workflow never reaches tmux-create, so
// init-wiki is the only thing that can make its dir a repo.
test('a dir that was never git init-ed becomes a repo with a commit', async () => {
  const root = mkRoot();
  const dir = path.join(root, 'never-inited');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# proj\n');

  assert.equal(await ensureProjectRepo(dir), 'created');

  await execAsync(`git -C ${dir} worktree add -b feature ${dir}/.worktrees/feature HEAD`);
  const { stdout } = await execAsync(`git -C ${dir} show --name-only --format= HEAD`);
  assert.equal(stdout.trim(), 'AGENTS.md');
});

test('a dir that is not a repo root is left alone', async () => {
  const root = mkRoot();

  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(await ensureInitialCommit(plain), 'skipped');

  // Nested inside an unrelated repo: committing would land in the outer repo.
  const outer = path.join(root, 'outer');
  fs.mkdirSync(outer, { recursive: true });
  await execAsync(`git init ${outer}`);
  const nested = path.join(outer, 'projects', 'proj');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(await ensureInitialCommit(nested), 'skipped');
  assert.equal(await hasCommits(outer), false);
});

// Start empty after a failed pane checkout leaves `origin` behind with no
// commits. The clone is abandoned, so the project needs its first commit like
// any other, or it can never branch off.
test('a repo with a remote and no commits, an abandoned clone, gets its first commit', async () => {
  const root = mkRoot();
  const dir = await freshProject(root);
  await execAsync(`git -C ${dir} remote add origin https://example.invalid/repo.git`);

  assert.equal(await ensureProjectRepo(dir), 'created');
  assert.equal(await hasCommits(dir), true);
  await execAsync(`git -C ${dir} worktree add -b ws1 ${path.join(dir, '.worktrees', 'ws1')} HEAD`);
});
