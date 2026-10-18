'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitBranchState, parseStatusV2 } = require('./git-branch-state');

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
  assert.deepEqual(got, { branch: 'feat', upstream: 'origin/feat', ahead: 2, behind: 1, dirty: true });
});

test('parseStatusV2: detached, never pushed, clean', () => {
  assert.deepEqual(parseStatusV2('# branch.oid 0123\n# branch.head (detached)\n'),
    { branch: null, upstream: null, ahead: 0, behind: 0, dirty: false });
});

test('untracked files make the checkout dirty', () => {
  assert.equal(parseStatusV2('# branch.head feat\n? notes.txt\n').dirty, true);
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

test('gitBranchState rejects a directory that is not a checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-state-none-'));
  await assert.rejects(gitBranchState(dir, { execFile: execFileAsync }));
  fs.rmSync(dir, { recursive: true, force: true });
});
