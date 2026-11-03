'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitBranchState, gitCheckoutFacts, parseStatusV2, parseWorktreeList } = require('./git-branch-state');

const execFileAsync = promisify(execFile);

test('parseStatusV2 reads branch, upstream, ahead/behind and dirtiness', () => {
  const got = parseStatusV2([
    '# branch.oid 0123',
    '# branch.head feat',
    '# branch.upstream origin/feat',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/x.ts',
    '',
  ].join('\n'));
  assert.deepEqual(got, { branch: 'feat', upstream: 'origin/feat', ahead: 2, behind: 1, abKnown: true, dirty: true, head: null, changed: 1, untracked: 0 });
});

test('parseStatusV2: detached, never pushed, clean', () => {
  assert.deepEqual(parseStatusV2('# branch.oid 0123\n# branch.head (detached)\n'),
    { branch: null, upstream: null, ahead: 0, behind: 0, abKnown: false, dirty: false, head: null, changed: 0, untracked: 0 });
});

test('untracked files make the checkout dirty', () => {
  assert.equal(parseStatusV2('# branch.head feat\n? notes.txt\n').dirty, true);
});

test('parseStatusV2 counts changed and untracked files and reads HEAD, never a name', () => {
  const sha = 'a'.repeat(40);
  const got = parseStatusV2([
    `# branch.oid ${sha}`, '# branch.head feat',
    '1 M. N... 100644 100644 100644 a b staged.ts',
    '2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts',
    'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
    '? notes.txt', '? scratch/', '! ignored.log', '',
  ].join('\n'));
  assert.equal(got.head, sha);
  assert.equal(got.changed, 3);
  assert.equal(got.untracked, 2);
  assert.ok(!JSON.stringify(got).includes('notes.txt'));
});

async function git(cwd, ...args) {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout;
}

test('gitBranchState against a real repository with an origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'base');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'main');
  await git(work, 'remote', 'set-head', 'origin', 'main');
  await git(work, 'checkout', '-q', '-b', 'feat');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'one');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'two');

  const local = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(local.branch, 'feat');
  assert.equal(local.upstream, null);
  assert.equal(local.baseBranch, 'main');
  assert.equal(local.aheadOfBase, 2);
  assert.equal(local.dirty, false);
  assert.equal(local.origin, origin);
  assert.match(local.lastCommitAt, /^\d{4}-\d\d-\d\dT/);

  await git(work, 'push', '-q', '-u', 'origin', 'feat');
  fs.writeFileSync(path.join(work, 'scratch.txt'), 'x');
  const pushed = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(pushed.upstream, 'origin/feat');
  assert.equal(pushed.ahead, 0);
  assert.equal(pushed.dirty, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('gitBranchState finds a master base without origin/HEAD, and reports an uncountable base as null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-master-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  await execFileAsync('git', ['init', '-q', '-b', 'master', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'base');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'master'); // no set-head: origin/HEAD stays unset
  await git(work, 'checkout', '-q', '-b', 'feat');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'one');
  const got = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(got.baseBranch, 'master');
  assert.equal(got.aheadOfBase, 1);

  await git(work, 'update-ref', '-d', 'refs/remotes/origin/master');
  const unknown = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(unknown.baseBranch, 'main');
  assert.equal(unknown.aheadOfBase, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gitBranchState takes no optional lock: a stale index is left for the checkout\'s own git to refresh', async () => {
  // A plain `git status` refreshes a stale index and writes it back, holding
  // index.lock meanwhile; another git writing the checkout then fails.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-lock-'));
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  await git(work, 'add', 'a.txt');
  await git(work, ...env, 'commit', '-q', '-m', 'base');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(work, 'a.txt'), later, later);
  const index = path.join(work, '.git', 'index');
  const before = fs.readFileSync(index);

  const got = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(got.dirty, false);
  assert.ok(fs.readFileSync(index).equals(before), 'the index was rewritten');
});

test('gitBranchState rejects a directory that is not a checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-none-'));
  await assert.rejects(gitBranchState(dir, { execFile: execFileAsync }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an upstream whose remote ref is gone is not "pushed": no ahead/behind line, and origin says no', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'base');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'main');
  await git(work, 'checkout', '-q', '-b', 'feat');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'one');
  await git(work, 'push', '-q', '-u', 'origin', 'feat');

  const pushed = await gitBranchState(work, { execFile: execFileAsync }, { verifyRemote: true });
  assert.equal(pushed.abKnown, true);
  assert.equal(pushed.remoteContainsHead, true);

  // Deleted on the server: the local origin/feat is stale and still says ahead 0.
  await git(origin, 'update-ref', '-d', 'refs/heads/feat');
  const stale = await gitBranchState(work, { execFile: execFileAsync }, { verifyRemote: true });
  assert.equal(stale.ahead, 0);
  assert.equal(stale.remoteContainsHead, false);

  // Pruned locally too: git prints no ahead/behind line at all.
  await git(work, 'fetch', '-q', '--prune', 'origin');
  const gone = await gitBranchState(work, { execFile: execFileAsync }, { verifyRemote: true });
  assert.equal(gone.upstream, 'origin/feat');
  assert.equal(gone.abKnown, false);
  assert.equal(gone.remoteContainsHead, false);

  // A new local commit on top of a pushed branch: origin does not contain HEAD.
  await git(work, 'push', '-q', '-u', 'origin', 'feat');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'two');
  const ahead = await gitBranchState(work, { execFile: execFileAsync }, { verifyRemote: true });
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.remoteContainsHead, false);

  // Without verifyRemote the field is absent, as older backends expect.
  assert.equal('remoteContainsHead' in (await gitBranchState(work, { execFile: execFileAsync })), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gitBranchState counts a local-only checkout against the commit it was spawned from, and only that', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-local-'));
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'base');
  // The parent moved on in its own branch; the child was spawned off its HEAD.
  await git(work, 'checkout', '-q', '-b', 'coord');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'coord work');
  const spawnBase = (await git(work, 'rev-parse', 'HEAD')).trim();
  await git(work, 'checkout', '-q', '-b', 'child');

  // Nothing of its own: retirable.
  const clean = await gitBranchState(work, { execFile: execFileAsync }, { base: spawnBase });
  assert.equal(clean.origin, null);
  assert.equal(clean.aheadOfBase, 0);
  assert.equal(clean.baseLocal, 'spawn-base');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'child work');
  assert.equal((await gitBranchState(work, { execFile: execFileAsync }, { base: spawnBase })).aheadOfBase, 1);

  // No base, or one that isn't a commit here: uncountable, never counted against a local branch.
  for (const opts of [{}, { base: 'deadbeef' }]) {
    const got = await gitBranchState(work, { execFile: execFileAsync }, opts);
    assert.equal(got.aheadOfBase, null);
    assert.equal(got.baseLocal, undefined);
  }
});

test('gitBranchState: a project spawn on main with a sibling master that holds its work stays uncountable', async () => {
  // Bugbot on #498: counting against the other default name would call this empty and archive it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-sibling-'));
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'the child\'s work');
  await git(work, 'branch', 'master');
  const got = await gitBranchState(work, { execFile: execFileAsync });
  assert.equal(got.branch, 'main');
  assert.equal(got.aheadOfBase, null);
  assert.equal(got.baseLocal, undefined);
});

// ── The light form (4d) ──────────────────────────────

test('parseWorktreeList reads paths, heads and branches, and skips bare and prunable entries', () => {
  const sha = 'a'.repeat(40);
  const got = parseWorktreeList([
    `worktree /home/u/src/webapp`, `HEAD ${sha}`, 'branch refs/heads/main', '',
    `worktree /home/u/src/webapp/.worktrees/feat`, `HEAD ${sha}`, 'branch refs/heads/ffeld/feat', '',
    `worktree /home/u/src/webapp/.worktrees/look`, `HEAD ${sha}`, 'detached', '',
    `worktree /home/u/src/gone`, `HEAD ${sha}`, 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', '',
    'worktree /home/u/src/bare.git', 'bare', '',
  ].join('\n'));
  assert.deepEqual(got, [
    { path: '/home/u/src/webapp', head: sha, branch: 'main' },
    { path: '/home/u/src/webapp/.worktrees/feat', head: sha, branch: 'ffeld/feat' },
    { path: '/home/u/src/webapp/.worktrees/look', head: sha, branch: null },
  ]);
});

test('gitCheckoutFacts reports repository, branch, HEAD and resolved top level, and its worktrees on request', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-checkout-facts-')));
  const work = path.join(root, 'work');
  const env = ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  await execFileAsync('git', ['init', '-q', '-b', 'main', work]);
  await git(work, ...env, 'commit', '-q', '--allow-empty', '-m', 'base');
  await git(work, 'remote', 'add', 'origin', 'https://git.example.test/acme/app.git');
  await git(work, 'checkout', '-q', '-b', 'feat');
  const head = (await git(work, 'rev-parse', 'HEAD')).trim();
  const tree = path.join(root, 'tree');
  await git(work, 'worktree', 'add', '-q', '-b', 'side', tree);
  fs.symlinkSync(work, path.join(root, 'link'));
  fs.mkdirSync(path.join(work, 'sub'));

  const plain = await gitCheckoutFacts(work, { execFile: execFileAsync });
  assert.deepEqual(plain, { light: true, dir: work, toplevel: work, branch: 'feat', head, origin: 'https://git.example.test/acme/app.git' });

  const listed = await gitCheckoutFacts(work, { execFile: execFileAsync }, { worktrees: true });
  assert.deepEqual(listed.worktrees, [
    { path: work, head, branch: 'feat' },
    { path: tree, head, branch: 'side' },
  ]);

  // A symlink resolves to the checkout it names; a directory inside a
  // checkout reports the enclosing top level, so the backend can tell them apart.
  const viaLink = await gitCheckoutFacts(path.join(root, 'link'), { execFile: execFileAsync });
  assert.equal(viaLink.dir, work);
  assert.equal(viaLink.toplevel, work);
  const inside = await gitCheckoutFacts(path.join(work, 'sub'), { execFile: execFileAsync });
  assert.equal(inside.dir, path.join(work, 'sub'));
  assert.equal(inside.toplevel, work);

  await git(work, 'checkout', '-q', '--detach');
  const detached = await gitCheckoutFacts(work, { execFile: execFileAsync });
  assert.equal(detached.branch, null);
  assert.equal(detached.head, head);
  fs.rmSync(root, { recursive: true, force: true });
});

test('gitCheckoutFacts: no origin and no commit yet are nulls, and a directory that is not a checkout is an error', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-checkout-facts-')));
  const fresh = path.join(root, 'fresh');
  await execFileAsync('git', ['init', '-q', '-b', 'main', fresh]);
  const got = await gitCheckoutFacts(fresh, { execFile: execFileAsync });
  assert.equal(got.branch, 'main');
  assert.equal(got.head, null);
  assert.equal(got.origin, null);
  const plainDir = path.join(root, 'plain');
  fs.mkdirSync(plainDir);
  await assert.rejects(gitCheckoutFacts(plainDir, { execFile: execFileAsync }));
  fs.rmSync(root, { recursive: true, force: true });
});
