'use strict';
/**
 * Work on this box that exists nowhere else:
 * the orchestrator asks over the `unsaved-work` RPC just before it
 * hibernates an idle box, and a box with any finding, or a scan that failed,
 * waits the long limit (90 days) before an automatic terminate.
 *
 * Read-only. Walks the git repos under ~/termag/projects and ~/src (a repo,
 * its `.worktrees/*` and repos nested up to MAX_DEPTH below a root), plus every
 * worktree `git worktree list` names for those repos wherever it lives, and
 * counts per checkout: changed or untracked files (`git status --porcelain`),
 * commits on no remote (`git log HEAD --branches --not --remotes`, HEAD so a
 * detached checkout's commits count), and, once per repo, stashes. Checkouts
 * the Claude runner kept under ~/ccr/kept are counted as they are: it keeps
 * one only when its work is not on GitHub.
 */
const fs = require('fs');
const path = require('path');
const { countKept } = require('./host-sample');

const CAPABILITIES = ['unsaved-work-v1'];
const ROOTS = [['termag', 'projects'], ['src']];
const MAX_DEPTH = 3;
// Build output and caches, skipped only inside a repo: a project of its own
// may well be called `build` or `vendor`. node_modules is skipped everywhere.
const SKIP_IN_REPO = new Set(['.cache', 'vendor', 'bazel-out', 'dist', 'build']);
const SKIP = new Set(['node_modules', '.git']);
const GIT_TIMEOUT_MS = 30_000;

function countLines(text) {
  return (text || '').split('\n').filter(l => l.trim() !== '').length;
}

/** Git repos (directories holding `.git`, a dir or a worktree's file) under `root`, at most `depth` levels down. */
function findRepos(root, depth = MAX_DEPTH) {
  const repos = [];
  const walk = (dir, level, inRepo) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const isRepo = entries.some(e => e.name === '.git');
    if (isRepo) repos.push(dir);
    if (level >= depth) return;
    const inside = inRepo || isRepo;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP.has(e.name) || (inside && SKIP_IN_REPO.has(e.name))) continue;
      if (e.name.startsWith('.') && e.name !== '.worktrees') continue;
      walk(path.join(dir, e.name), level + 1, inside);
    }
  };
  walk(root, 0, false);
  return repos;
}

function gitIn(execFileAsync, dir) {
  return async (args) => (await execFileAsync('git', ['-C', dir, ...args], {
    timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })).stdout;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * The checked-out worktrees of the repo `dir` belongs to (`git worktree list`,
 * main first), skipping bare, prunable and missing ones. A linked worktree
 * can live anywhere, not just under the roots findRepos walks. Throws when
 * git can't list them.
 */
async function listWorktrees(execFileAsync, dir) {
  const out = await gitIn(execFileAsync, dir)(['worktree', 'list', '--porcelain']);
  return out.split('\n\n').map(block => block.split('\n')).filter(lines =>
    lines[0].startsWith('worktree ') && !lines.some(l => l === 'bare' || l.startsWith('prunable')),
  ).map(lines => lines[0].slice('worktree '.length)).filter(p => !isMissing(p)).map(p => realpath(p) || p);
}

function isMissing(p) {
  try { fs.lstatSync(p); return false; } catch (err) { return err.code === 'ENOENT'; }
}

function errorText(err) {
  return `${err.stderr || err.message || err}`.trim().split('\n')[0].slice(0, 200);
}

/**
 * One checkout's counts, or throws when git can't read it. Stashes belong to
 * the repo, not the worktree, so a caller scanning several worktrees of one
 * repo passes `countStashes` for only one of them.
 */
async function scanRepo(execFileAsync, dir, { countStashes = true } = {}) {
  const git = gitIn(execFileAsync, dir);
  // An unborn HEAD (git init, no commit yet) is not an error: there is
  // nothing on it to lose, and `git log HEAD` would fail.
  const hasHead = await git(['rev-parse', '-q', '--verify', 'HEAD']).then(() => true, () => false);
  const [status, unpushed, stashes] = await Promise.all([
    // Flags, not defaults: the owner's or the repo's config can set
    // status.showUntrackedFiles=no or submodule ignores, hiding work.
    git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']),
    git(['log', ...(hasHead ? ['HEAD'] : []), '--branches', '--not', '--remotes', '--oneline']),
    countStashes ? git(['stash', 'list']) : '',
  ]);
  return { path: dir, dirty: countLines(status), unpushed: countLines(unpushed), stashes: countLines(stashes) };
}

/**
 * Scan this home. `repos` lists only repos with a finding; `errors` the ones
 * git could not read. The orchestrator treats either, and any kept checkout,
 * as unsaved work.
 */
async function scanUnsavedWork(execFileAsync, home) {
  const seen = new Set();
  const checkouts = [];
  const add = (dir, repo, error) => {
    const real = realpath(dir) || dir;
    if (!seen.has(real)) { seen.add(real); checkouts.push({ dir, repo, error }); }
  };
  for (const parts of ROOTS) {
    for (const dir of findRepos(path.join(home, ...parts))) {
      if (seen.has(realpath(dir) || dir)) continue;
      let worktrees;
      try {
        worktrees = await listWorktrees(execFileAsync, dir);
      } catch (err) {
        // Its other worktrees are unknown, so the repo is an error even if this checkout is clean.
        add(dir, dir, errorText(err));
        continue;
      }
      const repo = worktrees[0] || realpath(dir) || dir;
      add(dir, repo);
      for (const wt of worktrees) add(wt, repo);
    }
  }
  const repos = [];
  const errors = [];
  const stashesCounted = new Set();
  for (const { dir, repo, error } of checkouts) {
    if (error) { errors.push({ path: dir, error }); continue; }
    try {
      const r = await scanRepo(execFileAsync, dir, { countStashes: !stashesCounted.has(repo) });
      stashesCounted.add(repo);
      if (r.dirty || r.unpushed || r.stashes) repos.push(r);
    } catch (err) {
      errors.push({ path: dir, error: errorText(err) });
    }
  }
  return { scanned: checkouts.length, repos, errors, keptCheckouts: countKept(home) };
}

module.exports = { CAPABILITIES, countLines, findRepos, listWorktrees, scanRepo, scanUnsavedWork };
