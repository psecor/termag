'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const { MAX_DURATION_MS, addPrWorktree, parseWorktreeList } = require('./git-worktree-pr');

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const deps = { execFile: (cmd, args, opts) => promisify(execFile)(cmd, args, { ...opts, env }) };

/**
 * An origin with main, a same-repo PR branch feat/x (pull/1) and a fork's PR
 * (pull/2, branch fork-branch not on origin); a clone of it as the project.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtpr-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { env });
  const commit = (cwd, msg) => run(cwd, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
  commit(seed, 'init');
  run(seed, 'remote', 'add', 'origin', origin);
  run(seed, 'push', '-q', 'origin', 'main');
  run(seed, 'checkout', '-q', '-b', 'feat/x'); commit(seed, 'pr 1 a'); commit(seed, 'pr 1 b');
  run(seed, 'push', '-q', 'origin', 'feat/x', 'feat/x:refs/pull/1/head');
  run(seed, 'checkout', '-q', '-b', 'fork-branch', 'main'); commit(seed, 'pr 2');
  run(seed, 'push', '-q', 'origin', 'fork-branch:refs/pull/2/head');
  const project = path.join(dir, 'project');
  execFileSync('git', ['clone', '-q', origin, project], { env });
  return { dir, project, commit, oid: (ref) => run(seed, 'rev-parse', ref) };
}
const same = f => ({ projectDir: f.project, worktreeName: 'proj-x', branch: 'feat/x', number: 1, sameRepo: true, headOid: f.oid('feat/x') });
const fork = f => ({ projectDir: f.project, worktreeName: 'proj-fork', branch: 'fork-branch', number: 2, sameRepo: false, headOid: f.oid('fork-branch') });
const upstreamOf = (wt) => { try { return run(wt, 'rev-parse', '--abbrev-ref', '@{u}'); } catch { return null; } };

test('parseWorktreeList reads paths, branches and prunable entries', () => {
  assert.deepStrictEqual(parseWorktreeList('worktree /p\nHEAD abc\nbranch refs/heads/main\n\nworktree /p/.worktrees/a\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n'),
    [{ path: '/p', branch: 'main', prunable: false }, { path: '/p/.worktrees/a', branch: null, prunable: true }]);
});

test('checks out a same-repo PR on its own branch, tracking origin', async () => {
  const f = fixture();
  const got = await addPrWorktree(same(f), deps);
  const wt = path.join(f.project, '.worktrees', 'proj-x');
  assert.deepStrictEqual(got, { ok: true, path: wt, localBranch: false, fastForwarded: false, upstream: true });
  assert.strictEqual(run(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/x');
  assert.strictEqual(run(wt, 'rev-parse', 'HEAD'), f.oid('feat/x'));
  assert.strictEqual(upstreamOf(wt), 'origin/feat/x');
  assert.deepStrictEqual(await addPrWorktree(same(f), deps), { ok: true, path: wt, existing: true });
});

test('checks out a fork\'s PR from pull/<n>/head with no upstream at all (Devin 1)', async () => {
  const f = fixture();
  const got = await addPrWorktree(fork(f), deps);
  assert.strictEqual(got.upstream, false);
  assert.strictEqual(run(got.path, 'rev-parse', 'HEAD'), f.oid('fork-branch'));
  assert.strictEqual(upstreamOf(got.path), null);
});

test('refuses when origin\'s pull ref is not the PR\'s head: the wrong repository (Devin 2)', async () => {
  const f = fixture();
  await assert.rejects(addPrWorktree({ ...same(f), headOid: f.oid('main') }, deps), /not a checkout of the PR's repository/);
  assert.strictEqual(fs.existsSync(path.join(f.project, '.worktrees', 'proj-x')), false);
});

test('refuses a fork PR whose branch name is an unrelated local branch (Devin 3, Bugbot)', async () => {
  const f = fixture();
  run(f.project, 'branch', 'fork-branch', 'origin/main');
  f.commit(f.project, 'unrelated');
  run(f.project, 'branch', '-f', 'fork-branch', 'HEAD');
  run(f.project, 'reset', '-q', '--hard', 'origin/main');
  await assert.rejects(addPrWorktree(fork(f), deps), /already exists with other work/);
});

test('fast-forwards a local branch behind the PR, and keeps one ahead of it (Devin 4)', async () => {
  const f = fixture();
  run(f.project, 'branch', 'feat/x', `${f.oid('feat/x')}~1`);
  const got = await addPrWorktree(same(f), deps);
  assert.strictEqual(got.fastForwarded, true);
  assert.strictEqual(run(got.path, 'rev-parse', 'HEAD'), f.oid('feat/x'));

  const g = fixture();
  run(g.project, 'fetch', '-q', 'origin', 'feat/x:feat/x');
  run(g.project, 'checkout', '-q', 'feat/x'); g.commit(g.project, 'unpushed'); const ahead = run(g.project, 'rev-parse', 'HEAD');
  run(g.project, 'checkout', '-q', 'main');
  const kept = await addPrWorktree(same(g), deps);
  assert.strictEqual(kept.fastForwarded, false);
  assert.strictEqual(run(kept.path, 'rev-parse', 'HEAD'), ahead);
});

test('adopts a live worktree on the branch, through a symlinked project dir too, and refuses the main checkout (Devin 5)', async () => {
  const f = fixture();
  run(f.project, 'fetch', '-q', 'origin', 'feat/x:feat/x');
  run(f.project, 'worktree', 'add', '-q', path.join(f.project, '.worktrees', 'agent-made'), 'feat/x');
  const link = path.join(f.dir, 'linked');
  fs.symlinkSync(f.project, link);
  const got = await addPrWorktree({ ...same(f), projectDir: link }, deps);
  assert.strictEqual(got.adopted, 'agent-made');
  await assert.rejects(addPrWorktree({ ...same(f), worktreeName: 'proj-main', branch: 'main', headOid: f.oid('feat/x') }, deps),
    /main is checked out at .* with work that is not this PR's|main is already checked out at/);
});

test('ignores a stale worktree whose directory is gone (Bugbot), and refuses one holding other work', async () => {
  const f = fixture();
  run(f.project, 'fetch', '-q', 'origin', 'feat/x:feat/x');
  const gone = path.join(f.project, '.worktrees', 'gone');
  run(f.project, 'worktree', 'add', '-q', gone, 'feat/x');
  fs.rmSync(gone, { recursive: true, force: true });
  const got = await addPrWorktree(same(f), deps);
  assert.strictEqual(got.adopted, undefined);
  assert.strictEqual(run(got.path, 'rev-parse', 'HEAD'), f.oid('feat/x'));

  const g = fixture();
  run(g.project, 'branch', 'feat/x', 'origin/main');
  const other = path.join(g.project, '.worktrees', 'other');
  run(g.project, 'worktree', 'add', '-q', other, 'feat/x');
  g.commit(other, 'not the PR');
  await assert.rejects(addPrWorktree(same(g), deps), /with work that is not this PR's/);
});

test('judges branch names by git check-ref-format, and refuses unsafe input before touching origin (Devin 6)', async () => {
  const f = fixture();
  await assert.rejects(addPrWorktree({ ...same(f), branch: 'a..b' }, deps), /branch/);
  await assert.rejects(addPrWorktree({ ...same(f), branch: '-a' }, deps), /branch/);
  const never = { execFile: () => { throw new Error('ran git'); } };
  await assert.rejects(addPrWorktree({ ...same(f), worktreeName: '../x' }, never), /worktreeName/);
  await assert.rejects(addPrWorktree({ ...same(f), number: 0 }, never), /number/);
  await assert.rejects(addPrWorktree({ ...same(f), headOid: 'abc' }, never), /headOid/);
});

test('gives the checkout the long budget, and says how long a call can take', async () => {
  const f = fixture();
  const seen = [];
  const spy = { execFile: (cmd, args, opts) => { seen.push([args.slice(2, 4).join(' '), opts.timeout]); return deps.execFile(cmd, args, opts); } };
  await addPrWorktree(same(f), spy);
  assert.deepStrictEqual(seen.filter(([a]) => a.startsWith('worktree add')).map(([, t]) => t), [90_000]);
  assert.deepStrictEqual(seen.filter(([a]) => a.startsWith('fetch')).map(([, t]) => t), [90_000, 90_000]);
  // The orchestrator's RPC timeout (backend routes/workstreams.ts PR_CHECKOUT_TIMEOUT_MS) must be longer.
  assert.ok(MAX_DURATION_MS < 600_000);
});
