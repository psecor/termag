'use strict';
/**
 * The non-PR worktree path (`git-worktree-add`). A branch-off is this
 * repository's own tree only when the source branch is already marked
 * `own`, or it is the branch checked out in the main worktree and that
 * branch's upstream is this repository. A missing `termagCheckout` plus a
 * same-repo origin upstream is not that proof, and neither is a bare
 * `refs/remotes/origin/<name>`: an existing pull-request checkout has the
 * same shape. This writes the proof the chat runner reads, the marker
 * `own`, and an upstream of `origin/<branch>` when the new branch does not
 * already track something.
 *
 * Anything else leaves the new worktree unmarked and does not invent an
 * upstream, so the runner stays on dontAsk. A `pr` or `fork` marker, a
 * pull-ref upstream, and a remote other than origin stay read-only. An
 * existing local branch that already tracks `origin/<that branch>` and has
 * no marker is backfilled as `pr`, except the main worktree's current
 * branch and the default branch. The default is whatever `origin/HEAD`
 * names, or `origin/main` / `origin/master` when that symref is missing
 * (the same fallback as git-branch-state.js). Another ref that happens
 * to point at the same commit is not consulted.
 *
 * Every git call is an argument list. Nothing here is parsed by a shell.
 */

const LOCAL_TIMEOUT_MS = 20_000;

async function git(execFile, cwd, args) {
  return execFile('git', ['-C', cwd, ...args], { timeout: LOCAL_TIMEOUT_MS });
}

async function configGet(execFile, cwd, key) {
  try {
    return String((await git(execFile, cwd, ['config', '--local', '--get', key])).stdout || '').trim();
  } catch {
    return '';
  }
}

async function remoteUrl(execFile, cwd, remote) {
  if (!remote || remote.startsWith('-')) return '';
  try {
    return String((await git(execFile, cwd, ['remote', 'get-url', '--', remote])).stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * `owner/name` for a GitHub https or ssh remote, lowercased. Same shape as
 * chat-runner.js githubSlug, so a fork URL and this repo's origin compare
 * as repositories rather than as strings.
 */
function githubSlug(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function sameRepository(originUrl, upstreamUrl) {
  if (typeof originUrl !== 'string' || typeof upstreamUrl !== 'string') return false;
  const origin = githubSlug(originUrl);
  const upstream = githubSlug(upstreamUrl);
  if (origin || upstream) return origin != null && origin === upstream;
  const norm = (u) => u.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  return norm(originUrl) !== '' && norm(originUrl) === norm(upstreamUrl);
}

/** A pull-request ref in the full form `rev-parse --symbolic-full-name` returns. */
function isTrackedPullRef(name) {
  return /^refs\/pull\/\d+\/head$/.test(name)
    || /^refs\/remotes\/[^/]+\/pr\/\d+$/.test(name)
    || /^refs\/remotes\/[^/]+\/pull\/\d+\/head$/.test(name);
}

/** The local branch a start ref names: `refs/heads/X`, or the same-named branch of a remote-tracking ref. */
function localBranchName(fullRef) {
  if (typeof fullRef !== 'string') return null;
  if (fullRef.startsWith('refs/heads/') && fullRef.length > 'refs/heads/'.length) return fullRef.slice('refs/heads/'.length);
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(fullRef);
  if (!remote || remote[1] === 'HEAD') return null;
  return remote[1];
}

/** A configured upstream that is a pull-request ref, full name or `origin/pr/<n>`. */
function isPullUpstream(name) {
  if (typeof name !== 'string' || !name) return false;
  return isTrackedPullRef(name)
    || /^[^/]+\/pr\/\d+$/.test(name)
    || /^[^/]+\/pull\/\d+\/head$/.test(name);
}

/**
 * The local branch this start resolved to is not a pull-request checkout.
 * Only that branch's own marker and its own upstream count.
 */
function sourceBranchAllowsOwn({ checkout = '', upstreamMerge = '', upstreamRef = '' } = {}) {
  if (checkout === 'pr' || checkout === 'fork') return false;
  if (isPullUpstream(upstreamMerge) || isPullUpstream(upstreamRef)) return false;
  return true;
}

/**
 * Whether `fullRef` may be recorded as this repository's own tree.
 * `fullRef` is the start point's symbolic name, or null when it was a raw
 * commit. HEAD that did not resolve to a branch (detached) is not one.
 * True only when that branch is already marked `own`, or `currentBranch`
 * is the main worktree's checkout, the ref names that same branch (as
 * `refs/heads/<name>` or `refs/remotes/origin/<name>`), and its upstream
 * remote is this repository. A missing marker, a bare `origin/<name>`, a
 * `pr` or `fork` marker, a pull-ref upstream, and any other remote do not
 * attest. `remoteUrl` is accepted and ignored: a non-origin remote is not
 * proof.
 */
function startRefAttestsOwn(fullRef, { originUrl = '', upstreamRemoteUrl = '', checkout = '', upstreamMerge = '', upstreamRef = '', currentBranch = '' } = {}) {
  if (typeof fullRef !== 'string' || !fullRef || fullRef === 'HEAD') return false;
  if (isTrackedPullRef(fullRef)) return false;
  if (!sourceBranchAllowsOwn({ checkout, upstreamMerge, upstreamRef })) return false;
  const name = localBranchName(fullRef);
  if (!name) return false;
  const remote = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(fullRef);
  const local = fullRef.startsWith('refs/heads/');
  if (!local && !(remote && remote[1] === 'origin')) return false;
  if (checkout === 'own') return true;
  if (!currentBranch || name !== currentBranch) return false;
  return sameRepository(originUrl, upstreamRemoteUrl);
}

/** A branch name that is safe to interpolate into a `branch.<name>.*` config key. */
function branchConfigSafe(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !name.startsWith('-') && !name.includes('..') && !/[\0\n\r\s~^:?*[\\]/.test(name);
}

/** The branch checked out in the main worktree, or '' when `repoPath` is detached or itself a linked worktree. */
async function mainWorktreeBranch(execFile, repoPath) {
  if (!repoPath) return '';
  try {
    const gitDir = String((await git(execFile, repoPath, ['rev-parse', '--path-format=absolute', '--git-dir'])).stdout || '').trim().replace(/\/+$/, '');
    const commonDir = String((await git(execFile, repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout || '').trim().replace(/\/+$/, '');
    if (!gitDir || gitDir !== commonDir) return '';
    const head = String((await git(execFile, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '').trim();
    return head && head !== 'HEAD' ? head : '';
  } catch {
    return '';
  }
}

async function refExists(execFile, repoPath, ref) {
  try {
    await git(execFile, repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default branch, so it is not labelled a pull request. `origin/HEAD`
 * when that ref is symbolic. A missing or non-symbolic `origin/HEAD` is
 * normal (an old clone, a hand-added remote); then `origin/main`, else
 * `origin/master`, else `main`, the same fallback as git-branch-state.js.
 */
async function originHeadBranch(execFile, repoPath) {
  try {
    const name = String((await git(execFile, repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout || '').trim();
    if (name.startsWith('origin/')) return name.slice('origin/'.length);
  } catch { /* missing, or a direct ref rather than a symref */ }
  if (await refExists(execFile, repoPath, 'refs/remotes/origin/main')) return 'main';
  if (await refExists(execFile, repoPath, 'refs/remotes/origin/master')) return 'master';
  return 'main';
}

/**
 * Existing same-repo pull-request branches: `origin/<name>` upstream and no
 * marker. They are indistinguishable from a fetched PR head, so they become
 * `pr`. The main worktree's current branch and the default branch are the
 * project's own tree and stay unmarked. The branch just created stays
 * unmarked too; this path decides that one itself.
 */
async function backfillUnmarkedPrBranches(execFile, repoPath, { currentBranch = '', skipBranch = '' } = {}) {
  if (!repoPath) return;
  const keep = new Set([currentBranch, skipBranch, await originHeadBranch(execFile, repoPath)].filter(Boolean));
  let listed = '';
  try {
    listed = String((await git(execFile, repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout || '');
  } catch {
    return;
  }
  for (const raw of listed.split('\n')) {
    const name = raw.trim();
    if (!branchConfigSafe(name) || keep.has(name)) continue;
    const marker = await configGet(execFile, repoPath, `branch.${name}.termagCheckout`);
    if (marker) continue;
    const remoteName = await configGet(execFile, repoPath, `branch.${name}.remote`);
    const merge = await configGet(execFile, repoPath, `branch.${name}.merge`);
    if (remoteName !== 'origin' || merge !== `refs/heads/${name}`) continue;
    await git(execFile, repoPath, ['config', '--local', `branch.${name}.termagCheckout`, 'pr']);
  }
}

/** The start point's full ref, or null when it is a raw commit or not a ref. Resolved in the repo the branch was added from, so HEAD is that checkout. */
async function resolvedStartRef(execFile, repoPath, startPoint) {
  if (!repoPath || typeof startPoint !== 'string' || !startPoint || startPoint.startsWith('-') || startPoint.includes('..')) return null;
  try {
    const { stdout } = await git(execFile, repoPath, ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', startPoint]);
    const name = String(stdout || '').trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Record that `branch` in `worktreePath` is a branch-off of this repository.
 * Does not replace `pr` or `fork`. Does not replace an upstream that is
 * already configured. Does nothing unless `startPoint`, resolved in
 * `repoPath`, is a branch already marked `own` or the main worktree's
 * current same-repo branch: no marker, no invented upstream. Other
 * unmarked `origin/<name>` branches are backfilled as `pr` first.
 */
async function markOwnCheckout({ worktreePath, branch, repoPath, startPoint }, { execFile }) {
  if (!worktreePath || typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.includes('..')) {
    throw new Error('worktreePath and branch are required');
  }
  const currentBranch = await mainWorktreeBranch(execFile, repoPath);
  await backfillUnmarkedPrBranches(execFile, repoPath, { currentBranch, skipBranch: branch });
  const fullRef = await resolvedStartRef(execFile, repoPath, startPoint);
  const originUrl = repoPath ? await remoteUrl(execFile, repoPath, 'origin') : '';
  const source = localBranchName(fullRef);
  let checkout = '';
  let upstreamMerge = '';
  let upstreamRef = '';
  let upstreamRemoteUrl = '';
  if (repoPath && branchConfigSafe(source)) {
    checkout = await configGet(execFile, repoPath, `branch.${source}.termagCheckout`);
    upstreamMerge = await configGet(execFile, repoPath, `branch.${source}.merge`);
    const remoteName = await configGet(execFile, repoPath, `branch.${source}.remote`);
    if (remoteName && upstreamMerge && !remoteName.startsWith('-') && !upstreamMerge.startsWith('-')) {
      upstreamRef = upstreamMerge.startsWith('refs/heads/')
        ? `${remoteName}/${upstreamMerge.slice('refs/heads/'.length)}`
        : upstreamMerge;
      upstreamRemoteUrl = await remoteUrl(execFile, repoPath, remoteName);
    }
  }
  if (!startRefAttestsOwn(fullRef, { originUrl, upstreamRemoteUrl, checkout, upstreamMerge, upstreamRef, currentBranch })) {
    return { marked: false, reason: 'start' };
  }

  const key = `branch.${branch}.termagCheckout`;
  const existing = await configGet(execFile, worktreePath, key);
  if (existing === 'pr' || existing === 'fork') return { marked: false, reason: existing };
  if (existing !== 'own') await git(execFile, worktreePath, ['config', '--local', key, 'own']);

  const remoteKey = `branch.${branch}.remote`;
  const mergeKey = `branch.${branch}.merge`;
  const configuredRemote = await configGet(execFile, worktreePath, remoteKey);
  const merge = await configGet(execFile, worktreePath, mergeKey);
  if (!(configuredRemote && merge)) {
    if (originUrl) {
      await git(execFile, worktreePath, ['config', '--local', remoteKey, 'origin']);
      await git(execFile, worktreePath, ['config', '--local', mergeKey, `refs/heads/${branch}`]);
    }
  }
  return { marked: true };
}

module.exports = { markOwnCheckout, startRefAttestsOwn };
