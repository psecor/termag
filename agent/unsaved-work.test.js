'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { countLines, findRepos, scanUnsavedWork } = require('./unsaved-work');

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: ENV, stdio: 'pipe' }).toString();

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unsaved-'));
}

/** A clone of a bare "remote" with one pushed commit, so it starts clean. */
function cleanClone(home, rel) {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-'));
  git(remote, 'init', '--bare', '-q');
  const dir = path.join(home, rel);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(home, 'clone', '-q', remote, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', 'one');
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'fetch', '-q');
  return dir;
}

test('countLines ignores blank lines', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines(null), 0);
  assert.equal(countLines(' M a\n?? b\n\n'), 2);
});

test('findRepos finds repos, worktrees and nested repos, and skips node_modules and dot dirs', () => {
  const home = tempHome();
  const root = path.join(home, 'termag', 'projects');
  for (const d of ['p1/.git', 'p1/.worktrees/ws/.git', 'p2/repo/.git', 'p3/node_modules/x/.git', 'p4/.hidden/y/.git']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  assert.deepEqual(findRepos(root).sort(), [
    path.join(root, 'p1'), path.join(root, 'p1', '.worktrees', 'ws'), path.join(root, 'p2', 'repo'),
  ].sort());
  assert.deepEqual(findRepos(path.join(home, 'missing')), []);
});

test('findRepos scans projects named like build output, but skips build output inside a repo', () => {
  const home = tempHome();
  const root = path.join(home, 'src');
  for (const d of ['build/.git', 'dist/.git', 'vendor/.git', 'app/.git', 'app/build/gen/.git', 'app/vendor/lib/.git']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  assert.deepEqual(findRepos(root).sort(), ['app', 'build', 'dist', 'vendor'].map(n => path.join(root, n)).sort());
});

test('a clean pushed clone has nothing to report', async () => {
  const home = tempHome();
  cleanClone(home, 'src/clean');
  const r = await scanUnsavedWork(execFileAsync, home);
  assert.deepEqual(r, { scanned: 1, repos: [], errors: [], keptCheckouts: 0 });
});

test('untracked files count even when git config hides them from status', async () => {
  const home = tempHome();
  const dir = cleanClone(home, 'src/hidden');
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  const r = await scanUnsavedWork(execFileAsync, home);
  assert.deepEqual(r.repos.map(x => [x.path, x.dirty]), [[dir, 1]]);
});

test('dirty files, unpushed commits, stashes and kept checkouts are all found', async () => {
  const home = tempHome();
  const dirty = cleanClone(home, 'termag/projects/dirty');
  fs.writeFileSync(path.join(dirty, 'new.txt'), 'x\n');

  const ahead = cleanClone(home, 'termag/projects/ahead');
  fs.writeFileSync(path.join(ahead, 'b.txt'), 'b\n');
  git(ahead, 'add', 'b.txt');
  git(ahead, 'commit', '-qm', 'local only');

  const stashed = cleanClone(home, 'src/stashed');
  fs.writeFileSync(path.join(stashed, 'a.txt'), 'changed\n');
  git(stashed, 'stash', '-q');

  const local = path.join(home, 'src', 'never-pushed');
  fs.mkdirSync(local, { recursive: true });
  git(local, 'init', '-q');
  fs.writeFileSync(path.join(local, 'c.txt'), 'c\n');
  git(local, 'add', 'c.txt');
  git(local, 'commit', '-qm', 'no remote');

  fs.mkdirSync(path.join(home, 'ccr', 'kept', 'order-1'), { recursive: true });

  const r = await scanUnsavedWork(execFileAsync, home);
  const byName = Object.fromEntries(r.repos.map(x => [path.basename(x.path), x]));
  assert.equal(r.scanned, 4);
  assert.deepEqual(byName.dirty, { path: dirty, dirty: 1, unpushed: 0, stashes: 0 });
  assert.deepEqual(byName.ahead, { path: ahead, dirty: 0, unpushed: 1, stashes: 0 });
  assert.deepEqual(byName.stashed, { path: stashed, dirty: 0, unpushed: 0, stashes: 1 });
  assert.equal(byName['never-pushed'].unpushed, 1);
  assert.equal(r.keptCheckouts, 1);
  assert.deepEqual(r.errors, []);
});

test('commits only on a detached HEAD count as unpushed', async () => {
  const home = tempHome();
  const dir = cleanClone(home, 'src/detached');
  git(dir, 'checkout', '-q', '--detach');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'd\n');
  git(dir, 'add', 'd.txt');
  git(dir, 'commit', '-qm', 'detached only');
  const r = await scanUnsavedWork(execFileAsync, home);
  assert.deepEqual(r.repos, [{ path: dir, dirty: 0, unpushed: 1, stashes: 0 }]);
  assert.deepEqual(r.errors, []);
});

test('linked worktrees outside the scan roots are found, and stashes count once per repo', async () => {
  const home = tempHome();
  const main = cleanClone(home, 'src/repo');
  fs.writeFileSync(path.join(main, 'a.txt'), 'stashed\n');
  git(main, 'stash', '-q');

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-')));
  const dirtyWt = path.join(outside, 'dirty');
  git(main, 'worktree', 'add', '-q', '-b', 'side', dirtyWt);
  git(dirtyWt, 'push', '-q', '-u', 'origin', 'side');
  fs.writeFileSync(path.join(dirtyWt, 'wip.txt'), 'wip\n');

  const detachedWt = path.join(outside, 'deep', 'er', 'than', 'three', 'detached');
  git(main, 'worktree', 'add', '-q', '--detach', detachedWt);
  fs.writeFileSync(path.join(detachedWt, 'd.txt'), 'd\n');
  git(detachedWt, 'add', 'd.txt');
  git(detachedWt, 'commit', '-qm', 'detached only');

  const goneWt = path.join(outside, 'gone');
  git(main, 'worktree', 'add', '-q', '--detach', goneWt);
  fs.rmSync(goneWt, { recursive: true, force: true });

  const r = await scanUnsavedWork(execFileAsync, home);
  assert.equal(r.scanned, 3);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.repos.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: dirtyWt, dirty: 1, unpushed: 0, stashes: 0 },
    { path: detachedWt, dirty: 0, unpushed: 1, stashes: 0 },
    { path: main, dirty: 0, unpushed: 0, stashes: 1 },
  ].sort((a, b) => a.path.localeCompare(b.path)));
});

test('a repo whose worktrees git cannot list is an error, even when its checkout is clean', async () => {
  const home = tempHome();
  const dir = cleanClone(home, 'src/repo');
  const failWorktreeList = (cmd, args, opts) => args.includes('worktree')
    ? Promise.reject(Object.assign(new Error('boom'), { stderr: 'fatal: boom\n' }))
    : execFileAsync(cmd, args, opts);
  const r = await scanUnsavedWork(failWorktreeList, home);
  assert.deepEqual(r, { scanned: 1, repos: [], errors: [{ path: dir, error: 'fatal: boom' }], keptCheckouts: 0 });
});

test('a repo with no commits yet is clean, not an error', async () => {
  const home = tempHome();
  const dir = path.join(home, 'src', 'empty');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  const r = await scanUnsavedWork(execFileAsync, home);
  assert.deepEqual(r, { scanned: 1, repos: [], errors: [], keptCheckouts: 0 });
});

test('a repo git cannot read is reported as an error, not as clean', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, 'src', 'broken', '.git'), { recursive: true });
  const r = await scanUnsavedWork(execFileAsync, home);
  assert.equal(r.scanned, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, path.join(home, 'src', 'broken'));
});
