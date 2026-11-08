'use strict';

// An environment pool box's prepare: before the box has an owner, clone
// each of the environment's repositories to the static layout (~/code/<name>) and run its `setup`, with no secrets and
// no owner credential. The orchestrator sends `environment-prepare` at the hello of an ownerless pool box (backend
// services/envPool.ts) and stops the box once setup has succeeded; a claim later starts it, and the project's clone
// adopts the checkout in place and pulls it as the owner (project-clone.js), and its environment-up adopts the chain's
// state, so setup reruns only when HEAD moved (environment-run.js).
//
// A refresh is the same RPC again on the started box, with a `prepareId`:
// each checkout is already there, so it is fetched and checked out at its default branch's head, and setup reruns on
// the prepared disk (incremental). The chain's state carries the prepareId into its
// environment-status frames, so the orchestrator stops the box only on this setup's success, not on the earlier
// prepare's state the forwarder re-sends at the hello.
//
// Git goes through the GitHub broker with the box's own token, as every box's does: this box has had no credential
// delivery, so the broker's rewrite is passed on the command line for these clones only. The broker answers with the
// pool credential while the box is `env-preparing`, and only for fetches of these repositories; the box never holds a
// GitHub token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { envKey } = require('./environment-file');
const { STATIC_ROOT, STATIC_NAME_RE } = require('./static-layout');

const CAPABILITIES = ['environment-prepare-v1'];
// The project id the pool's chain reports under (backend envPool.ts POOL_PROJECT_ID): no project is called this.
const POOL_PROJECT = 'pool';
const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const BROKER_RE = /^https:\/\/[A-Za-z0-9.-]+(?::443)?$/;
const PREPARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REPOS = 5;
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

function poolFile(home) { return path.join(home, '.termag', 'env-pool.json'); }

/** The pool box's marker, written once the clones are in place; null before. */
function readPool(home) {
  try {
    const p = JSON.parse(fs.readFileSync(poolFile(home), 'utf8'));
    return p && typeof p === 'object' && Array.isArray(p.repos) ? p : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The request, checked field by field: `{ request }` or `{ error }`. */
function acceptPrepare(msg) {
  if (!msg || typeof msg !== 'object') return { error: 'environment-prepare: empty request' };
  const { instanceId, environmentId } = msg;
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) return { error: 'environment-prepare: instanceId is required' };
  if (typeof environmentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(environmentId)) return { error: 'environment-prepare: environmentId is required' };
  if (!Array.isArray(msg.repos) || !msg.repos.length || msg.repos.length > MAX_REPOS) return { error: `environment-prepare: repos must name 1 to ${MAX_REPOS} repositories` };
  const repos = [];
  const names = new Set();
  for (const r of msg.repos) {
    if (!r || typeof r !== 'object' || typeof r.repo !== 'string' || !REPO_RE.test(r.repo)) return { error: 'environment-prepare: each repo is owner/name' };
    if (typeof r.url !== 'string' || !URL_RE.test(r.url)) return { error: `environment-prepare: ${r.repo}'s url must be https://github.com/owner/name` };
    if (typeof r.branch !== 'string' || !BRANCH_RE.test(r.branch) || r.branch.includes('..') || r.branch.startsWith('-')) return { error: `environment-prepare: ${r.repo}'s branch is not a branch name` };
    if (typeof r.name !== 'string' || !STATIC_NAME_RE.test(r.name) || names.has(r.name)) return { error: `environment-prepare: ${r.repo}'s name must be one directory, different from the others'` };
    names.add(r.name);
    repos.push({ repo: r.repo, url: r.url, branch: r.branch, name: r.name });
  }
  const fileText = typeof msg.fileText === 'string' ? msg.fileText : null;
  if (fileText === null) return { error: 'environment-prepare: fileText is required' };
  const filePath = typeof msg.filePath === 'string' && msg.filePath && !path.isAbsolute(msg.filePath) && !msg.filePath.split('/').some(p => p === '..' || p === '.' || p === '') ? msg.filePath : null;
  if (!filePath) return { error: 'environment-prepare: filePath must be a relative path' };
  const fileRepo = typeof msg.fileRepo === 'string' && REPO_RE.test(msg.fileRepo) ? msg.fileRepo : null;
  const broker = typeof msg.githubBroker === 'string' && BROKER_RE.test(msg.githubBroker) ? msg.githubBroker.replace(/:443$/, '') : null;
  if (msg.prepareId !== undefined && (typeof msg.prepareId !== 'string' || !PREPARE_ID_RE.test(msg.prepareId))) return { error: 'environment-prepare: prepareId is not an id' };
  const prepareId = typeof msg.prepareId === 'string' ? msg.prepareId : null;
  return { request: { instanceId, environmentId, repos, fileText, filePath, fileRepo, broker, prepareId } };
}

/**
 * Where the chain runs, the same path before and after claim, so its state key (and setup's absolute paths) carry
 * over: a single repository's checkout, ~/code/<name>, which the claimed project's directory links to; for several,
 * ~/code itself, which a claimed multi-repo project's root becomes a link to (workspace.js init-workspace
 * `staticRoot`), each repository at ~/code/<name>.
 */
function chainRoot(home, repos) {
  if (repos.length === 1) return path.join(home, STATIC_ROOT, repos[0].name);
  return path.join(home, STATIC_ROOT);
}

function gitArgs(request, home, configPath) {
  if (!request.broker) return [];
  const helper = path.join(__dirname, '..', 'deploy', 'termag-git-credential');
  return [
    '-c', `url.${request.broker}/.insteadOf=https://github.com/`,
    '-c', `credential.${request.broker}.helper=`,
    '-c', `credential.${request.broker}.helper=${helper} ${configPath || path.join(__dirname, 'agent.config.json')}`,
  ];
}

function run(execFileImpl, args, opts) {
  return new Promise((resolve) => {
    execFileImpl('git', args, { timeout: CLONE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String((stderr && String(stderr).trim().split('\n').pop()) || err.message) : null });
    });
  });
}

/** Clone (or, for a checkout already there from an earlier prepare, fetch) each repository at its default branch's head. */
async function cloneAll(request, home, deps) {
  const execFileImpl = deps.execFile || execFile;
  const pre = gitArgs(request, home, deps.configPath);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
  const out = [];
  for (const r of request.repos) {
    const dir = path.join(home, STATIC_ROOT, r.name);
    if (fs.existsSync(path.join(dir, '.git'))) {
      const fetched = await run(execFileImpl, [...pre, '-C', dir, 'fetch', '--quiet', 'origin', r.branch], { env });
      if (!fetched.ok) return { error: `fetch ${r.repo}: ${fetched.error}` };
      // --force: a tracked file setup changed (a version stamp, a lockfile) would otherwise refuse the new head when
      // upstream changed it too. Only setup's output is on this disk (handleEnvironmentPrepare refuses a claimed box),
      // setup reruns next and writes it again, and untracked output (caches, builds) is kept.
      const moved = await run(execFileImpl, ['-C', dir, 'checkout', '--quiet', '--force', '-B', r.branch, `origin/${r.branch}`], { env });
      if (!moved.ok) return { error: `check out ${r.repo} ${r.branch}: ${moved.error}` };
    } else {
      if (fs.existsSync(dir)) return { error: `${dir} already exists and is not a checkout, so ${r.repo} can't be cloned there` };
      // Into a temporary directory first, so an agent restart mid-clone never leaves a half checkout at the path.
      const tmp = `${dir}.prepare-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const cloned = await run(execFileImpl, [...pre, 'clone', '--quiet', '--branch', r.branch, r.url, tmp], { env });
      if (!cloned.ok) { fs.rmSync(tmp, { recursive: true, force: true }); return { error: `clone ${r.repo}: ${cloned.error}` }; }
      fs.renameSync(tmp, dir);
    }
    const head = await run(execFileImpl, ['-C', dir, 'rev-parse', 'HEAD'], { env });
    out.push({ repo: r.repo, name: r.name, branch: r.branch, dir, commit: head.ok ? head.stdout.trim() : null });
  }
  return { checkouts: out };
}

// A workspace root's marker (workspace.js MARKER): a ~/code holding it is one init-workspace may take as the claimed
// multi-repo project's root (staticRootChoice), where a ~/code with anything else in it is refused.
const WORKSPACE_MARKER = '.termag-workspace';

/** Marks ~/code as a multi-repo chain's root, as a claimed project's root would be. */
function markRoot(root) {
  const marker = path.join(root, WORKSPACE_MARKER);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'This directory is a termag workspace root, not a git repository.\n');
}

/** A failure before the chain: written to the chain's state file, so the forwarder reports it as setup failing. */
function failState(home, root, request, error, stateDir) {
  const key = envKey(root);
  writeJson(path.join(stateDir(home), `${key}.json`), {
    key, dir: root, projectId: POOL_PROJECT, instanceId: request.instanceId, state: 'failed', trigger: 'pool', pool: true,
    ...(request.prepareId ? { prepareId: request.prepareId } : {}),
    setup: { state: 'failed', finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) },
    run: { state: 'none' }, seed: { state: 'none' }, updatedAt: new Date().toISOString(),
  });
}

const inFlight = new Map();

/**
 * The agent's `environment-prepare` RPC: answers at once (`{ started }`, `{ running }` or `{ error }`); the chain's
 * state file says the rest, through the environment-status forwarder. Refused on a box with an owner: it would run
 * setup in somebody's checkouts.
 */
async function handleEnvironmentPrepare(msg, deps = {}) {
  if (deps.warm !== true) return { error: 'environment-prepare: not a pool box' };
  const accepted = acceptPrepare(msg);
  if (accepted.error) return { error: accepted.error };
  const request = accepted.request;
  const home = deps.home || os.homedir();
  const existing = readPool(home);
  if (existing && existing.adopted) return { error: 'environment-prepare: this box has been claimed' };
  if (existing && existing.environmentId !== request.environmentId) return { error: `environment-prepare: this box was prepared for ${existing.environmentId}` };
  if (inFlight.has(home)) return { running: true };
  const run = prepare(request, home, deps).finally(() => inFlight.delete(home));
  inFlight.set(home, run);
  if (deps.wait) await run;
  return { started: true };
}

async function prepare(request, home, deps) {
  const envRun = deps.environmentRun || require('./environment-run');
  const root = chainRoot(home, request.repos);
  try {
    const cloned = await cloneAll(request, home, deps);
    if (cloned.error) { failState(home, root, request, cloned.error, envRun.stateDir); return; }
    if (request.repos.length > 1) markRoot(root);
    writeJson(poolFile(home), {
      environmentId: request.environmentId, root, preparedAt: new Date().toISOString(), adopted: false,
      repos: cloned.checkouts.map(c => ({ repo: c.repo, name: c.name, dir: c.dir, branch: c.branch, commit: c.commit })),
    });
    const r = await envRun.startChain(root, {
      projectId: POOL_PROJECT, instanceId: request.instanceId, fileRepo: request.fileRepo, filePath: request.filePath,
      fileText: request.fileText, trigger: 'pool', only: 'setup', again: true,
      ...(request.prepareId ? { prepareId: request.prepareId } : {}),
    }, deps.chainDeps || {});
    if (r && r.error) failState(home, root, request, r.error, envRun.stateDir);
  } catch (err) {
    failState(home, root, request, err && err.message ? err.message : String(err), envRun.stateDir);
  }
}

/**
 * The prepared checkout at `dir`, if this box was prepared and no project has adopted that checkout yet: what
 * project-clone.js takes over in place, and pulls as the owner, instead of refusing a taken path.
 */
function preparedCheckout(home, dir) {
  const pool = readPool(home);
  if (!pool) return null;
  return pool.repos.find(r => r.dir === dir && !r.adopted) || null;
}

/**
 * Marks the checkout at `dir` as the owner's, pulled: no second project adopts it. Once one is, the box has been
 * claimed (`adopted`), and no prepare runs on it again. Whether it marked anything.
 */
function markAdopted(home, by, dir) {
  const pool = readPool(home);
  if (!pool) return false;
  const repo = pool.repos.find(r => r.dir === dir);
  if (!repo || repo.adopted) return false;
  const at = new Date().toISOString();
  writeJson(poolFile(home), {
    ...pool, adopted: true, adoptedAt: pool.adoptedAt || at,
    repos: pool.repos.map(r => (r === repo ? { ...r, adopted: true, adoptedBy: by, adoptedAt: at } : r)),
  });
  return true;
}

module.exports = {
  CAPABILITIES, POOL_PROJECT, handleEnvironmentPrepare, acceptPrepare, chainRoot, readPool, preparedCheckout, markAdopted, poolFile, gitArgs,
};
