'use strict';
/**
 * The `git-changes` RPC: the files a checkout has changed that its upstream does not have
 * yet, for the simple UI's context card, which shows them beside its pull
 * request's. Read-only and local: it never fetches, takes no optional locks,
 * and reports names and line counts, never contents.
 *
 * With `opts.branch` (the session's pull request's head), a checkout that is
 * not on that branch reads the repository's worktree that is instead (an agent
 * often works in a `.worktrees/<topic>` of its own); none on it, `cwd` itself.
 *
 *   toplevel     the checkout read: its top level, as git prints it
 *   worktree     true when that is a worktree on `opts.branch` rather than `cwd`
 *   branch       current branch, null when detached
 *   head         HEAD's commit, null before the first commit
 *   upstream     the branch's upstream (`origin/feat`), null when never pushed
 *   against      what `committed` counts from: the upstream when there is one,
 *                else origin's default branch (`origin/main`, through the merge
 *                base), else null, and `committed` is empty
 *   commits      commits on HEAD that `against` lacks
 *   committed    the files those commits change (`against...HEAD`)
 *   uncommitted  the files changed in the work tree or the index against HEAD,
 *                and untracked files
 *   truncated    a list was cut at MAX_FILES
 *   partial      the committed files could not be read (a git call failed, or
 *                the time ran out first): `committed` is then empty, while
 *                `commits` may not be
 *
 * The whole answer has DEADLINE_MS, inside the backend's 10 s RPC timeout:
 * every git call gets what is left of it (at most its own cap), an untracked
 * file's lines are counted only while a second is left, and the committed
 * files are read only while half a second is.
 * A file is { path, from?, status, additions, deletions }: status is git's
 * letter (A, M, D, R, C, T) or `?` for an untracked file, `from` a rename's
 * old path, and the line counts are null for a binary file. An untracked
 * file's lines are counted only for a regular file up to MAX_COUNT_BYTES.
 * A directory that is not a checkout is an error, as for git-branch-state.
 */

const fs = require('fs');
const path = require('path');
const { parseWorktreeList } = require('./git-branch-state');

const CAPABILITIES = ['git-changes-v1'];
/** Files reported per list, at most. */
const MAX_FILES = 200;
/** An untracked file larger than this is listed without its lines. */
const MAX_COUNT_BYTES = 1024 * 1024;
/** The whole answer's time, under the backend's 10 s RPC timeout (routes/workstreamChanges.ts) with room to reply. */
const DEADLINE_MS = 8000;

// As git-branch-state.js: reads only, so no optional locks (a `status` that
// refreshes the index would hold index.lock while the agent's own git writes).
const gitOpts = (timeout) => ({ timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

/**
 * Join `git diff -z --numstat -M` and `git diff -z --name-status -M` for the
 * same range into files, in name-status order. numstat's `-\t-` is a binary
 * file (null counts).
 */
function parseDiff(numstatText, nameStatusText) {
  const counts = new Map();
  const ns = String(numstatText || '').split('\0');
  for (let i = 0; i < ns.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(ns[i]);
    if (!m) continue;
    let p = m[3];
    // A rename's entry has an empty path, then its old and new paths.
    if (p === '') { p = ns[i + 2] ?? ''; i += 2; }
    counts.set(p, { additions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]) });
  }
  const files = [];
  const st = String(nameStatusText || '').split('\0');
  for (let i = 0; i < st.length; i++) {
    const code = st[i];
    if (!/^[ACDMRTUX]\d*$/.test(code)) continue;
    const letter = code[0];
    let from;
    let p = st[i + 1];
    if (letter === 'R' || letter === 'C') { from = p; p = st[i + 2]; i += 2; } else { i += 1; }
    if (!p) continue;
    const c = counts.get(p) ?? { additions: null, deletions: null };
    files.push({ path: p, ...(from ? { from } : {}), status: letter, ...c });
  }
  return files;
}

/** Lines in a text: a last line without a newline counts; a NUL in it means binary (null). */
function countLines(buf) {
  if (buf.includes(0)) return null;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** An untracked file's lines: only a regular file (never through a symlink) under the top level, up to MAX_COUNT_BYTES. */
async function untrackedLines(toplevel, rel, deps) {
  const full = path.join(toplevel, rel);
  if (!full.startsWith(toplevel + path.sep)) return null;
  try {
    const st = await (deps.lstat || fs.promises.lstat)(full);
    if (!st.isFile() || st.size > MAX_COUNT_BYTES) return null;
    return countLines(await (deps.readFile || fs.promises.readFile)(full));
  } catch {
    return null;
  }
}

/** origin's default branch, as git-branch-state.js finds it, or null when origin has none of the usual refs. */
async function originBase(quiet) {
  const head = await quiet(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head && head.startsWith('origin/')) return head;
  const [main, master] = await Promise.all([
    quiet(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']),
    quiet(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']),
  ]);
  return main ? 'origin/main' : master ? 'origin/master' : null;
}

function cap(files) {
  return { files: files.slice(0, MAX_FILES), cut: files.length > MAX_FILES };
}

/** A branch name as git allows one, short enough to pass on: anything else is ignored. */
function branchArg(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\0\s~^:?*[\\]|\.\.|@\{/.test(v) && !v.startsWith('-') ? v : null;
}

/** git in `dir`, each call given what is left of the answer's time, at most `cap`. */
function gitIn(dir, deps, left) {
  const git = async (args, cap = 5000) => {
    const timeout = Math.min(cap, left());
    if (timeout < 50) throw new Error('git-changes: out of time');
    return (await deps.execFile('git', ['-C', dir, ...args], gitOpts(timeout))).stdout;
  };
  const quiet = (args, cap = 2000) => git(args, cap).then(s => s.trim(), () => null);
  return { git, quiet };
}

/** `cwd`, or the worktree of its repository that has `branch` checked out when `cwd` doesn't. */
async function pickCheckout(cwd, branch, deps, left) {
  if (!branch) return { dir: cwd, worktree: false };
  const { quiet } = gitIn(cwd, deps, left);
  if (await quiet(['symbolic-ref', '--short', '-q', 'HEAD']) === branch) return { dir: cwd, worktree: false };
  const on = parseWorktreeList(await quiet(['worktree', 'list', '--porcelain'], 3000)).find(w => w.branch === branch);
  return on ? { dir: on.path, worktree: true } : { dir: cwd, worktree: false };
}

async function gitChanges(cwdAsked, deps, opts = {}) {
  const now = deps.now || Date.now;
  const end = now() + DEADLINE_MS;
  const left = () => end - now();
  const picked = await pickCheckout(cwdAsked, branchArg(opts.branch), deps, left);
  const cwd = picked.dir;
  const { git, quiet } = gitIn(cwd, deps, left);

  // A directory that is not a checkout is the one error worth reporting.
  const toplevel = (await git(['rev-parse', '--show-toplevel'], 2000)).trim();
  const [branch, headRaw, upstreamRaw] = await Promise.all([
    quiet(['symbolic-ref', '--short', '-q', 'HEAD']),
    quiet(['rev-parse', '--verify', '-q', 'HEAD']),
    // Null when never pushed, or when the upstream's remote-tracking ref is gone.
    quiet(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ]);
  const head = headRaw && /^[0-9a-f]{40,64}$/.test(headRaw) ? headRaw : null;
  const upstream = upstreamRaw || null;
  const base = upstream ? null : await originBase(quiet);

  // Uncommitted: the index and the work tree against HEAD (against the empty
  // tree before the first commit, which `--cached` does), and untracked files.
  const range = head ? ['HEAD'] : ['--cached'];
  const [numstat, nameStatus, others] = await Promise.all([
    git(['diff', '-z', '--numstat', '-M', ...range]),
    git(['diff', '-z', '--name-status', '-M', ...range]),
    git(['-C', toplevel, 'ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  const tracked = parseDiff(numstat, nameStatus);
  const untrackedPaths = String(others).split('\0').filter(Boolean);
  // Their lines only while a second is left: past that, they're listed without.
  const untracked = await Promise.all(untrackedPaths.slice(0, MAX_FILES).map(async (p) => {
    const lines = left() > 1000 ? await untrackedLines(toplevel, p, deps) : null;
    return { path: p, status: '?', additions: lines, deletions: lines === null ? null : 0 };
  }));
  const uncommitted = cap([...tracked, ...untracked]);

  // Committed but not upstream: against the upstream, or, never pushed, against
  // origin's default branch through the merge base (three dots).
  // A diff that fails or a budget spent says partial, never "no files".
  const against = head ? (upstream || base) : null;
  let committed = { files: [], cut: false };
  let commits = 0;
  let partial = false;
  if (against && left() > 500) {
    const [n, diffs] = await Promise.all([
      quiet(['rev-list', '--count', `${against}..HEAD`]),
      Promise.all([
        git(['diff', '-z', '--numstat', '-M', `${against}...HEAD`]),
        git(['diff', '-z', '--name-status', '-M', `${against}...HEAD`]),
      ]).catch(() => null),
    ]);
    commits = n && /^\d+$/.test(n) ? Number(n) : 0;
    if (diffs) committed = cap(parseDiff(diffs[0], diffs[1]));
    else partial = true;
  } else if (against) {
    partial = true;
  }

  return {
    toplevel,
    worktree: picked.worktree,
    branch: branch || null,
    head,
    upstream,
    against,
    commits,
    committed: committed.files,
    uncommitted: uncommitted.files,
    truncated: committed.cut || uncommitted.cut || untrackedPaths.length > MAX_FILES,
    partial,
  };
}

module.exports = { CAPABILITIES, DEADLINE_MS, MAX_FILES, branchArg, gitChanges, parseDiff, countLines };
