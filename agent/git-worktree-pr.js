'use strict';
/**
 * The `git-worktree-add-pr` RPC: a worktree at <projectDir>/.worktrees/<worktreeName> on a pull
 * request's own branch, so the agent there works on the PR itself and a push
 * updates it.
 *
 *   1. `git fetch origin +refs/pull/<n>/head`, which must land on `headOid`,
 *      the PR's head as GitHub reports it: anything else means this project's
 *      origin is not the PR's repository, and nothing is checked out.
 *   2. The branch already in a live worktree: that path itself is reused; one
 *      under .worktrees/ (a plain `git worktree` an agent made) is adopted, and
 *      its directory name comes back so the workstream takes it, if its HEAD
 *      is the PR's head or ahead of or behind it. Elsewhere (the main
 *      checkout), or holding other work: an error, since git allows a branch
 *      in one worktree only. Stale (prunable) entries are ignored.
 *   3. Otherwise the local branch if there is one: fast-forwarded when it is
 *      behind the PR's head, kept when it is ahead (unpushed work), refused
 *      when it has diverged or is unrelated. Else a new branch at the PR's
 *      head, untracked. A PR from the same repository then gets its upstream
 *      (origin/<branch>), so a plain `git push` updates it; a fork's never
 *      tracks anything, so a push cannot land on the shared repository.
 *
 * Every git call goes through execFile with an argument list: nothing here is
 * parsed by a shell.
 */

const fs = require('fs');

const CAPABILITIES = ['worktree-pr-v1'];

const NAME = /^[A-Za-z0-9_-]+$/;
const OID = /^[0-9a-f]{40}$/;
// A fetch from a big repository can take a while, and so can writing out its
// checkout (`worktree add`); the other steps only read refs.
const FETCH_TIMEOUT_MS = 90_000;
const CHECKOUT_TIMEOUT_MS = 90_000;
const LOCAL_TIMEOUT_MS = 20_000;
/** The longest one call can take (two fetches, the checkout and the ref steps), for the orchestrator's RPC timeout. */
// At most 12 ref steps: check-ref-format, rev-parse x4, prune, list, merge-base x4, branch -f or --set-upstream-to.
const MAX_DURATION_MS = 2 * FETCH_TIMEOUT_MS + CHECKOUT_TIMEOUT_MS + 12 * LOCAL_TIMEOUT_MS;

/** Worktrees from `git worktree list --porcelain`: path, branch (null when detached), and whether git calls it prunable. */
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length), branch: null, prunable: false }; out.push(cur); }
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length);
    else if (cur && (line === 'prunable' || line.startsWith('prunable '))) cur.prunable = true;
  }
  return out;
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

async function addPrWorktree({ projectDir, worktreeName, branch, number, sameRepo, headOid }, { execFile }) {
  if (!projectDir || !worktreeName || !branch || !number || !headOid) {
    throw new Error('projectDir, worktreeName, branch, number and headOid are required');
  }
  if (!NAME.test(worktreeName)) throw new Error('worktreeName must be alphanumeric with dashes/underscores only');
  if (typeof branch !== 'string' || branch.startsWith('-')) throw new Error('branch contains disallowed characters');
  if (!Number.isInteger(number) || number < 1) throw new Error('number must be a PR number');
  if (!OID.test(headOid)) throw new Error('headOid must be a full commit id');
  const git = (args, cwd = projectDir, timeout = LOCAL_TIMEOUT_MS) => execFile('git', ['-C', cwd, ...args], { timeout });
  const ok = (args, cwd) => git(args, cwd).then(() => true, () => false);
  const oidOf = async (ref, cwd) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).stdout.trim();
  // `a` is the same as, or an ancestor of, `b`.
  const within = (a, b, cwd) => ok(['merge-base', '--is-ancestor', a, b], cwd);
  const related = async (tip, cwd) => tip === headOid || await within(tip, headOid, cwd) || await within(headOid, tip, cwd);

  // git's own rule for branch names (GitHub allows more than a short allowlist would).
  if (!await ok(['check-ref-format', '--branch', branch])) throw new Error('branch contains disallowed characters');

  const prRef = `refs/remotes/origin/pr/${number}`;
  await git(['fetch', 'origin', `+refs/pull/${number}/head:${prRef}`], projectDir, FETCH_TIMEOUT_MS);
  const fetched = await oidOf(prRef);
  if (fetched !== headOid) {
    throw new Error(`origin's pull/${number} is ${fetched.slice(0, 8)}, not the PR's head ${headOid.slice(0, 8)}: this project is not a checkout of the PR's repository`);
  }

  const root = real(projectDir) ?? projectDir;
  const worktreePath = `${projectDir}/.worktrees/${worktreeName}`;
  // Forget worktrees whose directory is gone, so neither the list nor `worktree add` counts them.
  await git(['worktree', 'prune']).catch(() => undefined);
  const { stdout: list } = await git(['worktree', 'list', '--porcelain']);
  const holder = parseWorktreeList(list).find(w => w.branch === branch && !w.prunable && fs.existsSync(w.path));
  if (holder) {
    const at = real(holder.path) ?? holder.path;
    const tip = await oidOf('HEAD', holder.path);
    if (!await related(tip, holder.path)) throw new Error(`${branch} is checked out at ${holder.path} with work that is not this PR's`);
    if (at === real(worktreePath)) return { ok: true, path: worktreePath, existing: true };
    const prefix = `${root}/.worktrees/`;
    const rel = at.startsWith(prefix) ? at.slice(prefix.length) : null;
    if (rel && NAME.test(rel)) return { ok: true, path: holder.path, adopted: rel };
    throw new Error(`${branch} is already checked out at ${holder.path}`);
  }

  // The PR's own branch on origin, for its upstream; a fork's is not there.
  let upstream = false;
  if (sameRepo) {
    upstream = await git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], projectDir, FETCH_TIMEOUT_MS)
      .then(() => true, () => false);
  }

  const local = await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  let fastForwarded = false;
  if (local) {
    const tip = await oidOf(`refs/heads/${branch}`);
    if (tip !== headOid && !await within(headOid, tip)) {
      // Behind the PR: catch it up (nothing has it checked out, see above). Diverged or unrelated: leave it alone.
      if (!await within(tip, headOid)) {
        throw new Error(`a local branch ${branch} already exists with other work; rename or delete it, or attach the PR to its workstream instead`);
      }
      await git(['branch', '-f', branch, headOid]);
      fastForwarded = true;
    }
    await git(['worktree', 'add', worktreePath, branch], projectDir, CHECKOUT_TIMEOUT_MS);
  } else {
    await git(['worktree', 'add', '--no-track', '-b', branch, worktreePath, headOid], projectDir, CHECKOUT_TIMEOUT_MS);
  }
  if (upstream) await git(['branch', `--set-upstream-to=origin/${branch}`, branch], worktreePath).catch(() => undefined);
  return { ok: true, path: worktreePath, localBranch: local, fastForwarded, upstream };
}

module.exports = { CAPABILITIES, MAX_DURATION_MS, addPrWorktree, parseWorktreeList };
