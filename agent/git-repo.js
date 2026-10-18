// Initial-commit helper for project repos.
//
// A freshly `git init`-ed project repo has an unborn HEAD, and `git worktree
// add ... HEAD` refuses to resolve one ("invalid reference: HEAD"). Branching
// off a brand-new project therefore failed until somebody made a commit by
// hand. Creating the project's first commit at creation time removes that
// manual step.
//
// Mirror of backend/src/services/gitRepo.ts — the backend can't be imported
// here (the agent ships standalone, no build step), so the two must stay in
// sync by hand.

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

const INITIAL_COMMIT_MESSAGE = 'Initial commit';

// Seeded into every new project dir by init-wiki. Staged into the initial
// commit when they exist so the first commit carries the project's wiki files
// rather than being empty; an empty commit is still made when they don't.
const SEEDED_FILES = ['AGENTS.md', 'CLAUDE.md'];

// Used only when the host has no git identity configured (boxes get one from
// cloud-init). Without a fallback, `git commit` fails outright.
const FALLBACK_AUTHOR_NAME = 'termag';
const FALLBACK_AUTHOR_EMAIL = 'termag@localhost';

function shellEscape(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// True only when `dir` is itself the top level of a repo. A project dir nested
// inside an unrelated repo (someone cloned termag into ~/termag/) resolves to
// that outer repo, where committing would be actively wrong.
async function isRepoRoot(dir) {
  try {
    const { stdout } = await execAsync(`git -C ${shellEscape(dir)} rev-parse --show-toplevel`);
    const [realDir, realTop] = await Promise.all([
      fs.promises.realpath(dir),
      fs.promises.realpath(stdout.trim()),
    ]);
    return realDir === realTop;
  } catch {
    return false;
  }
}

async function hasGitIdentity(dir) {
  for (const key of ['user.name', 'user.email']) {
    try {
      const { stdout } = await execAsync(`git -C ${shellEscape(dir)} config --get ${key}`);
      if (!stdout.trim()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function hasCommits(dir) {
  try {
    await execAsync(`git -C ${shellEscape(dir)} rev-parse --verify HEAD`);
    return true;
  } catch {
    return false;
  }
}

// Make `dir` a git repo with at least one commit: `git init` unless it is
// already a repo root, then the initial commit. Idempotent.
//
// A project with no agent workflow never goes through tmux session creation,
// so this is the only thing that makes its dir a repo at all.
async function ensureProjectRepo(dir) {
  if (!(await isRepoRoot(dir))) {
    await execAsync(`git init ${shellEscape(dir)}`);
  }
  return ensureInitialCommit(dir);
}

// Give `dir` a first commit when it is a repo with an unborn HEAD. Returns
// 'skipped' when `dir` isn't a repo root, 'existing' when it already has
// commits, 'created' otherwise. Idempotent.
async function ensureInitialCommit(dir) {
  if (!(await isRepoRoot(dir))) return 'skipped';
  if (await hasCommits(dir)) return 'existing';
  // No check for a clone in flight here: git state can't tell one from an
  // abandoned clone (Start empty leaves `origin` and no commits). The callers
  // decide from the project's repoUrl and run this only when nothing is still
  // to be checked out; a local first commit would own the branch name the
  // pane checkout's `checkout --track` creates.
  const seeded = SEEDED_FILES.filter(f => fs.existsSync(path.join(dir, f)));
  if (seeded.length > 0) {
    // Best effort: a .gitignore that covers a seeded file makes `git add` fail,
    // which shouldn't stop the repo from getting its first commit.
    await execAsync(
      `git -C ${shellEscape(dir)} add -- ${seeded.map(shellEscape).join(' ')}`
    ).catch(() => {});
  }

  const identity = (await hasGitIdentity(dir))
    ? ''
    : ` -c user.name=${shellEscape(FALLBACK_AUTHOR_NAME)} -c user.email=${shellEscape(FALLBACK_AUTHOR_EMAIL)}`;

  // --allow-empty: the commit must happen even with nothing staged, since its
  // only job is to give HEAD something to point at.
  // --no-verify: a globally-installed pre-commit hook must not block it.
  await execAsync(
    `git -c commit.gpgsign=false${identity} -C ${shellEscape(dir)} ` +
    `commit --allow-empty --no-verify -m ${shellEscape(INITIAL_COMMIT_MESSAGE)}`
  );
  return 'created';
}

module.exports = {
  ensureProjectRepo,
  ensureInitialCommit,
  hasCommits,
  INITIAL_COMMIT_MESSAGE,
  SEEDED_FILES,
};
