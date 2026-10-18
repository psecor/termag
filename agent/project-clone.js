'use strict';

const fs = require('fs');
const path = require('path');

const CAPABILITIES = ['project-clone-v1'];
const UNIT_TEMPLATE = 'termag-project-clone@.service';
// Matches termag-on-claim.service TimeoutStartSec. A shorter wait fails the
// project while personalization can still be running.
const DEFAULT_WAIT_SECONDS = 11 * 60;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const HTTPS_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SSH_RE = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const BRANCH_RE = /^[a-zA-Z0-9_./-]+$/;
const SETTLED_CLAIM = new Set(['succeeded', 'failed', 'skipped']);

function clonesDir(home) {
  return path.join(home, '.termag', 'clones');
}

function statePath(home, projectId) {
  return path.join(clonesDir(home), `${projectId}.json`);
}

function instanceUnit(projectId) {
  return `termag-project-clone@${projectId}.service`;
}

function tempCloneDir(dir, projectId) {
  return path.join(path.dirname(dir), `.clone-${projectId}`);
}

function isBranchName(value) {
  if (typeof value !== 'string' || !BRANCH_RE.test(value)) return false;
  if (value.includes('..') || value.startsWith('-') || value.startsWith('/')) return false;
  return true;
}

function repoKey(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  const github = HTTPS_RE.exec(trimmed) || SSH_RE.exec(trimmed);
  if (github) return `${github[1]}/${github[2]}`.toLowerCase();
  const tail = trimmed.replace(/\.git\/?$/, '').replace(/\/$/, '');
  const parts = tail.split(/[/:]/).filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return `${owner}/${repo}`.toLowerCase();
}

function sameRepository(a, b) {
  const left = repoKey(a);
  const right = repoKey(b);
  return Boolean(left && left === right);
}

function acceptCloneRequest(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'project-clone: empty request' };
  const { projectId, instanceId, dir, url, branch, attempt, sizeKb, referenceDir } = msg;
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return { ok: false, error: 'project-clone: projectId must be a single path segment' };
  }
  if (typeof instanceId !== 'string' || !instanceId || /[\r\n]/.test(instanceId)) {
    return { ok: false, error: 'project-clone: instanceId is required' };
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) {
    return { ok: false, error: 'project-clone: dir must be an absolute path' };
  }
  if (typeof url !== 'string' || !(HTTPS_RE.test(url) || SSH_RE.test(url))) {
    return { ok: false, error: 'project-clone: url must be a GitHub repository' };
  }
  if (branch !== 'HEAD' && !isBranchName(branch)) {
    return { ok: false, error: 'project-clone: branch must be HEAD or a branch name' };
  }
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
    return { ok: false, error: 'project-clone: attempt must be a non-negative integer' };
  }
  if (!(sizeKb === null || (typeof sizeKb === 'number' && Number.isInteger(sizeKb) && sizeKb > 0))) {
    return { ok: false, error: 'project-clone: sizeKb must be null or a positive integer' };
  }
  let ref = null;
  if (referenceDir != null && referenceDir !== '') {
    if (typeof referenceDir !== 'string' || !path.isAbsolute(referenceDir) || /[\r\n\0]/.test(referenceDir)) {
      return { ok: false, error: 'project-clone: referenceDir must be an absolute path' };
    }
    ref = referenceDir;
  }
  return {
    ok: true,
    request: { projectId, instanceId, dir, url, branch, attempt, sizeKb, referenceDir: ref },
  };
}

function pendingState(request) {
  return {
    projectId: request.projectId,
    instanceId: request.instanceId,
    attempt: request.attempt,
    dir: request.dir,
    url: request.url,
    requestedBranch: request.branch,
    sizeKb: request.sizeKb,
    referenceDir: request.referenceDir,
    status: 'pending',
  };
}

function planClone({ unitState, existing, request }) {
  const running = unitState === 'active' || unitState === 'activating';
  const same = existing
    && existing.projectId === request.projectId
    && existing.attempt === request.attempt;
  if (same && existing.status === 'ready') return { kind: 'ignore', why: 'ready' };
  if (same && existing.status === 'failed') return { kind: 'ignore', why: 'failed' };
  if (same && running) return { kind: 'ignore', why: 'running' };
  return { kind: 'start', stop: running, state: pendingState(request) };
}

function cloneWaitDecision({ brokerPresent, skipPresent, claimState, elapsedSec, waitSeconds }) {
  const githubReady = Boolean(brokerPresent || skipPresent);
  const claimSettled = claimState == null || SETTLED_CLAIM.has(claimState);
  if (githubReady && claimSettled) return 'go';
  if (elapsedSec >= waitSeconds) return 'timeout';
  return 'wait';
}

function waitFailure({ brokerPresent, skipPresent }) {
  if (!brokerPresent && !skipPresent) return 'GitHub delivery did not settle before the clone wait elapsed';
  return 'on-claim did not settle before the clone wait elapsed';
}

function diskAllows(sizeKb, freeKb) {
  if (sizeKb == null) return true;
  if (freeKb == null) return true;
  return freeKb >= sizeKb * 2;
}

function frameFromState(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.projectId !== 'string' || !state.projectId) return null;
  if (typeof state.instanceId !== 'string' || !state.instanceId) return null;
  if (typeof state.attempt !== 'number' || !Number.isInteger(state.attempt) || state.attempt < 0) return null;
  if (state.status !== 'pending' && state.status !== 'cloning' && state.status !== 'ready' && state.status !== 'failed') {
    return null;
  }
  const frame = {
    projectId: state.projectId,
    instanceId: state.instanceId,
    attempt: state.attempt,
    status: state.status,
  };
  if (state.status === 'ready') frame.branch = typeof state.branch === 'string' ? state.branch : null;
  if (state.status === 'failed') frame.error = typeof state.error === 'string' && state.error ? state.error : 'clone failed';
  return frame;
}

function createCloneForwarder({ readNames, readFile, send, isOpen }) {
  const last = new Map();
  return {
    tick() {
      if (!isOpen()) return false;
      let names;
      try { names = readNames(); } catch { return false; }
      let sent = false;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        let raw;
        try { raw = readFile(name); } catch { continue; }
        let state;
        try { state = JSON.parse(raw); } catch { continue; }
        const frame = frameFromState(state);
        if (!frame) continue;
        const body = JSON.stringify({ ...frame, type: 'project-clone-status' });
        if (last.get(name) === body) continue;
        send(JSON.parse(body));
        last.set(name, body);
        sent = true;
      }
      return sent;
    },
  };
}

function writeJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readState(home, projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(home, projectId), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function deliverySnapshot(home) {
  const broker = path.join(home, '.config', 'termag', 'github-broker');
  const skip = path.join(home, '.config', 'termag', 'github.skip');
  let claimState = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.termag', 'on-claim.status.json'), 'utf8'));
    claimState = parsed && typeof parsed.state === 'string' ? parsed.state : 'unreadable';
  } catch (err) {
    if (!err || err.code !== 'ENOENT') claimState = 'unreadable';
  }
  return {
    brokerPresent: fs.existsSync(broker),
    skipPresent: fs.existsSync(skip),
    claimState,
  };
}

function git(execFile, args, opts = {}) {
  const env = { ...process.env };
  if (!opts.keepGitconfig) env.GIT_CONFIG_GLOBAL = '/dev/null';
  return execFile('git', args, { env, maxBuffer: 16 * 1024 * 1024 });
}

// The box user's git template (termag-reconcile points it at the commit-msg
// hook that adds the Generated-by: termag trailer). Read from the real global
// config, since git() hides it from the clone itself, and passed as --template.
async function templateDir(execFile) {
  try {
    const out = await execFile('git', ['config', '--global', '--type=path', '--get', 'init.templateDir'], { env: { ...process.env } });
    const dir = String(out.stdout).trim();
    return dir && fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

function lastLine(err) {
  const text = `${err && err.stderr ? err.stderr : ''}\n${err && err.stdout ? err.stdout : ''}`;
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const line = (lines.pop() || (err && err.message) || 'clone failed')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 256);
  return line || 'clone failed';
}

async function headBranch(execFile, dir, opts) {
  try {
    const name = String((await git(execFile, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], opts)).stdout).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

async function checkoutMatches(execFile, dir, url, opts) {
  if (!fs.existsSync(dir)) return false;
  try {
    const top = String((await git(execFile, ['-C', dir, 'rev-parse', '--show-toplevel'], opts)).stdout).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(dir)) return false;
    const remote = String((await git(execFile, ['-C', dir, 'remote', 'get-url', 'origin'], opts)).stdout).trim();
    return sameRepository(remote, url);
  } catch {
    return false;
  }
}

async function usableReference(execFile, state, opts) {
  if (!state.referenceDir) return null;
  try {
    const remote = String((await git(execFile, ['-C', state.referenceDir, 'remote', 'get-url', 'origin'], opts)).stdout).trim();
    return sameRepository(remote, state.url) ? state.referenceDir : null;
  } catch {
    return null;
  }
}

async function freeKbOf(dir, execFile) {
  let probe = path.dirname(dir);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  try {
    const { stdout } = await execFile('df', ['-kP', probe], { timeout: 5000 });
    const lines = String(stdout).trim().split('\n');
    const avail = Number(lines[lines.length - 1].split(/\s+/)[3]);
    return Number.isFinite(avail) ? avail : null;
  } catch {
    return null;
  }
}

function createNewFile(dirfd, name, content) {
  if (name.includes('/') || name.includes('\0')) return false;
  const at = `/proc/self/fd/${dirfd}/${name}`;
  let existing;
  try {
    existing = fs.lstatSync(at);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existing = null;
  }
  if (existing) return false;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(at, flags, 0o644);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ELOOP') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function writeGuides(dir, slug, username, templatePath) {
  let templateRaw;
  try { templateRaw = fs.readFileSync(templatePath, 'utf8'); } catch { return; }
  const today = new Date().toISOString().slice(0, 10);
  const content = templateRaw
    .replace(/<slug>/g, slug)
    .replace(/<project name>/g, slug)
    .replace(/YYYY-MM-DD/g, today)
    .replace(/<handle>/g, username);
  const dirfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    if (!createNewFile(dirfd, 'AGENTS.md', content)) return;
    createNewFile(dirfd, 'CLAUDE.md', '@AGENTS.md\n');
  } finally {
    fs.closeSync(dirfd);
  }
}

function writeExclude(dir) {
  const info = path.join(dir, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  const file = path.join(info, 'exclude');
  const line = '/.worktrees/';
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  fs.writeFileSync(file, `${prefix}${line}\n`);
}

function save(home, state, patch) {
  const next = { ...state, ...patch };
  writeJson(statePath(home, state.projectId), next);
  return next;
}

async function runClone(projectId, opts = {}) {
  if (!ID_RE.test(projectId || '')) return 1;
  const home = opts.home || process.env.HOME || '/home';
  const execFile = opts.execFile || require('util').promisify(require('child_process').execFile);
  const waitSeconds = opts.waitSeconds ?? numberEnv('PROJECT_CLONE_WAIT_SECONDS', DEFAULT_WAIT_SECONDS);
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = opts.now || Date.now;
  let state = readState(home, projectId);
  if (!state) return 1;

  const started = now();
  let keepGitconfig = false;
  for (;;) {
    const snap = deliverySnapshot(home);
    const elapsedSec = Math.floor((now() - started) / 1000);
    const decision = cloneWaitDecision({ ...snap, elapsedSec, waitSeconds });
    if (decision === 'go') {
      // github.skip removes the system broker rewrite. The owner's gitconfig
      // is then the remaining auth path, so leave it in place.
      keepGitconfig = snap.skipPresent;
      break;
    }
    if (decision === 'timeout') {
      save(home, state, { status: 'failed', error: waitFailure(snap) });
      return 1;
    }
    await sleep(opts.pollMs ?? 1000);
  }
  const gitOpts = { keepGitconfig };

  const freeKb = await freeKbOf(state.dir, execFile);
  if (!diskAllows(state.sizeKb, freeKb)) {
    save(home, state, {
      status: 'failed',
      error: `not enough free disk for ${state.sizeKb} KiB (need ${state.sizeKb * 2} KiB)`,
    });
    return 1;
  }

  if (await checkoutMatches(execFile, state.dir, state.url, gitOpts)) {
    const branch = await headBranch(execFile, state.dir, gitOpts);
    save(home, state, { status: 'ready', branch, error: undefined });
    return 0;
  }
  if (fs.existsSync(state.dir)) {
    save(home, state, { status: 'failed', error: `clone target already exists: ${state.dir}` });
    return 1;
  }

  const temp = tempCloneDir(state.dir, state.projectId);
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  state = save(home, state, { status: 'cloning', error: undefined });

  const reference = await usableReference(execFile, state, gitOpts);
  const args = ['clone'];
  const template = await templateDir(execFile);
  if (template) args.push(`--template=${template}`);
  if (reference) args.push('--reference', reference);
  if (state.requestedBranch && state.requestedBranch !== 'HEAD') args.push('--branch', state.requestedBranch);
  args.push('--', state.url, temp);
  try {
    await git(execFile, args, gitOpts);
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    save(home, state, { status: 'failed', error: lastLine(err) });
    return 1;
  }

  writeGuides(
    temp,
    path.basename(state.dir),
    opts.username || process.env.USER || 'owner',
    opts.templatePath || path.join(__dirname, 'initial-AGENTS.md'),
  );
  writeExclude(temp);
  try {
    fs.renameSync(temp, state.dir);
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    save(home, state, { status: 'failed', error: lastLine(err) });
    return 1;
  }
  const branch = await headBranch(execFile, state.dir, gitOpts);
  save(home, state, { status: 'ready', branch, error: undefined });
  return 0;
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function unitActiveState(execFile, projectId) {
  try {
    const { stdout } = await execFile('systemctl', ['--user', 'is-active', instanceUnit(projectId)], { timeout: 5000 });
    return String(stdout).trim() || 'inactive';
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout).trim() : '';
    return stdout || 'inactive';
  }
}

async function unitTemplateLoaded(execFile) {
  try {
    const { stdout } = await execFile(
      'systemctl',
      ['--user', 'show', '-p', 'LoadState', '--value', UNIT_TEMPLATE],
      { timeout: 5000 },
    );
    return String(stdout).trim() === 'loaded';
  } catch {
    return false;
  }
}

async function handleProjectClone(msg, { execFile, home, remapPath }) {
  const accepted = acceptCloneRequest(msg);
  if (!accepted.ok) throw new Error(accepted.error);
  const request = { ...accepted.request };
  if (remapPath) {
    request.dir = remapPath(request.dir);
    if (request.referenceDir) request.referenceDir = remapPath(request.referenceDir);
  }
  if (!path.isAbsolute(request.dir) || (request.referenceDir && !path.isAbsolute(request.referenceDir))) {
    throw new Error('project-clone: dir and referenceDir must stay absolute');
  }
  const existing = readState(home, request.projectId);
  const unitState = await unitActiveState(execFile, request.projectId);
  const plan = planClone({ unitState, existing, request });
  if (plan.kind === 'ignore') return { ok: true, started: false, ignored: plan.why };
  const unit = instanceUnit(request.projectId);
  if (plan.stop) await execFile('systemctl', ['--user', 'stop', unit], { timeout: 15000 });
  writeJson(statePath(home, request.projectId), plan.state);
  fs.rmSync(tempCloneDir(request.dir, request.projectId), { recursive: true, force: true });
  try {
    await execFile('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 });
  } catch (err) {
    const detail = lastLine(err);
    if (!/not found|could not be found|no such|not loaded/i.test(detail)) {
      throw new Error(`could not reset ${unit}: ${detail}`);
    }
  }
  try {
    await execFile('systemctl', ['--user', 'start', '--no-block', unit], { timeout: 10000 });
  } catch (err) {
    const detail = lastLine(err);
    if (/not found|could not be found|no such/i.test(detail)) {
      throw new Error(`${UNIT_TEMPLATE} is not installed; run termag-reconcile from a checkout that has it`);
    }
    throw new Error(`could not start ${unit}: ${detail}`);
  }
  return { ok: true, started: true };
}

if (require.main === module) {
  const [cmd, projectId] = process.argv.slice(2);
  if (cmd !== 'run' || !projectId) {
    process.stderr.write('usage: project-clone.js run <projectId>\n');
    process.exit(2);
  }
  runClone(projectId).then(
    code => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.message ? err.message : err}\n`);
      process.exit(1);
    },
  );
}

module.exports = {
  CAPABILITIES,
  UNIT_TEMPLATE,
  acceptCloneRequest,
  planClone,
  DEFAULT_WAIT_SECONDS,
  cloneWaitDecision,
  waitFailure,
  diskAllows,
  frameFromState,
  sameRepository,
  createCloneForwarder,
  handleProjectClone,
  runClone,
  writeGuides,
  unitTemplateLoaded,
  clonesDir,
  readState,
  statePath,
};
