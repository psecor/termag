'use strict';
/**
 * The `git-branch-state` RPC: where the
 * checkout in a workstream directory stands, read from local refs only. It
 * never fetches, so "ahead of base" is against the last-fetched origin base,
 * which is what the owner would see in `git status` too.
 *
 *   branch        current branch, null when detached or not a checkout
 *   upstream      its upstream ref (`origin/feat`), null when never pushed
 *   ahead/behind  relative to the upstream
 *   baseBranch    origin's default branch (`origin/HEAD`), else whichever of
 *                 `origin/main` / `origin/master` exists, else `main`
 *   aheadOfBase   commits on HEAD that origin/<baseBranch> lacks; null when
 *                 that cannot be counted (the backend shows such a branch)
 *   dirty         any tracked change or untracked file
 *   lastCommitAt  HEAD's committer time, ISO
 *   origin        `git remote get-url origin`
 */

/** Parse `git status --porcelain=v2 --branch`. */
function parseStatusV2(text) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: false };
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      out.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (!line.startsWith('#')) {
      out.dirty = true;
    }
  }
  return out;
}

/**
 * @param {string} cwd
 * @param {{ execFile: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string }> }} deps
 */
async function gitBranchState(cwd, deps) {
  // `status` gets 5 s (it walks the work tree); the ref reads are cheap and get
  // 2 s each, run together, so the whole answer stays inside the backend's
  // 10 s RPC timeout (backend/src/services/prBranches.ts).
  const git = async (args, timeout) => (await deps.execFile('git', ['-C', cwd, ...args], { timeout })).stdout;
  const quiet = (args) => git(args, 2000).then(s => s.trim(), () => null);

  // A directory that is not a checkout is the one error worth reporting.
  const [statusText, originHead, ct, origin] = await Promise.all([
    git(['status', '--porcelain=v2', '--branch'], 5000),
    quiet(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    quiet(['log', '-1', '--format=%ct']),
    quiet(['remote', 'get-url', 'origin']),
  ]);
  const status = parseStatusV2(statusText);
  // A clone made without `origin/HEAD` (an old `git clone`, a hand-added
  // remote) still has its default branch's ref under one of the usual names.
  let baseBranch = originHead && originHead.startsWith('origin/') ? originHead.slice('origin/'.length) : null;
  if (!baseBranch) {
    const [main, master] = await Promise.all([
      quiet(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']),
      quiet(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']),
    ]);
    baseBranch = main ? 'main' : master ? 'master' : 'main';
  }
  const count = await quiet(['rev-list', '--count', `origin/${baseBranch}..HEAD`]);

  return {
    ...status,
    baseBranch,
    aheadOfBase: count && /^\d+$/.test(count) ? Number(count) : null,
    lastCommitAt: ct && /^\d+$/.test(ct) ? new Date(Number(ct) * 1000).toISOString() : null,
    origin: origin || null,
  };
}

module.exports = { gitBranchState, parseStatusV2 };
