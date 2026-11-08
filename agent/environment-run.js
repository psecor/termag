#!/usr/bin/env node
'use strict';

// Runs a repository's environment file on the box ("The
// steps"): `setup` once, then `run`, then a wait for `ports` to be healthy,
// then `seed`. Everything runs in one tmux session per checkout,
// `termag-env-<key>`: window `up` is the chain (setup's and seed's output),
// and each `run` entry gets a window of its own, started at once. What
// happened, with each phase's time, is in ~/.termag/env/<key>.json, which the
// agent forwards to the orchestrator for a project's checkout
// (environment-file.js frameFromEnvState).
//
// The CLI (deploy/termag-env): termag-env up|setup|run|seed|status|down [dir]
//   [--file <path>] [--again] [--no-wait] [--timeout <s>] [--json]
// `up` and `setup` start the chain in its session and follow it until it
// settles; `--no-wait` returns at once. The agent starts the same chain when
// a box made for a project has cloned it (`environment-up`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const {
  DEFAULT_PATH, MAX_BYTES, parseEnvironmentFile, resolveSecrets, envKey, findCheckouts, formatDuration, repoKey, frameFromEnvState, turnNotice, redactSecrets, projectRootOf, environmentCheckouts, portUrl,
} = require('./environment-file');

const HEALTH_TIMEOUT_S = 15 * 60;
const HEALTH_POLL_MS = 2000;
// How long a run with no ports is watched for an exit before it counts as started.
const PORTLESS_GRACE_MS = 3000;
// The longest a setup, seed or stop step may run before it's stopped and failed.
const STEP_TIMEOUT_S = 60 * 60;
const PROBE_TIMEOUT_MS = 3000;
// Settled chain states: what `up` waits for.
// `held`: kept for its owner to run (handleEnvironmentUp), so no chain is running (Bugbot, #998).
const SETTLED = new Set(['up', 'ready', 'failed', 'stopped', 'none', 'held']);

function stateDir(home) { return path.join(home, '.termag', 'env'); }
function statePath(home, key) { return path.join(stateDir(home), `${key}.json`); }
function sessionName(key) { return `termag-env-${key}`; }
function nowIso() { return new Date().toISOString(); }

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function isCheckout(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/**
 * Where a checkout's environment file is, and the checkouts its steps run in.
 * `fileRepo` + `filePath`: an environment's file (the orchestrator's, kept in
 * the state); else `<dir>/.termag/environment.json`. A multi-repo project's
 * root needs the file's repository named.
 */
function locate(dir, { fileRepo = null, filePath = null, fileText = null } = {}) {
  const checkouts = findCheckouts(dir);
  const single = isCheckout(dir);
  let fileDir = dir;
  let repo = fileRepo ? repoKey(fileRepo) : null;
  // An environment's file the orchestrator read and sent (inline, or at its pointer's branch): its
  // repository's checkout, if this project has one, is where a string step runs.
  if (typeof fileText === 'string') {
    if (!single) fileDir = (repo && checkouts[repo]) || null;
    else repo = repo || Object.keys(checkouts)[0] || null;
    return { file: null, fileText, fileDir, fileRepo: repo, checkouts, root: dir, multi: !single, relPath: filePath || "the environment's file" };
  }
  if (single) {
    repo = repo || Object.keys(checkouts)[0] || null;
  } else if (repo && checkouts[repo]) {
    fileDir = checkouts[repo];
  } else if (!repo && Object.keys(checkouts).length === 1) {
    [repo] = Object.keys(checkouts);
    fileDir = checkouts[repo];
  } else {
    return { error: repo ? `${repo} has no checkout under ${dir}` : `${dir} holds several checkouts; name the file's with --file <checkout>/<path>` };
  }
  const rel = filePath || DEFAULT_PATH;
  const file = path.isAbsolute(rel) ? rel : path.join(fileDir, rel);
  return { file, fileDir, fileRepo: repo, checkouts, root: dir, multi: !single, relPath: path.relative(fileDir, file) };
}

/** The file as steps, or { missing } when there is none, or { error }. */
function loadPlan(dir, where = {}) {
  const loc = locate(dir, where);
  if (loc.error) return { error: loc.error };
  let text = loc.fileText;
  if (typeof text !== 'string') {
    try {
      const st = fs.statSync(loc.file);
      if (st.size > MAX_BYTES) return { ...loc, plan: null, warnings: [`${loc.relPath} is over ${MAX_BYTES / 1024} KiB, so it was ignored`] };
      text = fs.readFileSync(loc.file, 'utf8');
    } catch { return { ...loc, missing: true }; }
  }
  const plan = parseEnvironmentFile(text, loc, loc.relPath);
  return { ...loc, plan };
}

/** Where the file is for this run: what the caller names, else what the state kept (an --file names a file on disk). */
function whereFrom(opts, previous) {
  if (opts.filePath && opts.fileText === undefined && opts.fromCli) return { fileRepo: opts.fileRepo || null, filePath: opts.filePath, fileText: null };
  return {
    fileRepo: opts.fileRepo || previous.fileRepo || null,
    filePath: opts.filePath || previous.filePath || null,
    fileText: typeof opts.fileText === 'string' ? opts.fileText : typeof previous.fileText === 'string' ? previous.fileText : null,
  };
}

function phase(state = 'none', extra = {}) { return { state, ...extra }; }

/** Runs one command, its output to the window and to the phase's log. */
/** The running steps' process groups, stopped when the chain itself is interrupted or killed. */
const stepGroups = new Set();
let watchingSignals = false;
let exiting = false;
function watchChainSignals() {
  if (watchingSignals) return;
  watchingSignals = true;
  // However the chain then exits (its own flow can finish first, a step having failed on the SIGTERM), what is left
  // of an interrupted chain's steps is killed on the way out.
  process.on('exit', () => { if (exiting) for (const g of stepGroups) if (g.alive()) g('SIGKILL'); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (exiting) return;
      exiting = true;
      const code = sig === 'SIGINT' ? 130 : 143;
      // SIGTERM, then SIGKILL after a grace for a step that ignores it, so nothing it started outlives the chain
      // (Bugbot, #998). Exits as soon as every step's group has closed.
      for (const g of stepGroups) g('SIGTERM');
      const kill = setTimeout(() => { for (const g of stepGroups) g('SIGKILL'); process.exit(code); }, 2000);
      const done = setInterval(() => {
        for (const g of stepGroups) if (!g.alive()) stepGroups.delete(g);
        if (!stepGroups.size) { clearTimeout(kill); clearInterval(done); process.exit(code); }
      }, 50);
    });
  }
}

/** PATH for a step when the agent's environment has none. */
const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * A step's environment: an allowlist, never the agent process's. PATH and HOME from `base`, then `vars` (the file's
 * own `env`, and for run and seed the secrets it asks for), then
 * TERMAG_ENV_DIR and TERMAG_ENV_KEY. Nothing else of `base` (no BASH_ENV, agent token or tmux socket) reaches a step
 * (decision #58, #998). `setup` never gets the secrets: an environment pool runs it before the box has an owner, so
 * it gets none on every box.
 */
function allowedEnv(base, vars, dir, key) {
  return { PATH: (base && base.PATH) || FALLBACK_PATH, HOME: (base && base.HOME) || os.homedir(), ...(vars || {}), TERMAG_ENV_DIR: dir, TERMAG_ENV_KEY: key };
}

/** A run window's environment (execWindow): the same allowlist, from the exec file's variables. */
function windowEnv(exec, dir, key, base) {
  return allowedEnv(base, (exec && exec.env) || {}, dir, key);
}

function runCommand(step, env, logFile, { spawnImpl = spawn, out = process.stdout, timeoutMs = 0, onTimeout } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const log = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    log.write(`\n$ ${step.command}    # in ${step.dir}, ${nowIso()}\n`);
    // Its own process group, so a timeout stops the step's children too, not only its shell, and nothing left holds
    // its output open (Devin, #998). A Ctrl-C or kill of the chain stops the group as well (stepGroups).
    const child = spawnImpl('bash', ['-lc', step.command], { cwd: step.dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    // Whether any process of the group is left: a backgrounded child can outlive the step's shell.
    group.alive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    stepGroups.add(group);
    watchChainSignals();
    const tee = (chunk) => { out.write(chunk); log.write(chunk); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('error', (err) => { tee(`termag-env: ${err.message}\n`); });
    // A step that hangs is stopped: SIGTERM, then SIGKILL, and it counts as failed (Bugbot, #998).
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        tee(`termag-env: ${step.command} ran past ${formatDuration(timeoutMs)}; stopping it\n`);
        group('SIGTERM');
        setTimeout(() => group('SIGKILL'), 5000).unref();
      }, timeoutMs);
    }
    // Tracked while any of it is left, so an interrupt still stops what the step backgrounded (Devin, #998).
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); if (!group.alive()) stepGroups.delete(group); log.end(); resolve(code === null ? (signal ? 128 : 1) : code); });
  });
}

/**
 * Whether a port answers, and where: `{ ok, host }`. 127.0.0.1 first; ::1 only when nothing listens there (a
 * server bound to `localhost` may take either), as ownership and Share fall back (Bugbot, #998). An unhealthy
 * answer on 127.0.0.1 is unhealthy, never a stranger's on ::1. Healthy: its health path's HTTP status under
 * 400, else a TCP connect.
 */
async function probePort(port, opts = {}) {
  const v4 = await probeOn(port, { ...opts, host: '127.0.0.1' });
  if (v4 !== 'none') return { ok: v4 === 'ok', host: '127.0.0.1' };
  const v6 = await probeOn(port, { ...opts, host: '::1' });
  return v6 === 'none' ? { ok: false, host: '127.0.0.1' } : { ok: v6 === 'ok', host: '::1' };
}

/** A probe's answer, from probePort's `{ ok, host }` or a bare boolean (a test's stand-in). */
function probed(r) {
  return r && typeof r === 'object' ? { ok: r.ok === true, host: r.host === '::1' ? '::1' : '127.0.0.1' } : { ok: r === true, host: '127.0.0.1' };
}

/** A port's ok state with where it answered: `host` only for ::1, so a URL names [::1]. */
const portState = (p, r, at) => ({ ...p, healthy: r.ok, ...(r.ok && r.host === '::1' ? { host: '::1' } : {}), ...(at ? { checkedAt: at } : {}) });

/** 'ok', 'down' (it answered, unhealthily, or timed out) or 'none' (nothing listens: refused). */
function probeOn(port, { host, timeoutMs = PROBE_TIMEOUT_MS }) {
  const refused = (err) => (err && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'ENETUNREACH') ? 'none' : 'down');
  return new Promise((resolve) => {
    if (port.health) {
      const req = http.get({ host, port: port.port, path: port.health, timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode < 400 ? 'ok' : 'down');
      });
      req.on('timeout', () => { req.destroy(); resolve('down'); });
      req.on('error', (err) => resolve(refused(err)));
      return;
    }
    const socket = net.connect({ host, port: port.port });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs, () => done('down'));
    socket.once('connect', () => done('ok'));
    socket.once('error', (err) => done(refused(err)));
  });
}

/** A checkout's HEAD commit, or null (no commit yet, not a checkout). */
function headOf(dir, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 10_000 }, (err, stdout) => {
      const sha = String(stdout || '').trim();
      resolve(!err && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
    });
  });
}

/**
 * The HEAD of each of the environment's checkouts, by owner/name: what `setupCommit` records when setup succeeds,
 * and what is compared with it before each run.
 */
async function checkoutHeads(loaded, deps = {}) {
  const found = (loaded && loaded.checkouts) || {};
  const plan = loaded && loaded.plan;
  // The file's repositories (and its own) when it names them, else every checkout found, as the steps see them.
  const wanted = plan && plan.repos && plan.repos.length
    ? [...new Set([loaded.fileRepo, ...plan.repos.map(r => r.repo)].filter(Boolean))]
    : Object.keys(found);
  const out = {};
  for (const repo of wanted) {
    const dir = found[repo] || (repo === loaded.fileRepo ? loaded.fileDir : null);
    // A named repository with no checkout here (removed, never cloned) is recorded as no commit, so one that goes
    // missing after setup counts as moved.
    out[repo] = dir ? await (deps.head || headOf)(dir) : null;
  }
  return out;
}

/** The repositories whose HEAD isn't the commit setup last succeeded at, with both: `[{ repo, from, to }]`. */
function movedSince(setupCommit, heads) {
  const was = setupCommit && typeof setupCommit === 'object' ? setupCommit : null;
  return Object.entries(heads)
    .filter(([repo, sha]) => !was || !Object.prototype.hasOwnProperty.call(was, repo) || was[repo] !== sha)
    .map(([repo, sha]) => ({ repo, from: was && typeof was[repo] === 'string' ? was[repo] : null, to: sha }));
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : 'nothing');
const movedLine = (moved) => moved.map(m => (m.from ? `${m.repo} moved from ${short(m.from)} to ${short(m.to)}` : `${m.repo} is at ${short(m.to)}, and setup's commit there isn't recorded`)).join('; ');

function execTmux(args, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('tmux', args, { timeout: 10_000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
  });
}

/**
 * What run, seed and stop get besides PATH and HOME (allowedEnv): the file's own `env`, the secrets it asks for that
 * resolved from the caller's environment ('your environment'), and the delivered ones. `{ secrets, stepVars }`.
 */
function resolveStepVars(plan, home, deps = {}) {
  const base = deps.env || process.env;
  const secrets = resolveSecrets(plan.secrets, { env: base });
  const inherited = Object.fromEntries(secrets.resolved.filter(r => r.via === 'your environment' && typeof base[r.name] === 'string').map(r => [r.name, base[r.name]]));
  return { secrets, stepVars: { ...(plan.env || {}), ...inherited, ...secrets.env } };
}

/**
 * The chain, in window `up` of the session: setup (skipped once it has
 * succeeded, unless `again`), run (every entry at once, each in its own
 * window), the wait for health, then seed. `only`: just that phase.
 */
async function chain(dir, opts = {}, deps = {}) {
  const home = deps.home || os.homedir();
  const key = envKey(dir);
  const file = statePath(home, key);
  const previous = readJson(file) || {};
  const where = whereFrom(opts, previous);
  const loaded = loadPlan(dir, where);
  const out = deps.out || process.stdout;
  const say = (line) => out.write(`[termag-env] ${line}\n`);
  const state = {
    ...previous,
    key, dir, session: sessionName(key),
    projectId: opts.projectId || previous.projectId || null,
    instanceId: opts.instanceId || previous.instanceId || null,
    fileRepo: where.fileRepo, filePath: where.filePath, fileText: where.fileText,
    setup: previous.setup || phase(), run: previous.run || phase(), seed: previous.seed || phase(), ports: previous.ports || [],
    // The last down's stop was the app before this one's (Bugbot, #998).
    stop: phase(),
    // Running it ends a hold: the owner chose to.
    held: undefined,
    // A pending write's token is startChain's, not this run's (Bugbot, #998).
    pendingId: undefined,
  };
  const save = () => { state.updatedAt = nowIso(); writeJson(file, state); };

  if (loaded.error) {
    Object.assign(state, { state: 'failed', warnings: [loaded.error] });
    save();
    say(loaded.error);
    return state;
  }
  state.file = loaded.relPath;
  if (loaded.missing || !loaded.plan) {
    Object.assign(state, { state: 'none', warnings: loaded.warnings || [] });
    save();
    say(loaded.missing ? `no ${loaded.relPath} in ${loaded.fileDir}: nothing to set up or run` : (loaded.warnings || []).join('; '));
    return state;
  }
  const plan = loaded.plan;
  // The file's ports from the start, so a turn told setup is running (turnNotice) and the UIs name
  // them before run: each keeps the health the last check gave it, else not healthy.
  state.ports = plan.ports.map(p => ({ ...p, healthy: (state.ports || []).some(q => q.port === p.port && q.healthy === true) }));
  const { secrets, stepVars } = resolveStepVars(plan, home, deps);
  state.secrets = { resolved: secrets.resolved, missing: secrets.missing };
  state.warnings = [...plan.warnings, ...secrets.warnings];
  for (const w of state.warnings) say(`warning: ${w}`);
  const base = deps.env || process.env;
  const env = allowedEnv(base, stepVars, dir, key);
  // setup: the file's own env only, never a secret, on every box (an environment pool runs it ownerless).
  const setupEnv = allowedEnv(base, { ...(plan.env || {}) }, dir, key);
  // What the run windows read (environment-run.js exec): their commands and the resolved secrets, 0600. Written only
  // once setup is done, and an earlier run's removed before it starts: setup runs as the same user, so a file on disk
  // is as readable to it as to the windows.
  const execFile = path.join(stateDir(home), `${key}.exec.json`);
  const writeExec = () => writeJson(execFile, { run: plan.run, env: stepVars, dir, key });
  const logs = path.join(stateDir(home), key);
  // `only`: that phase alone; `skipSetup`: run, the health wait and seed (termag-env run).
  const wants = (p) => (p === 'setup' && opts.skipSetup ? false : !opts.only || opts.only === p);

  const steps = async (name) => {
    const list = plan[name];
    if (!list.length) {
      state[name] = phase('none');
      // An empty setup has still been run past at these commits: an environment pool reads them as what it
      // prepared (backend envPool.ts), and the moved-since check needs setup succeeded, so this changes nothing else.
      if (name === 'setup') state.setupCommit = await checkoutHeads(loaded, deps);
      save();
      return true;
    }
    const startedAt = Date.now();
    // A setup run again after it had succeeded (--again) is a rerun: the setup event tells it apart (#998).
    const rerun = name === 'setup' && !!state.setup && state.setup.state === 'succeeded' ? { rerun: true } : {};
    state[name] = phase('running', { startedAt: new Date(startedAt).toISOString(), ...rerun });
    state.state = name === 'setup' ? 'setup' : 'seeding';
    save();
    say(`${name}: ${list.length} step${list.length === 1 ? '' : 's'}`);
    for (const step of list) {
      let timedOut = false;
      const limitMs = (opts.stepTimeoutS || STEP_TIMEOUT_S) * 1000;
      const code = await runCommand(step, name === 'setup' ? setupEnv : env, path.join(logs, `${name}.log`), { spawnImpl: deps.spawn, out, timeoutMs: limitMs, onTimeout: () => { timedOut = true; } });
      // Past its limit is a failure, whatever it exits with once stopped (Devin, #998).
      if (code !== 0 || timedOut) {
        const ms = Date.now() - startedAt;
        const error = timedOut ? `${step.command} timed out after ${formatDuration(limitMs)}` : `${step.command} exited ${code}`;
        state[name] = phase('failed', { startedAt: state[name].startedAt, finishedAt: nowIso(), durationMs: ms, exitCode: code, error, ...rerun });
        state.state = 'failed';
        save();
        say(`${name} failed after ${formatDuration(ms)}: ${step.command} exited ${code} (log: ${path.join(logs, `${name}.log`)})`);
        return false;
      }
    }
    const ms = Date.now() - startedAt;
    state[name] = phase('succeeded', { startedAt: state[name].startedAt, finishedAt: nowIso(), durationMs: ms, exitCode: 0, ...rerun });
    // The commit of each repository setup has now succeeded at: the next run compares HEAD with it. Read after the
    // steps, so a setup that itself checks something out records where it left the checkout.
    if (name === 'setup') state.setupCommit = await checkoutHeads(loaded, deps);
    save();
    say(`${name} took ${formatDuration(ms)}`);
    return true;
  };

  // setup reruns whenever the checkout has moved since it last succeeded (a pull, a branch switch): any repository's
  // HEAD differing from its setupCommit. termag never pulls here; it only notices what the owner did. setup must be
  // incremental for this.
  const moved = state.setup.state === 'succeeded' && plan.setup.length ? movedSince(state.setupCommit, await checkoutHeads(loaded, deps)) : [];
  if (wants('setup')) {
    fs.rmSync(execFile, { force: true });
    if (state.setup.state === 'succeeded' && !opts.again && !moved.length) {
      say(`setup already ran ${state.setup.finishedAt} (took ${formatDuration(state.setup.durationMs || 0)}); termag-env setup --again reruns it`);
    } else {
      if (state.setup.state === 'succeeded' && !opts.again) say(`${movedLine(moved)} since setup last succeeded: running setup again`);
      if (!(await steps('setup'))) return state;
    }
  } else if (opts.skipSetup && moved.length) {
    say(`warning: ${movedLine(moved)} since setup last succeeded; termag-env up reruns setup first`);
  }
  writeExec();
  if (opts.only === 'setup') { state.state = 'ready'; save(); return state; }

  // Whether this chain started the app: seed seeds a run once, as setup sets a box up once.
  let started = false;
  if (wants('run') && plan.run.length) {
    state.ports = plan.ports.map(p => ({ ...p, healthy: false }));
    const firstProbe = plan.ports.length ? (await Promise.all(plan.ports.map(p => (deps.probe || probePort)(p)))).map(probed) : [];
    const healthyNow = plan.ports.length > 0 && firstProbe.every(r => r.ok);
    // Healthy is this app only when this environment's checkouts serve every port, as Share preview checks
    // (browser-guest.js portOwnership): another project's app, or a leftover process, is never taken for it
    // or seeded, whether it was up already or answered the health wait after a run (Bugbot, #998).
    // `strangers` is the ports someone else serves for sure; it fails run with whose they are.
    const strangers = async () => {
      const checkouts = environmentCheckouts(loaded, dir);
      const guest = require('./browser-guest');
      const ask = deps.portOwnership || ((p, cs, ip) => guest.portOwnership(ip, p.port, cs, deps));
      // Health is probed on 127.0.0.1, else ::1 (probePort): whose a port is, the same way (Bugbot, #998).
      const owner = async (p) => {
        const v4 = await ask(p, checkouts, '127.0.0.1');
        return v4 === 'none' ? ask(p, checkouts, '::1') : v4;
      };
      const whose = plan.ports.map((p, i) => ({ p, who: null, i }));
      for (const [i, who] of (await Promise.all(plan.ports.map(p => owner(p)))).entries()) whose[i].who = who;
      // A listener it can't attribute (`docker run -p`, Docker's proxy: root's sockets) isn't someone else's for
      // sure: the app is taken as this one, and the state says so (Bugbot, #998).
      const unknown = whose.filter(x => guest.ownerUnknown(x.who));
      for (const { p } of unknown) state.warnings = [...(state.warnings || []), `couldn't tell whose listener answers ${p.name} (:${p.port}); taking it as this app`];
      return whose.filter(x => x.who !== 'owned' && x.who !== 'none' && !guest.ownerUnknown(x.who));
    };
    const failHeld = (held, startedAt, prefix) => {
      const error = held.map(({ p, who }) => `${p.name} (:${p.port}) is served by something else: ${who}`).join('; ');
      state.run = phase('failed', { ...(startedAt ? { startedAt } : {}), finishedAt: nowIso(), error });
      state.state = 'failed';
      save();
      say(`${prefix}: ${error}`);
      return state;
    };
    if (healthyNow && !opts.again) {
      const held = await strangers();
      if (held.length) return failHeld(held, null, 'run not started');
    }
    if (healthyNow && !opts.again) {
      state.ports = plan.ports.map((p, i) => portState(p, firstProbe[i], nowIso()));
      // Up already: its run is done, whoever started it (Bugbot, #998); an earlier run keeps its own times.
      state.run = state.run && state.run.state === 'succeeded' ? state.run : phase('succeeded', { finishedAt: nowIso() });
      say('every port is healthy already: the app is up, so run was not started again');
    } else {
      const startedAt = Date.now();
      started = true;
      state.run = phase('running', { startedAt: new Date(startedAt).toISOString() });
      state.state = 'starting';
      save();
      // An earlier run's windows (a failed run, --again, a file with no ports) would keep their app on
      // the same ports beside the new one: close them first. Only `run` and `run:<repo>`, never `up`.
      const tmux = deps.tmux || ((args) => execTmux(args));
      const listed = await tmux(['list-windows', '-t', `=${sessionName(key)}`, '-F', '#{window_id} #{window_name}']);
      for (const line of listed.ok ? listed.stdout.split('\n') : []) {
        const [id, name] = line.trim().split(' ');
        if (id && /^run(:|$)/.test(name || '')) await tmux(['kill-window', '-t', id]);
      }
      const startWindow = deps.startWindow || ((i, entry) => execTmux([
        'new-window', '-d', '-t', `=${sessionName(key)}:`, '-n', plan.run.length === 1 ? 'run' : `run:${entry.repo.split('/')[1]}`,
        '-c', entry.dir, '--', process.execPath, __filename, 'exec', dir, String(i),
      ]));
      for (const [i, entry] of plan.run.entries()) {
        try { fs.rmSync(path.join(stateDir(home), `${key}.run-${i}.json`), { force: true }); } catch { /* not there */ }
        const r = await startWindow(i, entry);
        if (r && r.ok === false) {
          state.run = phase('failed', { startedAt: state.run.startedAt, finishedAt: nowIso(), error: `could not start a window for ${entry.command}` });
          state.state = 'failed';
          save();
          say(state.run.error);
          return state;
        }
        say(`run: started ${entry.command} in ${entry.dir}`);
      }
      if (plan.ports.length) {
        state.state = 'waiting';
        save();
        const deadline = startedAt + (opts.timeoutS || HEALTH_TIMEOUT_S) * 1000;
        for (;;) {
          const probes = (await Promise.all(plan.ports.map(p => (deps.probe || probePort)(p)))).map(probed);
          const results = probes.map(r => r.ok);
          const at = nowIso();
          for (const [i, ok] of results.entries()) if (ok && !state.ports[i].healthy) say(`${plan.ports[i].name} (:${plan.ports[i].port}) is healthy`);
          state.ports = plan.ports.map((p, i) => portState(p, probes[i], at));
          save();
          if (results.every(Boolean)) break;
          const exited = plan.run.map((_, i) => readJson(path.join(stateDir(home), `${key}.run-${i}.json`))).find(r => r && r.exitCode !== 0);
          if (exited || Date.now() > deadline) {
            const ms = Date.now() - startedAt;
            const error = exited ? `${exited.command} exited ${exited.exitCode} before its ports were healthy`
              : `${state.ports.filter(p => !p.healthy).map(p => `${p.name} (:${p.port})`).join(', ')} not healthy after ${formatDuration(ms)}`;
            state.run = phase('failed', { startedAt: state.run.startedAt, finishedAt: nowIso(), durationMs: ms, error });
            state.state = 'failed';
            save();
            say(`run failed: ${error}`);
            return state;
          }
          await new Promise(r => setTimeout(r, deps.pollMs || HEALTH_POLL_MS));
        }
      } else {
        // No ports to wait for: a run that exits non-zero at once is a failed run, not an app up (Devin, #998).
        await new Promise(r => setTimeout(r, deps.graceMs ?? PORTLESS_GRACE_MS));
        const exited = plan.run.map((_, i) => readJson(path.join(stateDir(home), `${key}.run-${i}.json`))).find(r => r && r.exitCode !== 0);
        if (exited) {
          const error = `${exited.command} exited ${exited.exitCode}`;
          state.run = phase('failed', { startedAt: state.run.startedAt, finishedAt: nowIso(), durationMs: Date.now() - startedAt, error });
          state.state = 'failed';
          save();
          say(`run failed: ${error}`);
          return state;
        }
      }
      // What answered is this run's app only when the environment's checkouts serve it (Bugbot, #998).
      if (plan.ports.length) {
        const held = await strangers();
        if (held.length) return failHeld(held, state.run.startedAt, 'run failed');
      }
      const ms = Date.now() - startedAt;
      state.run = phase('succeeded', { startedAt: state.run.startedAt, finishedAt: nowIso(), durationMs: ms });
      save();
      say(plan.ports.length ? `the app is up after ${formatDuration(ms)}: ${state.ports.map(p => portUrl(p)).join(', ')}` : 'run started (no ports to wait for)');
    }
    // Seed only an app this chain started: one already serving before it (the person started it, or trusted the
    // project long after the claim) may hold their data, which a seed would overwrite. termag-env seed (or --again,
    // which restarts the app) seeds it (#998).
    if (wants('seed') && plan.seed.length && !started) {
      say(state.seed && state.seed.state === 'succeeded'
        ? `seed already ran on this app ${state.seed.finishedAt}; termag-env seed reruns it`
        : "the app was already up before this up, so seed didn't run on it; termag-env seed runs it");
    } else if (wants('seed') && !(await steps('seed'))) return state;
  } else if (!plan.run.length && !opts.only) {
    // No run (setup or something outside the file brings the app up): still wait for the ports' health,
    // then seed once, as up does after a run (Bugbot, #998). run holds only this up's health timeout, so
    // an earlier one is cleared first (Bugbot, #998).
    state.run = phase('none');
    if (plan.ports.length) {
      const startedAt = Date.now();
      const deadline = startedAt + (opts.timeoutS || HEALTH_TIMEOUT_S) * 1000;
      state.state = 'waiting';
      state.ports = plan.ports.map(p => ({ ...p, healthy: false }));
      save();
      for (;;) {
        const probes = (await Promise.all(plan.ports.map(p => (deps.probe || probePort)(p)))).map(probed);
        const results = probes.map(r => r.ok);
        const at = nowIso();
        for (const [i, ok] of results.entries()) if (ok && !state.ports[i].healthy) say(`${plan.ports[i].name} (:${plan.ports[i].port}) is healthy`);
        state.ports = plan.ports.map((p, i) => portState(p, probes[i], at));
        save();
        if (results.every(Boolean)) break;
        if (Date.now() > deadline) {
          const error = `${state.ports.filter(p => !p.healthy).map(p => `${p.name} (:${p.port})`).join(', ')} not healthy after ${formatDuration(Date.now() - startedAt)}`;
          // The app's failure to come up, in run's place, so it isn't read as setup's (Bugbot, #998).
          state.run = phase('failed', { startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), durationMs: Date.now() - startedAt, error });
          state.state = 'failed';
          save();
          say(`run failed: ${error}`);
          return state;
        }
        await new Promise(r => setTimeout(r, deps.pollMs || HEALTH_POLL_MS));
      }
    }
    if (plan.seed.length && state.seed && state.seed.state === 'succeeded' && !opts.again) {
      say(`seed already ran ${state.seed.finishedAt}; termag-env seed reruns it`);
    } else if (!(await steps('seed'))) return state;
  } else if (opts.only === 'seed' && !(await steps('seed'))) {
    return state;
  }
  state.state = plan.run.length || plan.ports.length ? 'up' : 'ready';
  save();
  return state;
}

/**
 * termag-env down: the file's `stop` (a map in the order written; a step that
 * fails is logged and the rest still run), then the session closed whatever
 * stop did. For a `run` that daemonizes, which closing its window wouldn't
 * stop (termag's own `make e2e-up`). `{ stop, closed }`.
 */
async function stopEnvironment(dir, opts = {}, deps = {}) {
  const home = deps.home || os.homedir();
  const key = envKey(dir);
  const file = statePath(home, key);
  const previous = readJson(file) || {};
  const out = deps.out || process.stdout;
  const say = (line) => out.write(`[termag-env] ${line}\n`);
  const loaded = loadPlan(dir, whereFrom(opts, previous));
  const list = loaded.plan ? loaded.plan.stop : [];
  let stop = phase('none');
  if (list.length) {
    // The run's own secrets, from the file its windows read; with none (a setup rerun failed before writing it, or the
    // app came up some other way), resolved now, as up resolves them, so a stop that needs one still gets it.
    const exec = readJson(path.join(stateDir(home), `${key}.exec.json`));
    const vars = exec && exec.env && typeof exec.env === 'object' ? exec.env : resolveStepVars(loaded.plan, home, deps).stepVars;
    const env = allowedEnv(deps.env || process.env, vars, dir, key);
    const startedAt = Date.now();
    const errors = [];
    for (const step of list) {
      let timedOut = false;
      const code = await runCommand(step, env, path.join(stateDir(home), key, 'stop.log'), { spawnImpl: deps.spawn, out, timeoutMs: (opts.stepTimeoutS || STEP_TIMEOUT_S) * 1000, onTimeout: () => { timedOut = true; } });
      if (code !== 0 || timedOut) {
        errors.push(timedOut ? `${step.command} timed out` : `${step.command} exited ${code}`);
        say(`stop: ${step.command} exited ${code}; closing the session anyway (log: ${path.join(stateDir(home), key, 'stop.log')})`);
      }
    }
    const ms = Date.now() - startedAt;
    stop = errors.length
      ? phase('failed', { startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), durationMs: ms, error: errors.join('; ') })
      : phase('succeeded', { startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), durationMs: ms, exitCode: 0 });
    if (!errors.length) say(`stop took ${formatDuration(ms)}`);
  }
  const r = await (deps.tmux || ((args) => execTmux(args)))(['kill-session', '-t', `=${sessionName(key)}`]);
  if (previous.key || list.length) {
    writeJson(file, { ...previous, key, dir, session: sessionName(key), state: 'stopped', stop, ports: (previous.ports || []).map(({ host: _host, ...p }) => ({ ...p, healthy: false })), updatedAt: nowIso() });
  }
  fs.rmSync(path.join(stateDir(home), `${key}.exec.json`), { force: true });
  return { stop, closed: r.ok, ran: list.length > 0, warnings: (loaded.plan && loaded.plan.warnings) || loaded.warnings || [] };
}

/** A run window: its command, with the resolved secrets, kept open after it exits so its output stays readable. */
async function execWindow(dir, index, deps = {}) {
  const home = deps.home || os.homedir();
  const key = envKey(dir);
  const exec = readJson(path.join(stateDir(home), `${key}.exec.json`));
  const entry = exec && Array.isArray(exec.run) ? exec.run[Number(index)] : null;
  if (!entry) { process.stderr.write('termag-env: nothing to run here\n'); return 1; }
  const env = windowEnv(exec, dir, key, process.env);
  process.stdout.write(`[termag-env] $ ${entry.command}\n`);
  const code = await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', entry.command], { cwd: entry.dir, env, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (c, signal) => resolve(c === null ? (signal ? 128 : 1) : c));
  });
  writeJson(path.join(stateDir(home), `${key}.run-${index}.json`), { command: entry.command, exitCode: code, at: nowIso() });
  process.stdout.write(`[termag-env] ${entry.command} exited ${code}; this window stays for its output (termag-env down closes the session)\n`);
  return new Promise(() => { setInterval(() => {}, 1 << 30); });
}

/**
 * Starts the chain in the checkout's session, making the session for it, or
 * says it is running already. `{ started, session, key }`.
 */
async function startChain(dir, opts = {}, deps = {}) {
  const home = deps.home || os.homedir();
  const key = envKey(dir);
  const session = sessionName(key);
  const tmux = deps.tmux || ((args) => execTmux(args));
  const prev = readJson(statePath(home, key)) || {};
  let live = await tmux(['has-session', '-t', `=${session}`]);
  if (live.ok) {
    const panes = await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_name} #{pane_dead}']);
    const chainLive = panes.ok && panes.stdout.split('\n').some(l => l.startsWith('up ') && l.trim().endsWith('0'));
    if (chainLive && !SETTLED.has(prev.state)) return { started: false, running: true, session, key };
    await tmux(['kill-window', '-t', `=${session}:up`]);
    // A settled chain's session may hold only its kept-open `up` window; killing that closed the session
    // (tmux ends one with no windows), so the retry makes a new one (Bugbot, #998).
    live = await tmux(['has-session', '-t', `=${session}`]);
  }
  const args = [process.execPath, __filename, 'chain', dir];
  if (opts.projectId) args.push('--project', opts.projectId);
  if (opts.instanceId) args.push('--instance', opts.instanceId);
  // The file's text, when the orchestrator sent one, goes through the state file, not argv.
  if (opts.fileRepo) args.push('--file-repo', opts.fileRepo);
  if (opts.filePath) args.push(opts.fromCli ? '--file' : '--file-label', opts.filePath);
  if (opts.again) args.push('--again');
  if (opts.skipSetup) args.push('--skip-setup');
  if (opts.only) args.push('--only', opts.only);
  if (opts.timeoutS) args.push('--timeout', String(opts.timeoutS));
  // What `pending` replaces, read in the same step as the write (no await between), and a token for this write:
  // a lost race puts `before` back while the file is still this pending, since a winner that settled first
  // won't write again (Bugbot, #998).
  const before = readJson(statePath(home, key));
  const pendingId = crypto.randomBytes(8).toString('hex');
  // Built on `before`, not the snapshot taken before the tmux awaits: a hold (and its pinned definition) or another
  // up that landed in between is kept (Bugbot, #998).
  const base = before || {};
  writeJson(statePath(home, key), {
    ...base, key, dir, session, state: 'pending', pendingId, trigger: opts.trigger || 'cli',
    projectId: opts.projectId || base.projectId || null, instanceId: opts.instanceId || base.instanceId || null,
    // An environment pool's prepare or refresh: the chain keeps it (state is built on the file), and its frames say it.
    ...(opts.prepareId ? { prepareId: opts.prepareId } : {}),
    ...whereFrom(opts, base), updatedAt: nowIso(),
  });
  const made = live.ok
    ? await tmux(['new-window', '-d', '-t', `=${session}:`, '-n', 'up', '-c', dir, '--', ...args])
    : await tmux(['new-session', '-d', '-s', session, '-n', 'up', '-c', dir, '-e', 'DISABLE_AUTO_UPDATE=true', '--', ...args]);
  if (!made.ok) {
    // Lost a race: another environment-up or termag-env up made the session between this one's check and its
    // create, and its chain is in window `up`. That's the run; its state is never written over (Bugbot, #998).
    const now = await tmux(['has-session', '-t', `=${session}`]);
    if (now.ok) {
      const panes = await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_name} #{pane_dead}']);
      if (panes.ok && panes.stdout.split('\n').some(l => l.startsWith('up ') && l.trim().endsWith('0'))) {
        const cur = readJson(statePath(home, key));
        // Only this up's own pending, unsettled: chain copies the token through, so a settled winner can carry it (Bugbot, #998).
        if (cur && cur.pendingId === pendingId && cur.state === 'pending') {
          if (before) writeJson(statePath(home, key), before);
          else fs.rmSync(statePath(home, key), { force: true });
        }
        return { started: false, running: true, session, key };
      }
    }
    // Not left pending (the card's "Environment starting", which nothing would retry): failed, saying why (Bugbot, #998).
    const error = `could not start tmux session ${session}`;
    const pending = readJson(statePath(home, key)) || {};
    writeJson(statePath(home, key), { ...pending, state: 'failed', warnings: [...(pending.warnings || []), error], updatedAt: nowIso() });
    return { started: false, error, session, key };
  }
  return { started: true, session, key };
}

function describeState(s, { live } = {}) {
  const lines = [];
  if (!s) return ['no environment has run in this checkout yet (termag-env up starts it)'];
  lines.push(`environment: ${s.state || 'none'}${s.file ? ` (${s.file})` : ''}, tmux session ${s.session}`);
  for (const name of ['setup', 'run', 'seed', 'stop']) {
    const p = s[name] || { state: 'none' };
    if (p.state === 'none') continue;
    const took = Number.isFinite(p.durationMs) ? `, ${formatDuration(p.durationMs)}` : '';
    lines.push(`  ${name}: ${p.state}${took}${p.error ? ` (${p.error})` : ''}`);
  }
  if (s.setupCommit && typeof s.setupCommit === 'object') {
    for (const [repo, sha] of Object.entries(s.setupCommit)) lines.push(`  setup commit: ${repo} ${short(sha)}`);
  }
  for (const p of (live || s.ports || [])) lines.push(`  ${p.healthy ? 'healthy  ' : 'unhealthy'} ${p.name} ${portUrl(p)}`);
  if (s.secrets && s.secrets.resolved && s.secrets.resolved.length) lines.push(`  secrets: ${s.secrets.resolved.map(r => `${r.name} (${r.via})`).join(', ')}`);
  for (const w of s.warnings || []) lines.push(`  warning: ${w}`);
  return lines;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--file') { out.filePath = val(); out.fromCli = true; } else if (a === '--file-label') out.filePath = val();
    else if (a === '--file-repo') out.fileRepo = val();
    else if (a === '--project') out.projectId = val();
    else if (a === '--instance') out.instanceId = val();
    else if (a === '--only') out.only = val();
    else if (a === '--timeout') out.timeoutS = Number(val());
    else if (a === '--again') out.again = true;
    else if (a === '--skip-setup') out.skipSetup = true;
    else if (a === '--no-wait') out.noWait = true;
    else if (a === '--json') out.json = true;
    else out._.push(a);
  }
  return out;
}

const USAGE = `usage: termag-env up|setup|run|seed|status|show|down [dir] [--file <path>] [--again] [--no-wait] [--timeout <s>] [--json]
  up      setup (once, and again when HEAD moved since it succeeded), run, wait for the ports' health, seed
  show    the definition up would run (a held environment's included)
  setup   only setup; --again reruns it after it has succeeded
  run     run, the health wait and seed, without setup
  seed    only seed
  status  each phase, its time, and the ports' health now
  down    the file's stop (if any), then close the session
The file is <dir>/.termag/environment.json unless --file names another.`;

async function follow(home, key, { json }) {
  let last = '';
  for (;;) {
    const s = readJson(statePath(home, key));
    if (s && !json) {
      const line = describeState(s).join('\n');
      if (line !== last) { process.stdout.write(`${line}\n`); last = line; }
    }
    if (s && SETTLED.has(s.state)) {
      if (json) process.stdout.write(`${JSON.stringify(s)}\n`);
      return s.state === 'failed' ? 1 : 0;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const [cmd, dirArg] = args._;
  const home = os.homedir();
  const resolveDir = (d) => { try { return fs.realpathSync(path.resolve(d || '.')); } catch { return path.resolve(d || '.'); } };
  if (cmd === 'chain') {
    const s = await chain(resolveDir(dirArg), args);
    // In its window, the chain's output stays readable until the next up or down.
    if (process.env.TMUX) {
      process.stdout.write(`[termag-env] ${s.state}; this window stays for its output (termag-env status, termag-env down)\n`);
      return new Promise(() => { setInterval(() => {}, 1 << 30); });
    }
    return s.state === 'failed' ? 1 : 0;
  }
  if (cmd === 'exec') return execWindow(resolveDir(dirArg), args._[2]);
  const dir = resolveDir(dirArg);
  const key = envKey(dir);
  if (cmd === 'status') {
    await reconcileInterrupted(home).catch(() => []);
    const s = readJson(statePath(home, key));
    const live = s && Array.isArray(s.ports) ? await Promise.all(s.ports.map(async p => { const { host: _h, ...q } = p; return portState(q, await probePort(p)); })) : null;
    if (args.json) process.stdout.write(`${JSON.stringify(s ? { ...s, ports: live || [] } : null)}\n`);
    else process.stdout.write(`${describeState(s, { live }).join('\n')}\n`);
    return 0;
  }
  if (cmd === 'show') {
    // What termag-env up would run here: the definition this checkout keeps (an environment's), else its file.
    const s = readJson(statePath(home, key)) || {};
    if (s.state === 'held') process.stdout.write(s.held === 'unpinned'
      ? "held: the environment's file couldn't be pinned when the project was made, so this is its branch's current text; read it, then termag-env up runs it\n"
      : s.held === 'checkout'
        ? "held: the repository's own environment file runs only when you run it; read it, then termag-env up runs it\n"
        : s.held === 'automation' || s.held === 'not-first'
          ? `held: ${s.held === 'automation' ? 'an automation' : 'a project added to a box made for another'} starts nothing on its own; read it, then termag-env up runs it\n`
        : s.held === 'pointer'
          ? "held: the environment points at a repository's file, as it was read when the project was made; that file runs only when you run it; read it, then termag-env up runs it\n"
        : 'held: someone else wrote this version of the environment; read it, then termag-env up runs it\n');
    const loc = locate(dir, whereFrom(args, s));
    if (loc.error) { process.stderr.write(`termag-env: ${loc.error}\n`); return 2; }
    let text = loc.fileText;
    if (typeof text !== 'string') { try { text = fs.readFileSync(loc.file, 'utf8'); } catch { process.stderr.write(`termag-env: no ${loc.relPath} in ${loc.fileDir}\n`); return 2; } }
    process.stdout.write(`# ${loc.relPath}\n${text.endsWith('\n') ? text : `${text}\n`}`);
    return 0;
  }
  if (cmd === 'down') {
    const r = await stopEnvironment(dir, args);
    for (const w of r.warnings) process.stdout.write(`[termag-env] warning: ${w}\n`);
    if (r.closed) process.stdout.write(`closed ${sessionName(key)}\n`);
    else if (!r.ran) process.stdout.write('nothing was running\n');
    // A stop that failed may have left the app up (Bugbot, #998): say so, and exit 1.
    if (r.stop.state === 'failed') {
      process.stderr.write(`termag-env: stop failed (${r.stop.error}); the app may still be running\n`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'up' || cmd === 'setup' || cmd === 'run' || cmd === 'seed') {
    if (cmd === 'setup' || cmd === 'seed') args.only = cmd;
    if (cmd === 'run') args.skipSetup = true;
    const plan = loadPlan(dir, whereFrom(args, readJson(statePath(home, key)) || {}));
    if (plan.error) { process.stderr.write(`termag-env: ${plan.error}\n`); return 2; }
    if (plan.missing) { process.stderr.write(`termag-env: no ${plan.relPath} in ${plan.fileDir}\n`); return 2; }
    const started = await startChain(dir, args);
    if (started.error) { process.stderr.write(`termag-env: ${started.error}\n`); return 1; }
    process.stderr.write(started.running
      ? `termag-env: already running in tmux session ${started.session}; following it\n`
      : `termag-env: started in tmux session ${started.session} (tmux attach -t ${started.session})\n`);
    if (args.noWait) return 0;
    return follow(home, key, args);
  }
  process.stderr.write(`${USAGE}\n`);
  return cmd ? 2 : 0;
}

/**
 * A chat turn's environment notice for its checkout `cwd` (environment-file.js
 * turnNotice), from the state the chain keeps; `{ text: null }` where no
 * environment has run. The log tail is the failed step's own log.
 */
function environmentNotice(cwd, seen, { home = os.homedir(), now } = {}) {
  // The checkout's own state, else its real path's, else, for a workstream's worktree, its project's, which
  // the claim's chain writes (as resolveRepoRecipe reads it; Bugbot, #998).
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* as it is */ }
  let dir = cwd;
  let state = null;
  for (const d of [...new Set([cwd, real, projectRootOf(cwd), projectRootOf(real)])].filter(Boolean)) {
    state = readJson(statePath(home, envKey(d)));
    if (state) { dir = d; break; }
  }
  if (!state) return { text: null, seen: seen || {} };
  const key = envKey(dir);
  const logTail = (step) => {
    const file = path.join(stateDir(home), key, `${step}.log`);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  };
  const exec = readJson(path.join(stateDir(home), `${key}.exec.json`));
  const secretValues = exec && exec.env && typeof exec.env === 'object' ? Object.values(exec.env).filter(v => typeof v === 'string') : [];
  return turnNotice(state, seen, { now, logTail, secretValues });
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The project id an environment pool's prepare chain runs under (environment-prepare.js POOL_PROJECT).
const POOL_PROJECT = 'pool';
const CAPABILITIES = ['environment-v1'];

/**
 * The agent's `environment-up` RPC: the orchestrator asks for a project's
 * checkout once a box made for it has cloned it (backend
 * services/projectEnvironment.ts). Starts the chain and answers at once; the
 * state file says the rest. `{ started } | { running } | { skipped } | { error }`.
 */
async function handleEnvironmentUp(msg, deps = {}) {
  if (!msg || typeof msg !== 'object') return { error: 'environment-up: empty request' };
  const { projectId, instanceId, fileRepo = null, filePath = null } = msg;
  // What started it, for the setup event: the claim or the owner's trust (the orchestrator's), else none.
  const trigger = msg.trigger === 'claim' || msg.trigger === 'trust' ? msg.trigger : null;
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) return { error: 'environment-up: projectId is required' };
  if (typeof instanceId !== 'string' || !instanceId || /[\r\n]/.test(instanceId)) return { error: 'environment-up: instanceId is required' };
  const asked = deps.remapPath ? deps.remapPath(msg.dir) : msg.dir;
  if (typeof asked !== 'string' || !path.isAbsolute(asked) || path.normalize(asked) !== asked || asked.includes('\0')) return { error: 'environment-up: dir must be an absolute path' };
  // Keyed by the real path, as termag-env keys it (main's resolveDir): a box made from an environment keeps its
  // checkout at ~/code/<repo> (a multi-repo project its root at ~/code) with the project's directory a link to it (project-clone.js, workspace.js), so the chain, its state and
  // termag-env up in either spelling are the same one.
  let dir = asked;
  try { dir = fs.realpathSync(asked); } catch { /* not there yet: as asked */ }
  if (fileRepo !== null && !repoKey(fileRepo)) return { error: 'environment-up: fileRepo must be owner/name' };
  if (filePath !== null && (typeof filePath !== 'string' || path.isAbsolute(filePath) || filePath.split('/').some(p => p === '..' || p === '.' || p === ''))) {
    return { error: 'environment-up: filePath must be a relative path' };
  }
  const fileText = msg.fileText === undefined || msg.fileText === null ? null : msg.fileText;
  if (fileText !== null && (typeof fileText !== 'string' || Buffer.byteLength(fileText, 'utf8') > MAX_BYTES)) {
    return { error: `environment-up: fileText must be a file of at most ${MAX_BYTES / 1024} KiB` };
  }
  // The orchestrator says trusted when the project's owner picked its environment (projectEnvironment.ts
  // environmentUpRequest); a request that doesn't say so is refused, whatever sent it (Security Agent, #998).
  // A hold runs nothing, so it is kept either way: the definition the project was made with, for its owner's own
  // termag-env up (an automation's, one on a box made for another project; Bugbot, #998).
  const holds = typeof msg.hold === 'string' && !!msg.hold;
  if (msg.trusted !== true && !holds) return { skipped: 'untrusted' };
  // State is keyed by path: another project at this path (one archived there, cloned again) starts fresh, never
  // with the last one's pinned definition or its succeeded setup (Bugbot, #998).
  {
    const home = deps.home || os.homedir();
    const k = envKey(dir);
    // A pool box's prepared chain becomes this project's, setup and setupCommit kept: setup reruns only if HEAD
    // moved since the pool ran it.
    await adoptPoolState(home, dir, projectId, deps);
    const old = readJson(statePath(home, k));
    if (old && old.projectId && old.projectId !== projectId) {
      fs.rmSync(statePath(home, k), { force: true });
      fs.rmSync(path.join(stateDir(home), `${k}.exec.json`), { force: true });
      // Its session too: its app isn't this project's, and a live `up` window would read as this one running (Bugbot, #998).
      await (deps.tmux || ((args) => execTmux(args)))(['kill-session', '-t', `=${sessionName(k)}`]);
    }
  }
  const loaded = loadPlan(dir, { fileRepo, filePath, fileText });
  if (loaded.error) return { error: `environment-up: ${loaded.error}` };
  // Nothing to run or hold, except an environment's held file, whatever the reason it's held: its owner is
  // told the file isn't there (Bugbot, #998). A repository's own (`checkout`) is just absent.
  if (loaded.missing && (!msg.hold || msg.hold === 'checkout' || msg.hold === 'untrusted')) return { skipped: 'no-file' };
  // Held (someone else wrote this version of a shared environment, or its pointer couldn't be pinned): keep
  // the file, start nothing. The owner reads it (termag-env show) and runs it (termag-env up) (Bugbot, #998).
  // An unpinned pointer whose file isn't in the checkout is held too, so the owner is told (Bugbot, #998).
  if (typeof msg.hold === 'string' && msg.hold) {
    const home = deps.home || os.homedir();
    const key = envKey(dir);
    const prev = readJson(statePath(home, key)) || {};
    writeJson(statePath(home, key), {
      ...prev, key, dir, session: sessionName(key), projectId, instanceId, fileRepo, filePath,
      ...(fileText !== null ? { fileText } : {}), file: loaded.relPath, state: 'held', held: msg.hold.slice(0, 40), ...(trigger ? { trigger } : {}), updatedAt: nowIso(),
      ...(loaded.missing ? { warnings: [`no ${loaded.relPath} in ${loaded.fileDir}: nothing to set up or run until it is there`] } : {}),
    });
    return { held: msg.hold.slice(0, 40) };
  }
  const r = await startChain(dir, { projectId, instanceId, fileRepo, filePath, trigger, ...(fileText !== null ? { fileText } : {}) }, deps);
  return r.error ? { error: r.error } : r.running ? { running: true, session: r.session } : { started: true, session: r.session };
}

/**
 * Take over an environment pool's prepared chain (environment-prepare.js) for the project claiming the box: the pool
 * ran it at the path the project's directory now resolves to (~/code/<repo>, or ~/code for several), so it is the
 * state at `dir`'s own key, kept with its setup and setupCommit. Its session goes: the pool's kept-open window is no
 * project's. Returns whether it adopted anything.
 */
async function adoptPoolState(home, dir, projectId, deps = {}) {
  const key = envKey(dir);
  const pooled = readJson(statePath(home, key));
  if (!pooled || pooled.projectId !== POOL_PROJECT) return false;
  const { pool: _p, log: _l, pendingId: _id, prepareId: _pr, ...kept } = pooled;
  writeJson(statePath(home, key), { ...kept, key, dir, session: sessionName(key), projectId, preparedByPool: true, updatedAt: nowIso() });
  await (deps.tmux || ((args) => execTmux(args)))(['kill-session', '-t', `=${sessionName(key)}`]);
  return true;
}

const IN_PROGRESS = { pending: null, setup: 'setup', starting: 'run', waiting: 'run', seeding: 'seed' };

/**
 * An in-progress chain whose tmux window is gone (Ctrl-C in its window, a reboot, a killed session) is interrupted,
 * not in progress for ever: its state becomes failed, its step saying why. The agent runs this when it connects, and
 * termag-env status does. Returns the keys it changed (Bugbot, #998).
 */
async function reconcileInterrupted(home, deps = {}) {
  const tmux = deps.tmux || ((args) => execTmux(args));
  const dir = stateDir(home);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^[a-z0-9-]+\.json$/.test(n) && !/\.(run-\d+|exec)\.json$/.test(n)); } catch { return []; }
  const changed = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const s = readJson(file);
    if (!s) continue;
    const session = s.session || sessionName(s.key || name.replace(/\.json$/, ''));
    // The same write as read, not a state another up wrote meanwhile (both can be pending) (Devin, #998).
    const same = (now) => now && now.state === s.state && now.updatedAt === s.updatedAt && now.pendingId === s.pendingId;
    if (s.state === 'up') {
      // After a reboot (or a killed session) its run windows are gone, and the app with them: stopped, its ports
      // not healthy, so the card and Share don't offer an app nothing serves (Bugbot, #998).
      if ((await tmux(['has-session', '-t', `=${session}`])).ok) continue;
      const now = readJson(file);
      if (!same(now)) continue;
      writeJson(file, { ...now, state: 'stopped', ports: (now.ports || []).map(({ host: _h, checkedAt: _c, ...p }) => ({ ...p, healthy: false })), updatedAt: nowIso() });
      changed.push(name.replace(/\.json$/, ''));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(IN_PROGRESS, s.state)) continue;
    const has = await tmux(['has-session', '-t', `=${session}`]);
    if (has.ok) {
      const panes = await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_name} #{pane_dead}']);
      if (panes.ok && panes.stdout.split('\n').some(l => l.startsWith('up ') && l.trim().endsWith('0'))) continue;
    }
    // Re-read: the chain may have settled while tmux was asked.
    const now = readJson(file);
    if (!same(now)) continue;
    const error = "interrupted: the chain's window is gone (termag-env up runs it again)";
    const step = IN_PROGRESS[s.state];
    const next = { ...now, state: 'failed', updatedAt: nowIso() };
    if (step) next[step] = phase('failed', { ...(now[step] && now[step].startedAt ? { startedAt: now[step].startedAt } : {}), finishedAt: nowIso(), error });
    else next.warnings = [...(now.warnings || []), error];
    writeJson(file, next);
    changed.push(name.replace(/\.json$/, ''));
  }
  return changed;
}

/** The agent's log line for an environment-up answer (agent.js). */
function environmentUpLogLine(r) {
  if (r.error) return r.error;
  if (r.started) return `started in ${r.session}`;
  if (r.running) return 'already running';
  if (r.held) return `held (${r.held}): termag-env up runs it`;
  return `skipped (${r.skipped})`;
}

/** Sends a project's environment state to the orchestrator each time it changes (environment-file.js frameFromEnvState). */
function createEnvForwarder({ readNames, readFile, send, isOpen }) {
  const last = new Map();
  return {
    tick() {
      if (!isOpen()) return false;
      let names;
      try { names = readNames(); } catch { return false; }
      let sent = false;
      for (const name of names) {
        // The state files only: not a window's exit (<key>.run-N.json) or its commands (<key>.exec.json).
        if (!/^[a-z0-9-]+\.json$/.test(name)) continue;
        let frame;
        let parsed;
        try { parsed = JSON.parse(readFile(name)); frame = frameFromEnvState(parsed); } catch { continue; }
        if (!frame) continue;
        // An environment pool's failed prepare carries its setup log's tail: the environment's page shows it, and no
        // owner exists to run termag-env status. setup never has secrets, and tokens are redacted all the same.
        if (parsed.projectId === POOL_PROJECT && frame.status.state === 'failed') {
          let log = '';
          try { log = readFile(`${String(parsed.key || name.replace(/\.json$/, ''))}/setup.log`); } catch { /* none yet */ }
          frame.status.log = redactSecrets(String(log).slice(-4000));
        }
        // Not a new frame when only the check times moved: the health wait saves every probe (Bugbot, #998).
        const { updatedAt: _u, ...rest } = frame.status;
        const body = JSON.stringify({ ...frame, status: { ...rest, ports: (rest.ports || []).map(({ checkedAt: _c, ...p }) => p) } });
        if (last.get(name) === body) continue;
        send(frame);
        last.set(name, body);
        sent = true;
      }
      return sent;
    },
  };
}

module.exports = {
  CAPABILITIES, handleEnvironmentUp, createEnvForwarder, environmentNotice, reconcileInterrupted, environmentUpLogLine, windowEnv,
  stopEnvironment, HEALTH_TIMEOUT_S, adoptPoolState, checkoutHeads, movedSince, stateDir, statePath, sessionName, locate, loadPlan, whereFrom, chain, startChain, probePort, describeState, parseArgs, runCommand,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { if (typeof code === 'number') process.exit(code); }, (err) => {
    process.stderr.write(`termag-env: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
