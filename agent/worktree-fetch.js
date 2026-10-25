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

const CAPABILITIES = ['worktree-fetch-v1'];
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

module.exports = { CAPABILITIES, FETCH_TIMEOUT_MS, fetchOriginBranch, headSha, isFetchBranchName };
