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
// Git goes through the GitHub broker with the box's own token, as every box's does. This box has had no credential
// delivery, so the prepare writes the broker's git config itself: termag-credentials' own github block (the URL
// rewrite, mirroring any longer insteadOf the baked ~/.gitconfig has, and the credential helper that hands git the box
// token). It holds no GitHub token: the broker swaps the pool credential in, while the box is `env-preparing` and only
// for fetches of these repositories. Being the box's git config, it reaches the git `setup` itself runs too. The
// claim removes it (dropPoolGitConfig, from agent.js's box-claim) before the owner's delivery writes theirs.

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

/** Who the pool git config says applied it, for termag-credentials status (it carries no credential). */
const POOL_GIT_LOGIN = 'environment-pool';

/** Writes the broker's git config for the pool's git, and setup's (termag-credentials apply github). Throws on failure. */
async function writePoolGitConfig(request, deps) {
  // Only the agent's own credentials module (agent.js passes it): never a default, so no caller (a test) can rewrite
  // the git config of the machine it runs on by leaving it out.
  const credentials = deps.credentials;
  if (!credentials) throw new Error('no credentials module to write it with');
  await credentials.applyCredential('github', { broker: request.broker, login: POOL_GIT_LOGIN, updatedAt: new Date().toISOString() });
}

/**
 * At claim, before the owner's credential delivery: removes the pool git config, so the box's git is the owner's from
 * here on (their delivery writes the broker block back under their name). Once; false when there was none.
 */
async function dropPoolGitConfig(home, deps = {}) {
  const pool = readPool(home);
  if (!pool || pool.poolGitConfig !== true) return false;
  const credentials = deps.credentials;
  if (!credentials) throw new Error('no credentials module to remove it with');
  await credentials.removeCredential('github', undefined, "the pool box was claimed: its owner's delivery comes next");
  writeJson(poolFile(home), { ...pool, poolGitConfig: false });
  return true;
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
  const out = [];
  for (const r of request.repos) {
    const dir = path.join(home, STATIC_ROOT, r.name);
    if (fs.existsSync(path.join(dir, '.git'))) {
      const fetched = await run(execFileImpl, ['-C', dir, 'fetch', '--quiet', 'origin', r.branch], { env });
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
      const cloned = await run(execFileImpl, ['clone', '--quiet', '--branch', r.branch, r.url, tmp], { env });
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
function failState(home, root, request, error, stateDir, onWarm = null) {
  const key = envKey(root);
  writeJson(path.join(stateDir(home), `${key}.json`), {
    key, dir: root, projectId: POOL_PROJECT, instanceId: request.instanceId, state: 'failed', trigger: 'pool', pool: true,
    ...(request.prepareId ? { prepareId: request.prepareId } : {}),
    // This prepare's own on-warm outcome, when it has one, for the orchestrator's environment.setup event.
    ...(onWarm ? { poolOnWarm: onWarm } : {}),
    setup: { state: 'failed', finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) },
    run: { state: 'none' }, seed: { state: 'none' }, updatedAt: new Date().toISOString(),
  });
}

// ── The warm pool's on-warm hook, on a pool box ─────────────────────────────
// What a warm box runs before claim (deploy/termag-hook-run warm: the deploy/on-warm.d
// scripts) runs on a pool box during its prepare too, so a claimed pool box has what a claimed warm box has. It needs
// no credential: no GitHub, no owner, ECR only through the box role. Its outcome never fails the prepare: a box with
// the environment's setup done and a toolchain warning is worth more than no box, and the owner's own setup finishes
// what is left.

const ON_WARM_UNIT = 'termag-on-warm.service';
// Inside the orchestrator's prepare timeout (ENV_POOL_PREPARE_TIMEOUT_MINUTES, 45), so a hung run still lets setup go.
const ON_WARM_WAIT_MS = 30 * 60 * 1000;
/** How long a stop of the timed-out on-warm unit may take: the runner passes the signal on and waits for its script. */
const ON_WARM_STOP_MS = 120_000;
const SETTLED = new Set(['succeeded', 'failed']);

function onWarmFile(home) { return path.join(home, '.termag', 'on-warm.status.json'); }

/** The on-warm run's status file (deploy/termag-hook-run), with its mtime; null when absent or unreadable. */
function readOnWarm(home) {
  try {
    const file = onWarmFile(home);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? { ...s, mtimeMs: fs.statSync(file).mtimeMs } : null;
  } catch {
    return null;
  }
}

/** A status file's scripts' total time, in seconds. */
function secondsOf(status) {
  return Array.isArray(status.durations) ? status.durations.reduce((t, d) => t + (Number.isFinite(d && d.seconds) ? d.seconds : 0), 0) : 0;
}

function systemctlStart(execFileImpl) {
  return (args, opts = {}) => new Promise((resolve) => {
    execFileImpl('systemctl', args, { timeout: opts.timeoutMs || 15_000 }, (err, _out, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message).trim().split('\n').pop() } : { ok: true }));
  });
}

/**
 * Starts the on-warm run (as the backend's on-warm-start does for a warm box) and resolves with how it ended:
 * `{ state, seconds }`, `state` `succeeded`, `failed` or `skipped` (a refresh, on a box where it already succeeded:
 * the toolchain is on the disk). Never throws.
 */
async function runOnWarm(home, request, deps) {
  const before = readOnWarm(home);
  // Succeeded on this box already: its work is on the disk, and the unit (RemainAfterExit) would not run again, so the
  // file would never change. A refresh says it skipped it; a first prepare the orchestrator re-sent at a reconnect
  // reports the run it already had.
  if (before && before.state === 'succeeded') {
    // Forwarded all the same: the socket this prepare came on (a reconnect, a restarted agent) may never have had it.
    if (deps.onWarmStarted) deps.onWarmStarted();
    return request.prepareId ? { state: 'skipped', seconds: 0 } : { state: 'succeeded', seconds: secondsOf(before) };
  }
  const startedAt = Date.now();
  // This run is `running` from here, before the unit's runner writes anything: `--no-block` returns first, and an
  // earlier run's terminal file (a failure a refresh retries) would otherwise be the first thing the agent forwards,
  // and the forwarder stops at a terminal state.
  try {
    writeJson(onWarmFile(home), { schema: 1, state: 'running', script: null, durations: [], logTail: '' });
  } catch { /* the runner writes its own as it starts */ }
  // Only the systemctl agent.js passes: never a default, so a caller that leaves it out (a test) can't start the
  // on-warm unit of the machine it runs on.
  const started = deps.systemctl
    ? await deps.systemctl(['--user', 'start', '--no-block', ON_WARM_UNIT])
    : { ok: false, error: 'no systemctl to start it with' };
  if (!started.ok) {
    const error = `could not start ${ON_WARM_UNIT}: ${started.error}`;
    // Nothing runs to write the status file, so it says so itself, in termag-hook-run's shape, and the agent forwards it
    // as it would the run's: the orchestrator shows it on the pool page.
    try {
      writeJson(onWarmFile(home), { schema: 1, state: 'failed', script: null, exitCode: null, reason: 'not-started', durations: [], logTail: error, finishedAt: new Date().toISOString() });
      if (deps.onWarmStarted) deps.onWarmStarted();
    } catch { /* the pool page then has nothing; the prepare goes on */ }
    return { state: 'failed', seconds: 0, error };
  }
  if (deps.onWarmStarted) deps.onWarmStarted();
  const pollMs = deps.onWarmPollMs || 2000;
  const deadline = startedAt + (deps.onWarmWaitMs || ON_WARM_WAIT_MS);
  while (Date.now() < deadline) {
    const now = readOnWarm(home);
    // This run's result only: a file from before the start (the last boot's run) is not it.
    if (now && SETTLED.has(now.state) && now.mtimeMs >= startedAt - 1000 && !(before && now.mtimeMs === before.mtimeMs)) {
      return { state: now.state, seconds: secondsOf(now) };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  // Past the wait: the unit is stopped, so it doesn't run on beside setup. A blocking stop, given the time the runner's
  // own signal handling may take; one that still doesn't confirm fails the prepare (`fatal`), since setup must not run
  // beside it.
  const error = `${ON_WARM_UNIT} did not finish in ${Math.round((deps.onWarmWaitMs || ON_WARM_WAIT_MS) / 60000)} min`;
  const stopped = await deps.systemctl(['--user', 'stop', ON_WARM_UNIT], { timeoutMs: ON_WARM_STOP_MS });
  const last = readOnWarm(home);
  // It settled meanwhile (in the last poll, or as the stop came): that is this run's result, not a timeout.
  if (last && SETTLED.has(last.state) && last.mtimeMs >= startedAt - 1000 && !(before && last.mtimeMs === before.mtimeMs)) {
    return { state: last.state, seconds: secondsOf(last) };
  }
  // The status file says so, as the runner's own timeout would, for the agent to forward (prepare's onWarmSettled) and
  // the pool page to show.
  try {
    writeJson(onWarmFile(home), {
      schema: 1, state: 'failed', script: last && typeof last.script === 'string' ? last.script : null, exitCode: null, reason: 'timeout',
      durations: last && Array.isArray(last.durations) ? last.durations : [],
      logTail: stopped.ok ? `${error}; stopped` : `${error}; stopping it failed: ${stopped.error}`, finishedAt: new Date().toISOString(),
    });
  } catch { /* the pool page then shows it unfinished */ }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (!stopped.ok) return { state: 'failed', seconds, error: `${error}, and it could not be stopped: ${stopped.error}`, fatal: true };
  return { state: 'failed', seconds, error };
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
  const running = inFlight.get(home);
  if (running) {
    // A re-send comes on a new socket (a reconnect), and the agent stopped the old socket's on-warm poller: the run's
    // status goes on the new one from here, at once if the run has started.
    running.onWarmStarted = deps.onWarmStarted || null;
    if (running.warmStarted && running.onWarmStarted) running.onWarmStarted();
    return { running: true };
  }
  const entry = { onWarmStarted: deps.onWarmStarted || null, warmStarted: false, run: null };
  const onWarmStarted = () => { entry.warmStarted = true; if (entry.onWarmStarted) entry.onWarmStarted(); };
  entry.run = prepare(request, home, { ...deps, onWarmStarted }).finally(() => inFlight.delete(home));
  inFlight.set(home, entry);
  if (deps.wait) await entry.run;
  return { started: true };
}

async function prepare(request, home, deps) {
  const envRun = deps.environmentRun || require('./environment-run');
  const root = chainRoot(home, request.repos);
  try {
    // The broker's git config first: the clones and setup's own git go through it.
    if (request.broker) {
      try {
        await writePoolGitConfig(request, deps);
      } catch (err) {
        failState(home, root, request, `pool git config: ${err && err.message ? err.message : String(err)}`, envRun.stateDir);
        return;
      }
    }
    // The on-warm run alongside the clones, and finished before setup, which may rely on the toolchain it installs.
    const warmRun = runOnWarm(home, request, deps);
    const cloned = await cloneAll(request, home, deps);
    // A failed clone fails the prepare now, not after the on-warm run (up to ON_WARM_WAIT_MS): the orchestrator then
    // terminates the box and frees its in-flight slot. The run is left to finish on a box that is going away.
    if (cloned.error) { failState(home, root, request, cloned.error, envRun.stateDir); return; }
    const warm = await warmRun;
    if (warm.fatal) {
      // Its timeout status goes out first, then the failure: the orchestrator drops the box's socket at the failure.
      if (deps.onWarmSettled) deps.onWarmSettled();
      failState(home, root, request, `on-warm: ${warm.error}`, envRun.stateDir, { state: warm.state, seconds: warm.seconds });
      return;
    }
    if (warm.error) console.warn(`[ENV-POOL] on-warm: ${warm.error}; the prepare goes on`);
    // Its settled status goes out now, ahead of every frame of setup's: the orchestrator records the run's outcome when
    // the prepare finishes, and the forwarder's own poll could come after that.
    if (deps.onWarmSettled) deps.onWarmSettled();
    if (request.repos.length > 1) markRoot(root);
    const prior = readPool(home);
    writeJson(poolFile(home), {
      environmentId: request.environmentId, root, preparedAt: new Date().toISOString(), adopted: false,
      repos: cloned.checkouts.map(c => ({ repo: c.repo, name: c.name, dir: c.dir, branch: c.branch, commit: c.commit })),
      onWarm: warm.state === 'skipped' && prior && prior.onWarm ? prior.onWarm : { state: warm.state, seconds: warm.seconds },
      ...(request.broker ? { poolGitConfig: true } : {}),
    });
    const r = await envRun.startChain(root, {
      projectId: POOL_PROJECT, instanceId: request.instanceId, fileRepo: request.fileRepo, filePath: request.filePath,
      fileText: request.fileText, trigger: 'pool', only: 'setup', again: true,
      ...(request.prepareId ? { prepareId: request.prepareId } : {}),
      // This prepare's own on-warm outcome (a refresh's skip included), for the orchestrator's environment.setup event:
      // the status file says only the box's last run.
      poolOnWarm: { state: warm.state, seconds: warm.seconds },
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
  ON_WARM_UNIT, runOnWarm, systemctlStart,
  CAPABILITIES, POOL_PROJECT, handleEnvironmentPrepare, acceptPrepare, chainRoot, readPool, preparedCheckout, markAdopted, poolFile, dropPoolGitConfig,
};
