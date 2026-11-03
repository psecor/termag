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
 *                 that cannot be counted (the backend shows such a branch).
 *                 With no origin remote (a local-only project) it is counted
 *                 locally instead, against `opts.base`, the commit a spawned
 *                 checkout was made from; never against a local branch, which
 *                 the checkout's own work may be on (null without a base)
 *   baseLocal     'spawn-base' when counted that way; absent otherwise
 *   dirty         any tracked change or untracked file
 *   head          HEAD's commit, null before the first commit
 *   changed       how many tracked files have changes (staged or not)
 *   untracked     how many untracked files (counts only, never names)
 *   lastCommitAt  HEAD's committer time, ISO
 *   origin        `git remote get-url origin`
 */

const fs = require('fs');

// Every git here only reads, so it takes no optional locks: a `status` that
// refreshes the index would otherwise hold index.lock while another git writes
// the checkout (the webapp sync's box half, an agent's own commit) and make
// that one fail. unsaved-work.js does the same.
const gitOpts = (timeout) => ({ timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

/** Parse `git status --porcelain=v2 --branch`. */
function parseStatusV2(text) {
  // abKnown: git printed an ahead/behind line. It does not when the upstream's
  // remote-tracking ref is gone, so ahead/behind 0 would otherwise look pushed.
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, abKnown: false, dirty: false, head: null, changed: 0, untracked: 0 };
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      out.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      out.head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); out.abKnown = true; }
    } else if (!line.startsWith('#')) {
      out.dirty = true;
      if (line.startsWith('? ')) out.untracked += 1;
      else if (!line.startsWith('! ')) out.changed += 1;
    }
  }
  return out;
}

/**
 * @param {string} cwd
 * @param {{ execFile: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string }> }} deps
 */
/**
 * Does origin really hold HEAD? Asked of the remote itself (`git ls-remote`),
 * not of the local remote-tracking ref, which can be stale or gone: the spawn
 * lifecycle retires a checkout on this answer.
 * true: the remote branch is HEAD or contains it. false: the remote has no
 * such branch, or it does not contain HEAD. null: it could not be told
 * (no upstream, the remote unreachable, the remote's commit not here).
 */
async function remoteContainsHead(cwd, upstream, deps) {
  if (!upstream || !upstream.includes('/')) return null;
  const slash = upstream.indexOf('/');
  const remote = upstream.slice(0, slash), branch = upstream.slice(slash + 1);
  const run = (args, timeout) => deps.execFile('git', ['-C', cwd, ...args], gitOpts(timeout));
  let line;
  try {
    line = (await run(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], 6000)).stdout.trim();
  } catch (err) {
    // --exit-code: 2 = the remote answered and has no such ref.
    return err && err.code === 2 ? false : null;
  }
  const sha = line.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  try {
    const head = (await run(['rev-parse', 'HEAD'], 2000)).stdout.trim();
    if (head === sha) return true;
    await run(['merge-base', '--is-ancestor', 'HEAD', sha], 2000);
    return true;
  } catch (err) {
    // is-ancestor exits 1 for "not an ancestor"; anything else (the remote's
    // commit is not in this clone) cannot be told.
    return err && err.code === 1 ? false : null;
  }
}

async function gitBranchState(cwd, deps, opts = {}) {
  // `status` gets 5 s (it walks the work tree); the ref reads are cheap and get
  // 2 s each, run together, so the whole answer stays inside the backend's
  // 10 s RPC timeout (backend/src/services/prBranches.ts).
  const git = async (args, timeout) => (await deps.execFile('git', ['-C', cwd, ...args], gitOpts(timeout))).stdout;
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
  let count = await quiet(['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
  // A project with no remote at all: count locally, against the commit it was
  // spawned from, and only that. A local branch is no base: the checkout's own
  // work may be on it (a new project's main, a sibling master), so counting
  // against one could call that work empty and retire it. Without a base it
  // stays uncountable, and kept. (A repo with an origin but no ref for its
  // base stays uncountable too: that is a different case.)
  let baseLocal;
  if (count === null && !origin) {
    const base = typeof opts.base === 'string' && /^[0-9a-f]{7,40}$/.test(opts.base) ? opts.base : null;
    if (base && await quiet(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) {
      count = await quiet(['rev-list', '--count', `${base}..HEAD`]);
      if (count !== null) baseLocal = 'spawn-base';
    }
  }

  return {
    ...status,
    ...(opts.verifyRemote ? { remoteContainsHead: await remoteContainsHead(cwd, status.upstream, deps) } : {}),
    baseBranch,
    aheadOfBase: count && /^\d+$/.test(count) ? Number(count) : null,
    ...(baseLocal ? { baseLocal } : {}),
    lastCommitAt: ct && /^\d+$/.test(ct) ? new Date(Number(ct) * 1000).toISOString() : null,
    origin: origin || null,
  };
}

/** At most this many worktrees are reported for one checkout. */
const MAX_WORKTREES = 50;

/**
 * Parse `git worktree list --porcelain`: one block per worktree, its path,
 * HEAD and branch (null when detached). A bare or prunable entry is skipped:
 * neither has a checkout to show.
 */
function parseWorktreeList(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    let wtPath = null, head = null, branch = null, skip = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'bare' || line.startsWith('prunable')) skip = true;
    }
    if (wtPath && !skip) out.push({ path: wtPath, head: /^[0-9a-f]{40,64}$/.test(head || '') ? head : null, branch: branch || null });
  }
  return out;
}

/**
 * The light form of `git-branch-state` (4d): which
 * repository and branch a directory holds, without `git status`, so the
 * backend can ask about several directories at once to find a PR's checkout.
 *
 *   light      true, so the backend can tell this answer from an older agent's
 *   dir        the directory asked about, symlinks resolved
 *   toplevel   its checkout's top level, symlinks resolved: a directory inside
 *              a checkout reports the enclosing one, so the backend can tell
 *              the two apart
 *   branch     current branch, null when detached
 *   head       HEAD's commit, null before the first commit
 *   origin     `git remote get-url origin`, null when there is none
 *   worktrees  with `opts.worktrees`: the checkout's worktrees as
 *              `{ path, branch, head }`, paths resolved, at most 50
 *
 * A directory that is not a checkout is an error, as for the full form.
 */
async function gitCheckoutFacts(cwd, deps, opts = {}) {
  const git = async (args, timeout) => (await deps.execFile('git', ['-C', cwd, ...args], gitOpts(timeout))).stdout;
  const quiet = (args, timeout = 2000) => git(args, timeout).then(s => s.trim(), () => null);
  const resolve = deps.realpath || ((p) => fs.promises.realpath(p));
  const real = (p) => resolve(p).catch(() => null);

  const toplevelRaw = (await git(['rev-parse', '--show-toplevel'], 2000)).trim();
  const [branch, head, origin, worktreeText, dir, toplevel] = await Promise.all([
    quiet(['symbolic-ref', '--short', '-q', 'HEAD']),
    quiet(['rev-parse', '--verify', '-q', 'HEAD']),
    quiet(['remote', 'get-url', 'origin']),
    opts.worktrees ? quiet(['worktree', 'list', '--porcelain'], 3000) : Promise.resolve(null),
    real(cwd),
    real(toplevelRaw),
  ]);
  const out = {
    light: true,
    dir,
    toplevel,
    branch: branch || null,
    head: head && /^[0-9a-f]{40,64}$/.test(head) ? head : null,
    origin: origin || null,
  };
  if (opts.worktrees) {
    const listed = parseWorktreeList(worktreeText).slice(0, MAX_WORKTREES);
    const resolved = await Promise.all(listed.map(async (w) => ({ ...w, path: await real(w.path) })));
    out.worktrees = resolved.filter(w => w.path);
  }
  return out;
}

module.exports = { gitBranchState, gitCheckoutFacts, parseStatusV2, parseWorktreeList };
