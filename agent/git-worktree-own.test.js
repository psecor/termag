'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { markOwnCheckout, startRefAttestsOwn } = require('./git-worktree-own');

const run = promisify(execFile);

test('a new branch-off records own and an origin upstream, and does not replace pr', async () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-own-'));
  const origin = path.join(dir, 'origin.git');
  const project = path.join(dir, 'project');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '-b', 'main', path.join(dir, 'seed')], { env });
  const seed = path.join(dir, 'seed');
  await git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await run('git', ['clone', '-q', origin, project], { env });

  const topic = path.join(project, '.worktrees', 'topic');
  await git(project, 'worktree', 'add', '-q', '-b', 'topic', topic, 'HEAD');
  const marked = await markOwnCheckout({ worktreePath: topic, branch: 'topic', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.equal(marked.marked, true);
  assert.equal((await git(topic, 'config', '--local', '--get', 'branch.topic.termagCheckout')).stdout.trim(), 'own');
  assert.equal((await git(topic, 'config', '--local', '--get', 'branch.topic.remote')).stdout.trim(), 'origin');
  assert.equal((await git(topic, 'config', '--local', '--get', 'branch.topic.merge')).stdout.trim(), 'refs/heads/topic');

  await git(topic, 'config', '--local', 'branch.topic.merge', 'refs/heads/main');
  await markOwnCheckout({ worktreePath: topic, branch: 'topic', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.equal((await git(topic, 'config', '--local', '--get', 'branch.topic.merge')).stdout.trim(), 'refs/heads/main');

  await git(project, 'config', '--local', 'branch.topic.termagCheckout', 'pr');
  const kept = await markOwnCheckout({ worktreePath: topic, branch: 'topic', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.deepEqual(kept, { marked: false, reason: 'pr' });
  assert.equal((await git(topic, 'config', '--local', '--get', 'branch.topic.termagCheckout')).stdout.trim(), 'pr');

  const local = path.join(dir, 'local');
  await run('git', ['init', '-q', '-b', 'main', local], { env });
  await git(local, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const side = path.join(local, '.worktrees', 'side');
  await git(local, 'worktree', 'add', '-q', '-b', 'side', side, 'HEAD');
  const sideMarked = await markOwnCheckout({ worktreePath: side, branch: 'side', repoPath: local, startPoint: 'HEAD' }, { execFile: exec });
  assert.deepEqual(sideMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(side, 'config', '--local', '--get', 'branch.side.termagCheckout'));
  await assert.rejects(git(side, 'config', '--local', '--get', 'branch.side.remote'));
});

test('startRefAttestsOwn is an already-own branch or the main worktree current same-repo branch', () => {
  const origin = 'https://github.com/example-org/webapp.git';
  const fork = 'git@github.com:contributor/webapp.git';
  const same = 'git@github.com:example-org/webapp.git';
  assert.equal(startRefAttestsOwn('refs/heads/main', { originUrl: origin }), false);
  // A missing marker plus a same-repo upstream is not proof.
  assert.equal(startRefAttestsOwn('refs/heads/main', { originUrl: origin, upstreamRemoteUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/heads/main', {
    originUrl: origin, upstreamRemoteUrl: origin, currentBranch: 'main',
  }), true);
  assert.equal(startRefAttestsOwn('refs/heads/feat', {
    originUrl: origin, upstreamRemoteUrl: origin, currentBranch: 'main',
  }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { originUrl: origin, upstreamRemoteUrl: fork }), false);
  // A bare origin/<name> is not proof, including origin/main, until it is the current branch.
  assert.equal(startRefAttestsOwn('refs/remotes/origin/main', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/main', {
    originUrl: origin, upstreamRemoteUrl: origin, currentBranch: 'main',
  }), true);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/feat', {
    originUrl: origin, upstreamRemoteUrl: origin, currentBranch: 'main',
  }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/main', { originUrl: '' }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/pr/4', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/pull/4/head', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/pull/4/head', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/tags/v1', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('HEAD', { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn(null, { originUrl: origin }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/fork/main', {
    originUrl: origin, remoteUrl: fork, currentBranch: 'main', upstreamRemoteUrl: origin,
  }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/mirror/main', {
    originUrl: origin, remoteUrl: same, currentBranch: 'main', upstreamRemoteUrl: origin,
  }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { checkout: 'pr' }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { checkout: 'fork' }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { checkout: 'own' }), true);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/feat', { checkout: 'own', originUrl: origin }), true);
  assert.equal(startRefAttestsOwn('refs/remotes/fork/feat', { checkout: 'own', originUrl: origin, remoteUrl: fork }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', {
    checkout: 'own', originUrl: origin, upstreamRemoteUrl: fork,
  }), true);
  assert.equal(startRefAttestsOwn('refs/heads/feat', {
    checkout: 'own', upstreamMerge: 'refs/pull/3/head', originUrl: origin, upstreamRemoteUrl: origin,
  }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { upstreamMerge: 'refs/pull/3/head' }), false);
  assert.equal(startRefAttestsOwn('refs/heads/feat', { upstreamRef: 'origin/pr/3' }), false);
  assert.equal(startRefAttestsOwn('refs/heads/main', {
    originUrl: origin, upstreamRemoteUrl: same,
    upstreamMerge: 'refs/heads/main', upstreamRef: 'origin/main', currentBranch: 'main',
  }), true);
  assert.equal(startRefAttestsOwn('refs/heads/main', {
    upstreamMerge: 'refs/heads/main', upstreamRef: 'origin/main', currentBranch: 'main',
  }), false);
  assert.equal(startRefAttestsOwn('refs/remotes/origin/feat', { originUrl: origin, checkout: 'pr' }), false);
});

test('a raw commit or a pull ref is not marked own, and a same-repo branch that shares its commit still is', async () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const commit = (cwd, msg) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-own-start-'));
  const origin = path.join(dir, 'origin.git');
  const project = path.join(dir, 'project');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  const seed = path.join(dir, 'seed');
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await commit(seed, 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await run('git', ['clone', '-q', origin, project], { env });

  const mainOid = (await git(project, 'rev-parse', 'HEAD')).stdout.trim();
  await git(project, 'update-ref', 'refs/pull/4/head', mainOid);
  await git(project, 'update-ref', 'refs/remotes/origin/pr/4', mainOid);

  const off = path.join(project, '.worktrees', 'off-main');
  await git(project, 'worktree', 'add', '-q', '-b', 'off-main', off, 'main');
  const branchOff = await markOwnCheckout({ worktreePath: off, branch: 'off-main', repoPath: project, startPoint: 'main' }, { execFile: exec });
  assert.equal(branchOff.marked, true);
  assert.equal((await git(off, 'config', '--local', '--get', 'branch.off-main.termagCheckout')).stdout.trim(), 'own');

  await git(project, 'checkout', '-q', '--detach');
  await commit(project, 'pr only');
  const raw = (await git(project, 'rev-parse', 'HEAD')).stdout.trim();
  await git(project, 'update-ref', 'refs/pull/9/head', raw);
  await git(project, 'checkout', '-q', 'main');

  const fromOid = path.join(project, '.worktrees', 'from-oid');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-oid', fromOid, raw);
  const oidMarked = await markOwnCheckout({ worktreePath: fromOid, branch: 'from-oid', repoPath: project, startPoint: raw }, { execFile: exec });
  assert.deepEqual(oidMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromOid, 'config', '--local', '--get', 'branch.from-oid.termagCheckout'));
  await assert.rejects(git(fromOid, 'config', '--local', '--get', 'branch.from-oid.remote'));
  await assert.rejects(git(fromOid, 'config', '--local', '--get', 'branch.from-oid.merge'));

  const fromPull = path.join(project, '.worktrees', 'from-pull');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-pull', fromPull, 'refs/pull/9/head');
  const pullMarked = await markOwnCheckout({ worktreePath: fromPull, branch: 'from-pull', repoPath: project, startPoint: 'refs/pull/9/head' }, { execFile: exec });
  assert.deepEqual(pullMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromPull, 'config', '--local', '--get', 'branch.from-pull.termagCheckout'));
  await assert.rejects(git(fromPull, 'config', '--local', '--get', 'branch.from-pull.merge'));

  const fromPr = path.join(project, '.worktrees', 'from-pr');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-pr', fromPr, 'origin/pr/4');
  const prMarked = await markOwnCheckout({ worktreePath: fromPr, branch: 'from-pr', repoPath: project, startPoint: 'origin/pr/4' }, { execFile: exec });
  assert.deepEqual(prMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromPr, 'config', '--local', '--get', 'branch.from-pr.termagCheckout'));

  const fromOrigin = path.join(project, '.worktrees', 'from-origin');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-origin', fromOrigin, 'origin/main');
  const originMarked = await markOwnCheckout({ worktreePath: fromOrigin, branch: 'from-origin', repoPath: project, startPoint: 'origin/main' }, { execFile: exec });
  assert.equal(originMarked.marked, true);
  assert.equal((await git(fromOrigin, 'config', '--local', '--get', 'branch.from-origin.termagCheckout')).stdout.trim(), 'own');
  // git already tracks origin/main. The marker must not replace that with a made-up branch.
  assert.equal((await git(fromOrigin, 'config', '--local', '--get', 'branch.from-origin.merge')).stdout.trim(), 'refs/heads/main');

  await git(project, 'tag', 'v1', 'main');
  const fromTag = path.join(project, '.worktrees', 'from-tag');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-tag', fromTag, 'v1');
  const tagMarked = await markOwnCheckout({ worktreePath: fromTag, branch: 'from-tag', repoPath: project, startPoint: 'v1' }, { execFile: exec });
  assert.deepEqual(tagMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromTag, 'config', '--local', '--get', 'branch.from-tag.termagCheckout'));

  await git(project, 'checkout', '-q', '--detach', 'main');
  const fromDetach = path.join(project, '.worktrees', 'from-detach');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-detach', fromDetach, 'HEAD');
  const detachMarked = await markOwnCheckout({ worktreePath: fromDetach, branch: 'from-detach', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.deepEqual(detachMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromDetach, 'config', '--local', '--get', 'branch.from-detach.termagCheckout'));
  await git(project, 'checkout', '-q', 'main');
  // Detached branch-off must not label main, which also tracks origin/main, as a pull request.
  await assert.rejects(git(project, 'config', '--local', '--get', 'branch.main.termagCheckout'));

  const other = path.join(dir, 'other.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', other], { env });
  const otherSeed = path.join(dir, 'other-seed');
  await run('git', ['init', '-q', '-b', 'main', otherSeed], { env });
  await commit(otherSeed, 'fork');
  await git(otherSeed, 'remote', 'add', 'origin', other);
  await git(otherSeed, 'push', '-q', 'origin', 'main');
  await git(project, 'remote', 'add', 'fork', other);
  await git(project, 'fetch', '-q', 'fork');
  const fromFork = path.join(project, '.worktrees', 'from-fork');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-fork', fromFork, 'fork/main');
  const forkMarked = await markOwnCheckout({ worktreePath: fromFork, branch: 'from-fork', repoPath: project, startPoint: 'fork/main' }, { execFile: exec });
  assert.deepEqual(forkMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromFork, 'config', '--local', '--get', 'branch.from-fork.termagCheckout'));
  // git tracks the fork branch it started from. That is not an invented origin upstream.
  assert.equal((await git(fromFork, 'config', '--local', '--get', 'branch.from-fork.remote')).stdout.trim(), 'fork');
  assert.equal((await git(fromFork, 'config', '--local', '--get', 'branch.from-fork.merge')).stdout.trim(), 'refs/heads/main');
});

test('branching off a pull-request local branch does not mark the new branch own', async () => {
  const { checkoutOwnTree, readCheckoutFacts } = require('./chat-runner');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-own-pr-branch-'));
  const origin = path.join(dir, 'origin.git');
  const project = path.join(dir, 'project');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  const seed = path.join(dir, 'seed');
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await run('git', ['clone', '-q', origin, project], { env });

  await git(project, 'branch', 'feat');
  await git(project, 'config', '--local', 'branch.feat.termagCheckout', 'pr');
  await git(project, 'config', '--local', 'branch.feat.remote', 'origin');
  await git(project, 'config', '--local', 'branch.feat.merge', 'refs/heads/feat');
  const fromPr = path.join(project, '.worktrees', 'from-pr-branch');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-pr-branch', fromPr, 'feat');
  const prMarked = await markOwnCheckout({ worktreePath: fromPr, branch: 'from-pr-branch', repoPath: project, startPoint: 'feat' }, { execFile: exec });
  assert.deepEqual(prMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromPr, 'config', '--local', '--get', 'branch.from-pr-branch.termagCheckout'));
  await assert.rejects(git(fromPr, 'config', '--local', '--get', 'branch.from-pr-branch.remote'));
  await assert.rejects(git(fromPr, 'config', '--local', '--get', 'branch.from-pr-branch.merge'));
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.feat.termagCheckout')).stdout.trim(), 'pr');
  const facts = await readCheckoutFacts(fromPr, run);
  assert.equal(facts.checkout, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'checkout', '-q', 'feat');
  const fromHead = path.join(project, '.worktrees', 'from-pr-head');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-pr-head', fromHead, 'HEAD');
  const headMarked = await markOwnCheckout({ worktreePath: fromHead, branch: 'from-pr-head', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.deepEqual(headMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromHead, 'config', '--local', '--get', 'branch.from-pr-head.termagCheckout'));
  await git(project, 'checkout', '-q', 'main');

  await git(project, 'branch', 'forked');
  await git(project, 'config', '--local', 'branch.forked.termagCheckout', 'fork');
  const fromFork = path.join(project, '.worktrees', 'from-fork-branch');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-fork-branch', fromFork, 'forked');
  const forkMarked = await markOwnCheckout({ worktreePath: fromFork, branch: 'from-fork-branch', repoPath: project, startPoint: 'forked' }, { execFile: exec });
  assert.deepEqual(forkMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromFork, 'config', '--local', '--get', 'branch.from-fork-branch.termagCheckout'));

  await git(project, 'branch', 'tracks-pull');
  await git(project, 'config', '--local', 'branch.tracks-pull.remote', 'origin');
  await git(project, 'config', '--local', 'branch.tracks-pull.merge', 'refs/pull/3/head');
  const fromPull = path.join(project, '.worktrees', 'from-tracks-pull');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-tracks-pull', fromPull, 'tracks-pull');
  const pullMarked = await markOwnCheckout({ worktreePath: fromPull, branch: 'from-tracks-pull', repoPath: project, startPoint: 'tracks-pull' }, { execFile: exec });
  assert.deepEqual(pullMarked, { marked: false, reason: 'start' });
  await assert.rejects(git(fromPull, 'config', '--local', '--get', 'branch.from-tracks-pull.termagCheckout'));
  await assert.rejects(git(fromPull, 'config', '--local', '--get', 'branch.from-tracks-pull.merge'));

  const mainOid = (await git(project, 'rev-parse', 'main')).stdout.trim();
  await git(project, 'update-ref', 'refs/pull/4/head', mainOid);
  await git(project, 'update-ref', 'refs/remotes/origin/pr/4', mainOid);
  const off = path.join(project, '.worktrees', 'off-main');
  await git(project, 'worktree', 'add', '-q', '-b', 'off-main', off, 'main');
  const branchOff = await markOwnCheckout({ worktreePath: off, branch: 'off-main', repoPath: project, startPoint: 'main' }, { execFile: exec });
  assert.equal(branchOff.marked, true);
  assert.equal((await git(off, 'config', '--local', '--get', 'branch.off-main.termagCheckout')).stdout.trim(), 'own');
  const mainFacts = await readCheckoutFacts(off, run);
  assert.equal(checkoutOwnTree(mainFacts), true);

  const fromOrigin = path.join(project, '.worktrees', 'from-origin-feat');
  await git(project, 'update-ref', 'refs/remotes/origin/feat', 'feat');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-origin-feat', fromOrigin, 'origin/feat');
  const originFeat = await markOwnCheckout({ worktreePath: fromOrigin, branch: 'from-origin-feat', repoPath: project, startPoint: 'origin/feat' }, { execFile: exec });
  assert.deepEqual(originFeat, { marked: false, reason: 'start' });
  await assert.rejects(git(fromOrigin, 'config', '--local', '--get', 'branch.from-origin-feat.termagCheckout'));
});

test('a local start is own only when it is already marked own, or it is the main worktree current same-repo branch', async () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const absent = async (cwd, key) => assert.rejects(git(cwd, 'config', '--local', '--get', key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-own-local-'));
  const origin = path.join(dir, 'origin.git');
  const project = path.join(dir, 'project');
  const forkBare = path.join(dir, 'fork.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  await run('git', ['init', '-q', '--bare', '-b', 'main', forkBare], { env });
  const seed = path.join(dir, 'seed');
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main', 'main:refs/pull/4/head');
  await run('git', ['clone', '-q', origin, project], { env });
  await git(project, 'remote', 'add', 'contributor', forkBare);

  const add = async (name, start) => {
    const wt = path.join(project, '.worktrees', name);
    await git(project, 'worktree', 'add', '-q', '-b', name, wt, start);
    const marked = await markOwnCheckout({ worktreePath: wt, branch: name, repoPath: project, startPoint: start }, { execFile: exec });
    return { wt, marked };
  };

  await git(project, 'branch', 'no-up');
  const noUp = await add('from-no-up', 'no-up');
  assert.deepEqual(noUp.marked, { marked: false, reason: 'start' });
  await absent(noUp.wt, 'branch.from-no-up.termagCheckout');
  await absent(noUp.wt, 'branch.from-no-up.remote');
  await absent(noUp.wt, 'branch.from-no-up.merge');

  await git(project, 'fetch', '-q', 'origin', 'refs/pull/4/head:fetched-pr');
  const fetched = await add('from-fetched', 'fetched-pr');
  assert.deepEqual(fetched.marked, { marked: false, reason: 'start' });
  await absent(fetched.wt, 'branch.from-fetched.termagCheckout');
  await absent(fetched.wt, 'branch.from-fetched.remote');
  await absent(fetched.wt, 'branch.from-fetched.merge');

  await git(project, 'branch', 'fork-local');
  await git(project, 'config', '--local', 'branch.fork-local.remote', 'contributor');
  await git(project, 'config', '--local', 'branch.fork-local.merge', 'refs/heads/main');
  const forkLocal = await add('from-fork-local', 'fork-local');
  assert.deepEqual(forkLocal.marked, { marked: false, reason: 'start' });
  await absent(forkLocal.wt, 'branch.from-fork-local.termagCheckout');
  await absent(forkLocal.wt, 'branch.from-fork-local.remote');
  await absent(forkLocal.wt, 'branch.from-fork-local.merge');

  await git(project, 'branch', 'tracks-pull');
  await git(project, 'config', '--local', 'branch.tracks-pull.termagCheckout', 'own');
  await git(project, 'config', '--local', 'branch.tracks-pull.remote', 'origin');
  await git(project, 'config', '--local', 'branch.tracks-pull.merge', 'refs/pull/4/head');
  const pullOwn = await add('from-pull-own', 'tracks-pull');
  assert.deepEqual(pullOwn.marked, { marked: false, reason: 'start' });
  await absent(pullOwn.wt, 'branch.from-pull-own.termagCheckout');
  await absent(pullOwn.wt, 'branch.from-pull-own.remote');

  await git(project, 'branch', 'owned');
  await git(project, 'config', '--local', 'branch.owned.termagCheckout', 'own');
  const owned = await add('from-owned', 'owned');
  assert.equal(owned.marked.marked, true);
  assert.equal((await git(owned.wt, 'config', '--local', '--get', 'branch.from-owned.termagCheckout')).stdout.trim(), 'own');
  assert.equal((await git(owned.wt, 'config', '--local', '--get', 'branch.from-owned.remote')).stdout.trim(), 'origin');
  assert.equal((await git(owned.wt, 'config', '--local', '--get', 'branch.from-owned.merge')).stdout.trim(), 'refs/heads/from-owned');

  await git(project, 'branch', 'tracks-origin');
  await git(project, 'config', '--local', 'branch.tracks-origin.remote', 'origin');
  await git(project, 'config', '--local', 'branch.tracks-origin.merge', 'refs/heads/main');
  const tracks = await add('from-tracks-origin', 'tracks-origin');
  assert.deepEqual(tracks.marked, { marked: false, reason: 'start' });
  await absent(tracks.wt, 'branch.from-tracks-origin.termagCheckout');
  await absent(tracks.wt, 'branch.from-tracks-origin.remote');
  await absent(tracks.wt, 'branch.from-tracks-origin.merge');
  // Tracking origin/main under another name is not origin/<that branch>, so it is not backfilled as pr.
  await absent(project, 'branch.tracks-origin.termagCheckout');

  const mainOid = (await git(project, 'rev-parse', 'main')).stdout.trim();
  await git(project, 'update-ref', 'refs/pull/9/head', mainOid);
  await git(project, 'update-ref', 'refs/remotes/origin/pr/9', mainOid);
  const off = await add('off-main', 'main');
  assert.equal(off.marked.marked, true);
  assert.equal((await git(off.wt, 'config', '--local', '--get', 'branch.off-main.termagCheckout')).stdout.trim(), 'own');
  await absent(project, 'branch.main.termagCheckout');
});

test('an unmarked origin/<branch> is backfilled as pr and the new worktree stays unmarked', async () => {
  const { checkoutOwnTree, readCheckoutFacts } = require('./chat-runner');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const absent = async (cwd, key) => assert.rejects(git(cwd, 'config', '--local', '--get', key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-own-backfill-'));
  const origin = path.join(dir, 'origin.git');
  const project = path.join(dir, 'project');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  const seed = path.join(dir, 'seed');
  await run('git', ['init', '-q', '-b', 'main', seed], { env });
  await git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-q', 'origin', 'main');
  await run('git', ['clone', '-q', origin, project], { env });

  const track = async (name) => {
    await git(project, 'branch', name);
    await git(project, 'config', '--local', `branch.${name}.remote`, 'origin');
    await git(project, 'config', '--local', `branch.${name}.merge`, `refs/heads/${name}`);
  };
  await track('old-pr');
  await track('also-pr');
  await git(project, 'branch', 'owned');
  await git(project, 'config', '--local', 'branch.owned.termagCheckout', 'own');
  await git(project, 'config', '--local', 'branch.owned.remote', 'origin');
  await git(project, 'config', '--local', 'branch.owned.merge', 'refs/heads/owned');

  const fromPr = path.join(project, '.worktrees', 'from-old-pr');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-old-pr', fromPr, 'old-pr');
  const marked = await markOwnCheckout({ worktreePath: fromPr, branch: 'from-old-pr', repoPath: project, startPoint: 'old-pr' }, { execFile: exec });
  assert.deepEqual(marked, { marked: false, reason: 'start' });
  await absent(fromPr, 'branch.from-old-pr.termagCheckout');
  await absent(fromPr, 'branch.from-old-pr.remote');
  await absent(fromPr, 'branch.from-old-pr.merge');
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.old-pr.termagCheckout')).stdout.trim(), 'pr');
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.also-pr.termagCheckout')).stdout.trim(), 'pr');
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.owned.termagCheckout')).stdout.trim(), 'own');
  await absent(project, 'branch.main.termagCheckout');
  const facts = await readCheckoutFacts(fromPr, run);
  assert.equal(facts.checkout, null);
  assert.equal(checkoutOwnTree(facts), false);

  await git(project, 'update-ref', 'refs/remotes/origin/old-pr', 'old-pr');
  const fromOrigin = path.join(project, '.worktrees', 'from-origin-old');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-origin-old', fromOrigin, 'origin/old-pr');
  const originMarked = await markOwnCheckout({ worktreePath: fromOrigin, branch: 'from-origin-old', repoPath: project, startPoint: 'origin/old-pr' }, { execFile: exec });
  assert.deepEqual(originMarked, { marked: false, reason: 'start' });
  await absent(fromOrigin, 'branch.from-origin-old.termagCheckout');
  const originFacts = await readCheckoutFacts(fromOrigin, run);
  assert.equal(checkoutOwnTree(originFacts), false);

  await track('current-topic');
  await git(project, 'checkout', '-q', 'current-topic');
  const fromCurrent = path.join(project, '.worktrees', 'from-current');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-current', fromCurrent, 'HEAD');
  const currentMarked = await markOwnCheckout({ worktreePath: fromCurrent, branch: 'from-current', repoPath: project, startPoint: 'HEAD' }, { execFile: exec });
  assert.equal(currentMarked.marked, true);
  assert.equal((await git(fromCurrent, 'config', '--local', '--get', 'branch.from-current.termagCheckout')).stdout.trim(), 'own');
  await absent(project, 'branch.current-topic.termagCheckout');
  const currentFacts = await readCheckoutFacts(fromCurrent, run);
  assert.equal(checkoutOwnTree(currentFacts), true);
  await git(project, 'checkout', '-q', 'main');
  await absent(project, 'branch.main.termagCheckout');
});

test('a missing or non-symbolic origin/HEAD does not backfill main or master as pr', async () => {
  const { checkoutOwnTree, readCheckoutFacts } = require('./chat-runner');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], { env });
  const exec = (cmd, args, opts) => run(cmd, args, { ...opts, env });
  const absent = async (cwd, key) => assert.rejects(git(cwd, 'config', '--local', '--get', key));
  const commit = (cwd, msg) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);

  const setup = async (defaultBranch) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `worktree-own-head-${defaultBranch}-`));
    const origin = path.join(dir, 'origin.git');
    const project = path.join(dir, 'project');
    await run('git', ['init', '-q', '--bare', '-b', defaultBranch, origin], { env });
    const seed = path.join(dir, 'seed');
    await run('git', ['init', '-q', '-b', defaultBranch, seed], { env });
    await commit(seed, 'init');
    await git(seed, 'remote', 'add', 'origin', origin);
    await git(seed, 'push', '-q', 'origin', defaultBranch);
    await run('git', ['clone', '-q', origin, project], { env });
    await git(project, 'remote', 'set-head', 'origin', '-d');
    await assert.rejects(git(project, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'));
    return project;
  };

  const project = await setup('main');
  await git(project, 'checkout', '-q', '-b', 'side');
  await git(project, 'branch', 'old-pr');
  await git(project, 'config', '--local', 'branch.old-pr.remote', 'origin');
  await git(project, 'config', '--local', 'branch.old-pr.merge', 'refs/heads/old-pr');
  await git(project, 'branch', 'kept-fork');
  await git(project, 'config', '--local', 'branch.kept-fork.termagCheckout', 'fork');
  await git(project, 'branch', 'tracks-pull');
  await git(project, 'config', '--local', 'branch.tracks-pull.remote', 'origin');
  await git(project, 'config', '--local', 'branch.tracks-pull.merge', 'refs/pull/3/head');

  const fromPr = path.join(project, '.worktrees', 'from-old-pr');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-old-pr', fromPr, 'old-pr');
  const marked = await markOwnCheckout({ worktreePath: fromPr, branch: 'from-old-pr', repoPath: project, startPoint: 'old-pr' }, { execFile: exec });
  assert.deepEqual(marked, { marked: false, reason: 'start' });
  await absent(fromPr, 'branch.from-old-pr.termagCheckout');
  assert.equal(checkoutOwnTree(await readCheckoutFacts(fromPr, run)), false);
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.old-pr.termagCheckout')).stdout.trim(), 'pr');
  await absent(project, 'branch.main.termagCheckout');
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.kept-fork.termagCheckout')).stdout.trim(), 'fork');

  const fromPull = path.join(project, '.worktrees', 'from-pull');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-pull', fromPull, 'tracks-pull');
  const pullMarked = await markOwnCheckout({ worktreePath: fromPull, branch: 'from-pull', repoPath: project, startPoint: 'tracks-pull' }, { execFile: exec });
  assert.deepEqual(pullMarked, { marked: false, reason: 'start' });
  await absent(fromPull, 'branch.from-pull.termagCheckout');
  await absent(project, 'branch.tracks-pull.termagCheckout');
  assert.equal(checkoutOwnTree(await readCheckoutFacts(fromPull, run)), false);

  const fromFork = path.join(project, '.worktrees', 'from-fork');
  await git(project, 'worktree', 'add', '-q', '-b', 'from-fork', fromFork, 'kept-fork');
  const forkMarked = await markOwnCheckout({ worktreePath: fromFork, branch: 'from-fork', repoPath: project, startPoint: 'kept-fork' }, { execFile: exec });
  assert.deepEqual(forkMarked, { marked: false, reason: 'start' });
  await absent(fromFork, 'branch.from-fork.termagCheckout');
  assert.equal((await git(project, 'config', '--local', '--get', 'branch.kept-fork.termagCheckout')).stdout.trim(), 'fork');
  assert.equal(checkoutOwnTree(await readCheckoutFacts(fromFork, run)), false);

  await git(project, 'checkout', '-q', 'main');
  const mainFacts = await readCheckoutFacts(project, run);
  assert.equal(mainFacts.checkout, null);
  assert.equal(mainFacts.branch, 'main');
  assert.equal(checkoutOwnTree(mainFacts), true);

  // A direct ref at refs/remotes/origin/HEAD is not a symref. main still stays unmarked.
  await git(project, 'checkout', '-q', 'side');
  await git(project, 'update-ref', 'refs/remotes/origin/HEAD', 'main');
  await assert.rejects(git(project, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'));
  const again = path.join(project, '.worktrees', 'again');
  await git(project, 'worktree', 'add', '-q', '-b', 'again', again, 'old-pr');
  await markOwnCheckout({ worktreePath: again, branch: 'again', repoPath: project, startPoint: 'old-pr' }, { execFile: exec });
  await absent(project, 'branch.main.termagCheckout');

  const master = await setup('master');
  await assert.rejects(git(master, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'));
  await git(master, 'checkout', '-q', '-b', 'side');
  await git(master, 'branch', 'old-pr');
  await git(master, 'config', '--local', 'branch.old-pr.remote', 'origin');
  await git(master, 'config', '--local', 'branch.old-pr.merge', 'refs/heads/old-pr');
  const fromMasterPr = path.join(master, '.worktrees', 'from-old-pr');
  await git(master, 'worktree', 'add', '-q', '-b', 'from-old-pr', fromMasterPr, 'old-pr');
  const masterMarked = await markOwnCheckout({ worktreePath: fromMasterPr, branch: 'from-old-pr', repoPath: master, startPoint: 'old-pr' }, { execFile: exec });
  assert.deepEqual(masterMarked, { marked: false, reason: 'start' });
  assert.equal((await git(master, 'config', '--local', '--get', 'branch.old-pr.termagCheckout')).stdout.trim(), 'pr');
  await absent(master, 'branch.master.termagCheckout');
  await git(master, 'checkout', '-q', 'master');
  const masterFacts = await readCheckoutFacts(master, run);
  assert.equal(masterFacts.branch, 'master');
  assert.equal(masterFacts.checkout, null);
  assert.equal(checkoutOwnTree(masterFacts), true);
});
