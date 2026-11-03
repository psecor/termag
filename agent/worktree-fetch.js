'use strict';
/**
 * The fetch before `git-worktree-add`:
 * an automation run branches from the default branch as origin has it now,
 * not as the box last saw it. The orchestrator names the branch to fetch
 * (`fetch: '<branch>'`) and the base as `origin/<branch>`; this module
 * validates the name and runs the fetch as an argument list, never through
 * a shell. A fetch that fails (offline, a branch origin no longer has) is
 * reported, not fatal: `worktree add` then uses whatever `origin/<branch>`
 * the box already had, and the response says `fetched: false`.
 */

/**
 * A person can fetch too (the simple UI's New session, as a worktree of a
 * project already on the box): the orchestrator then sends `attended: true`,
 * and a tree started from the ref that fetch refreshed (startsFromFetch) is
 * left unmarked, as a fresh clone a person started is (and, from origin's
 * default branch, recorded as the project's own tree: git-worktree-own.js
 * fetchedDefault). A failed fetch, or a start the fetch did not refresh, is
 * marked as an automation run's is. A
 * fetch without it is an automation run's, made with nobody watching, and is
 * marked unattended (agent.js markUnattended), which keeps the chat runner
 * from ever loading that tree's startup config. The orchestrator asks for an
 * attended fetch only from a box that advertises this capability; an older
 * agent ignores the field and marks the tree, which is the safe side. The same
 * capability covers `readOnly` (marksOwn): a person's Read only pick, never
 * recorded as the project's own tree.
 */
const ATTENDED_CAPABILITY = 'worktree-fetch-attended-v1';
const CAPABILITIES = ['worktree-fetch-v1', ATTENDED_CAPABILITY];

/**
 * Whether a worktree add starts from the ref its own fetch just refreshed:
 * the fetch worked, and the start is origin/<that branch>, as New session
 * sends it (`fetch: <b>`, `baseRef: origin/<b>`). Only that start is the code
 * a person's Full access was for. A failed fetch leaves the box's older
 * origin/<b>, and any other start was not refreshed at all.
 */
function startsFromFetch(fetched, fetch, ref) {
  return fetched === true && isFetchBranchName(fetch)
    && (ref === `origin/${fetch}` || ref === `refs/remotes/origin/${fetch}`);
}

/**
 * Whether a worktree add marks its tree unattended: it fetched, and it is not
 * a person's start from the ref that fetch refreshed (`fresh`, startsFromFetch).
 */
function marksUnattended(fetched, attended, fresh) {
  return fetched !== null && fetched !== undefined && !(attended === true && fresh === true);
}

/**
 * Whether a worktree add may record its tree as the project's own (the
 * proof git-worktree-own.js writes, which a trusted turn needs for an open
 * mode). Not for a tree a person fetched on Read only (`readOnly`, New
 * session's permission pick, also part of worktree-fetch-attended-v1): left
 * unmarked, every turn there stays read-only (chat-runner.js turnModeFor),
 * even where origin/<default> is the main worktree's own branch.
 */
function marksOwn(readOnly) {
  return readOnly !== true;
}

/**
 * Clears a tree's own proof (`branch.<b>.termagCheckout`, git-worktree-own.js)
 * for a person's Read only pick: a path an earlier Full access create left
 * marked, then reused, would otherwise keep an open mode. Nothing to clear is
 * fine (git exits 5); any other failure throws, so the add fails rather than
 * leave the mark.
 */
async function clearOwn(execFile, worktreePath, branch) {
  try {
    await execFile('git', ['-C', worktreePath, 'config', '--local', '--unset-all', `branch.${branch}.termagCheckout`], { timeout: 5000 });
  } catch (err) {
    if (!err || err.code !== 5) throw err;
  }
}
// The fetch's share of the RPC: the orchestrator waits 90 s for a
// git-worktree-add that fetches (backend routes/workstreams.ts), and the
// add, the own-checkout marker and the HEAD read after it need their own
// time. A fetch that runs out of this is reported as not fetched, not fatal.
const FETCH_TIMEOUT_MS = 30_000;

/** A branch name safe to pass to `git fetch origin <name>`: no option, no refspec tricks, no control characters. */
function isFetchBranchName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && !name.startsWith('-') && !name.includes('..') && !name.includes(':') && !name.endsWith('/')
    && !/[\0-\x1f\x7f~^?*[\\\s]/.test(name);
}

/**
 * Fetch `branch` from origin into `repoPath`. Resolves to true when the
 * remote-tracking ref was updated (or already current), false when the fetch
 * failed for any reason; never throws.
 */
async function fetchOriginBranch(execFile, repoPath, branch, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!isFetchBranchName(branch)) return false;
  try {
    await execFile('git', ['-C', repoPath, 'fetch', '--no-tags', '--', 'origin', branch], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** The commit a worktree is on, or null. */
async function headSha(execFile, worktreePath) {
  try {
    const { stdout } = await execFile('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { timeout: 10_000 });
    const sha = String(stdout || '').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

module.exports = { ATTENDED_CAPABILITY, CAPABILITIES, FETCH_TIMEOUT_MS, fetchOriginBranch, headSha, isFetchBranchName, clearOwn, marksOwn, marksUnattended, startsFromFetch };
