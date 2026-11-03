'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { branchArg, gitChanges, parseDiff, countLines, MAX_FILES } = require('./git-changes');

const execFileAsync = promisify(execFile);
const deps = { execFile: execFileAsync };

test('parseDiff joins numstat and name-status, renames and binaries included', () => {
  const numstat = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0');
  const nameStatus = ['M', 'src/a.ts', 'A', 'img.png', 'R087', 'old.ts', 'new.ts', ''].join('\0');
  assert.deepEqual(parseDiff(numstat, nameStatus), [
    { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
    { path: 'img.png', status: 'A', additions: null, deletions: null },
    { path: 'new.ts', from: 'old.ts', status: 'R', additions: 2, deletions: 0 },
  ]);
});

test('parseDiff keeps a path with a tab or newline whole (-z)', () => {
  const numstat = ['1\t0\tweird\tname\n.txt', ''].join('\0');
  const nameStatus = ['A', 'weird\tname\n.txt', ''].join('\0');
  assert.deepEqual(parseDiff(numstat, nameStatus), [{ path: 'weird\tname\n.txt', status: 'A', additions: 1, deletions: 0 }]);
});

test('countLines counts a last line without a newline, and calls a NUL binary', () => {
  assert.equal(countLines(Buffer.from('')), 0);
  assert.equal(countLines(Buffer.from('a\nb\n')), 2);
  assert.equal(countLines(Buffer.from('a\nb')), 2);
  assert.equal(countLines(Buffer.from([97, 0, 98])), null);
});

async function git(cwd, ...args) {
  return (await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })).stdout.trim();
}

/** A bare origin with one commit on main, and a clone of it. */
async function cloneWithOrigin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-changes-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(seed, 'gone.txt'), 'x\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-q', '-m', 'seed');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await execFileAsync('git', ['clone', '-q', origin, clone]);
  return { root, clone };
}

test('a clean checkout on its pushed main has nothing in flight', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    const got = await gitChanges(clone, deps);
    assert.equal(got.branch, 'main');
    assert.equal(got.upstream, 'origin/main');
    assert.equal(got.against, 'origin/main');
    assert.deepEqual([got.commits, got.committed, got.uncommitted, got.truncated], [0, [], [], false]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uncommitted: edits, a deletion, a staged file and an untracked one, with their lines', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    fs.writeFileSync(path.join(clone, 'a.txt'), 'one\nTWO\nthree\n');
    fs.rmSync(path.join(clone, 'gone.txt'));
    fs.writeFileSync(path.join(clone, 'staged.txt'), 's\n');
    await git(clone, 'add', 'staged.txt');
    fs.mkdirSync(path.join(clone, 'dir'));
    fs.writeFileSync(path.join(clone, 'dir', 'new.md'), '# hi\n\nbody');
    const got = await gitChanges(clone, deps);
    const byPath = Object.fromEntries(got.uncommitted.map(f => [f.path, f]));
    assert.deepEqual(byPath['a.txt'], { path: 'a.txt', status: 'M', additions: 2, deletions: 1 });
    assert.deepEqual(byPath['gone.txt'], { path: 'gone.txt', status: 'D', additions: 0, deletions: 1 });
    assert.deepEqual(byPath['staged.txt'], { path: 'staged.txt', status: 'A', additions: 1, deletions: 0 });
    assert.deepEqual(byPath['dir/new.md'], { path: 'dir/new.md', status: '?', additions: 3, deletions: 0 });
    assert.deepEqual(got.committed, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('committed: a branch never pushed counts from origin main; once pushed, from its upstream', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    await git(clone, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    await git(clone, 'add', 'b.txt');
    await git(clone, 'commit', '-q', '-m', 'b');
    let got = await gitChanges(clone, deps);
    assert.equal(got.upstream, null);
    assert.equal(got.against, 'origin/main');
    assert.equal(got.commits, 1);
    assert.deepEqual(got.committed, [{ path: 'b.txt', status: 'A', additions: 1, deletions: 0 }]);

    await git(clone, 'push', '-q', '-u', 'origin', 'feat');
    fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
    await git(clone, 'add', 'c.txt');
    await git(clone, 'commit', '-q', '-m', 'c');
    got = await gitChanges(clone, deps);
    assert.equal(got.against, 'origin/feat');
    assert.equal(got.commits, 1);
    assert.deepEqual(got.committed.map(f => f.path), ['c.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an untracked symlink, binary or large file is listed without lines', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    fs.symlinkSync('/etc/hosts', path.join(clone, 'link'));
    fs.writeFileSync(path.join(clone, 'bin.dat'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(clone, 'big.txt'), 'x\n'.repeat(600 * 1024));
    const got = await gitChanges(clone, deps);
    const byPath = Object.fromEntries(got.uncommitted.map(f => [f.path, f]));
    for (const p of ['link', 'bin.dat', 'big.txt']) assert.deepEqual([byPath[p].additions, byPath[p].deletions], [null, null], p);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a checkout without a remote reports its uncommitted files and no committed ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-changes-'));
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    let got = await gitChanges(root, deps);
    assert.equal(got.head, null);
    assert.deepEqual(got.uncommitted.map(f => [f.path, f.status]), [['a.txt', '?']]);
    await git(root, 'add', 'a.txt');
    await git(root, 'commit', '-q', '-m', 'a');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\n');
    got = await gitChanges(root, deps);
    assert.equal(got.against, null);
    assert.deepEqual(got.committed, []);
    assert.deepEqual(got.uncommitted, [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a list longer than MAX_FILES is cut and says so', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    for (let i = 0; i < MAX_FILES + 5; i++) fs.writeFileSync(path.join(clone, `f${i}.txt`), 'x\n');
    const got = await gitChanges(clone, deps);
    assert.equal(got.uncommitted.length, MAX_FILES);
    assert.equal(got.truncated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("with a branch, reads the repository's worktree on it rather than the checkout asked about", async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    const wt = path.join(clone, '.worktrees', 'topic');
    await git(clone, 'worktree', 'add', '-q', '-b', 'topic', wt);
    fs.writeFileSync(path.join(wt, 'in-topic.txt'), 't\n');
    fs.writeFileSync(path.join(clone, 'in-main.txt'), 'm\n');
    let got = await gitChanges(clone, deps, { branch: 'topic' });
    assert.equal(got.worktree, true);
    assert.equal(got.branch, 'topic');
    assert.equal(fs.realpathSync(got.toplevel), fs.realpathSync(wt));
    assert.deepEqual(got.uncommitted.map(f => f.path), ['in-topic.txt']);
    // On the branch already, or a branch no worktree has: the checkout asked about.
    got = await gitChanges(clone, deps, { branch: 'main' });
    assert.deepEqual([got.worktree, got.branch], [false, 'main']);
    got = await gitChanges(clone, deps, { branch: 'nowhere' });
    assert.deepEqual([got.worktree, got.branch], [false, 'main']);
    assert.ok(got.uncommitted.some(f => f.path === 'in-main.txt'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('branchArg takes a plain branch name and nothing else', () => {
  for (const ok of ['main', 'feat/x', 'jonny/pr-info-refresh', 'a.b_c-1']) assert.equal(branchArg(ok), ok);
  for (const bad of ['', '-x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'x@{1}', 'a\0b', 42, null, 'x'.repeat(256)]) assert.equal(branchArg(bad), null, String(bad));
});

test('a committed diff that fails says partial, not that the commits change nothing', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    await git(clone, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    await git(clone, 'add', 'b.txt');
    await git(clone, 'commit', '-q', '-m', 'b');
    const failing = { execFile: (cmd, args, o) => (args.some(a => String(a).endsWith('...HEAD')) ? Promise.reject(new Error('maxBuffer exceeded')) : execFileAsync(cmd, args, o)) };
    const got = await gitChanges(clone, failing);
    assert.deepEqual([got.commits, got.committed, got.partial], [1, [], true]);
    assert.equal((await gitChanges(clone, deps)).partial, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the answer keeps to its deadline: past it, the committed files are skipped as partial and untracked lines go uncounted', async () => {
  const { root, clone } = await cloneWithOrigin();
  try {
    await git(clone, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    await git(clone, 'add', 'b.txt');
    await git(clone, 'commit', '-q', '-m', 'b');
    fs.writeFileSync(path.join(clone, 'new.txt'), 'n\n');
    // Each git call "takes" a second of a fake clock, as on a slow checkout.
    let t = 0;
    const asked = [];
    const slow = {
      now: () => t,
      execFile: async (cmd, args, o) => {
        asked.push(args.join(' '));
        assert.ok(o.timeout <= 5000 && o.timeout > 0, `a call got ${o.timeout} ms`);
        try { return await execFileAsync(cmd, args, o); } finally { t += 1000; }
      },
    };
    const got = await gitChanges(clone, slow);
    assert.equal(got.partial, true);
    assert.deepEqual(got.committed, []);
    assert.ok(!asked.some(a => a.includes('...HEAD')), 'no committed diff once the time is spent');
    assert.deepEqual(got.uncommitted.map(f => [f.path, f.additions]), [['new.txt', null]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a directory that is not a checkout is an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-changes-'));
  try {
    await assert.rejects(gitChanges(dir, deps));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
