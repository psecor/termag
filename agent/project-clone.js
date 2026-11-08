'use strict';

const fs = require('fs');
const path = require('path');

// project-clone-static-v1: a request may carry `staticDir`, the static layout's ~/code/<repo> for a box made from an
// environment; the answer says whether the box took it.
const STATIC_CAPABILITY = 'project-clone-static-v1';
const CAPABILITIES = ['project-clone-v1', STATIC_CAPABILITY];
const { STATIC_ROOT, STATIC_NAME_RE } = require('./static-layout');
const environmentPrepare = require('./environment-prepare');
const UNIT_TEMPLATE = 'termag-project-clone@.service';
// Matches termag-on-claim.service TimeoutStartSec. A shorter wait fails the
// project while personalization can still be running.
const DEFAULT_WAIT_SECONDS = 11 * 60;
const ID_RE = /^[A-Za-z0-9_-]+$/;
// One repository of a multi-repo project: its state
// file and unit instance are keyed <projectId>--<repo>, which ID_RE still
// accepts, so deploy/termag-project-clone runs it unchanged.
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
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

function cloneKey(projectId, repo) {
  return repo ? `${projectId}--${repo}` : projectId;
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
  if (typeof projectId !== 'string' || !ID_RE.test(projectId) || projectId.includes('--')) {
    return { ok: false, error: 'project-clone: projectId must be a single path segment' };
  }
  const repo = msg.repo == null ? null : msg.repo;
  if (repo !== null && (typeof repo !== 'string' || !REPO_RE.test(repo))) {
    return { ok: false, error: 'project-clone: repo must be a repository directory name' };
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
  let staticDir = null;
  if (msg.staticDir != null) {
    const v = msg.staticDir;
    if (typeof v !== 'string' || !path.isAbsolute(v) || /[\r\n\0]/.test(v) || path.normalize(v) !== v
      || path.basename(path.dirname(v)) !== STATIC_ROOT || !STATIC_NAME_RE.test(path.basename(v))) {
      return { ok: false, error: `project-clone: staticDir must be ~/${STATIC_ROOT}/<name>` };
    }
    staticDir = v;
  }
  return {
    ok: true,
    request: { projectId, repo, key: cloneKey(projectId, repo), instanceId, dir, url, branch, attempt, sizeKb, referenceDir: ref, staticDir },
  };
}

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** `p` with its parent's links resolved (p itself may not exist yet). */
function realIn(p) {
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}

function readlinkOr(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

/**
 * Whether this clone can take the static path `want` instead of the project directory `dir`, or why not: the clone
 * already is this project's there (a retry, the next hello), or nothing is at `want` and the project directory is
 * free or already the link to it. Anything at `want` that isn't this project's (the owner's own checkout, what
 * someone made there by hand) is never taken over: the per-project layout is kept.
 */
function staticChoice(want, dir, existing, request, home) {
  const ours = existing && existing.projectId === request.projectId && (existing.repo || null) === (request.repo || null) && existing.dir === want;
  if (ours) return { ok: true, pooled: !!existing.pooled };
  // An environment pool prepared this checkout before the box had an owner (environment-prepare.js): the project
  // takes it over in place, and the clone pulls it as the owner.
  const prepared = home ? environmentPrepare.preparedCheckout(home, want) : null;
  if (prepared && (!lexists(dir) || readlinkOr(dir) === want)) return { ok: true, pooled: true };
  if (lexists(want)) return { ok: false, why: `${want} already exists, so the project keeps its own directory (a \`path\` in the environment's repos picks another)` };
  if (lexists(dir)) {
    let link = null;
    try { link = fs.readlinkSync(dir); } catch { /* not a link */ }
    if (link !== want) return { ok: false, why: `${dir} already exists, so the project keeps it` };
  }
  return { ok: true };
}

function pendingState(request) {
  return {
    projectId: request.projectId,
    ...(request.repo ? { repo: request.repo, key: request.key } : {}),
    instanceId: request.instanceId,
    attempt: request.attempt,
    dir: request.dir,
    url: request.url,
    requestedBranch: request.branch,
    sizeKb: request.sizeKb,
    referenceDir: request.referenceDir,
    ...(request.link ? { link: request.link } : {}),
    ...(request.pooled ? { pooled: true } : {}),
    status: 'pending',
  };
}

function planClone({ unitState, existing, request }) {
  const running = unitState === 'active' || unitState === 'activating';
  const same = existing
    && existing.projectId === request.projectId
    && (existing.repo || null) === (request.repo || null)
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
  if (typeof state.repo === 'string' && REPO_RE.test(state.repo)) frame.repo = state.repo;
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

// The file is named through the directory fd, so a directory swapped for a
// link after it was opened is never written through. Without /proc (macOS,
// where only the e2e stack's stand-in boxes clone) the directory's path is
// used instead, and only while it still is the directory the fd holds.
function guidePath(dirfd, dir, name) {
  if (fs.existsSync('/proc/self/fd')) return `/proc/self/fd/${dirfd}/${name}`;
  const held = fs.fstatSync(dirfd);
  const now = fs.lstatSync(dir);
  if (!now.isDirectory() || now.dev !== held.dev || now.ino !== held.ino) return null;
  return path.join(dir, name);
}

function createNewFile(dirfd, name, content, dir) {
  if (name.includes('/') || name.includes('\0')) return false;
  const at = guidePath(dirfd, dir, name);
  if (!at) return false;
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
    if (!createNewFile(dirfd, 'AGENTS.md', content, dir)) return;
    createNewFile(dirfd, 'CLAUDE.md', '@AGENTS.md\n', dir);
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

/**
 * The static layout's link: the project's directory pointing at its checkout under ~/code. Made once the checkout is
 * in place; one already there is fine, anything else at that path is left alone and fails the clone.
 */
function ensureLink(state) {
  if (!state.link) return null;
  try {
    if (fs.readlinkSync(state.link) === state.dir) return null;
  } catch { /* not a link, or not there */ }
  if (lexists(state.link)) return `${state.link} already exists, so it can't link to ${state.dir}`;
  try {
    fs.mkdirSync(path.dirname(state.link), { recursive: true });
    fs.symlinkSync(state.dir, state.link);
  } catch (err) {
    return lastLine(err);
  }
  return null;
}

/**
 * Pull a prepared checkout: the branch asked for when it isn't the one prepared (a PR's, say) is checked out
 * instead; otherwise a fast-forward of the default branch. `{ from, to }` or `{ error }`.
 */
async function pullPrepared(execFile, state, opts) {
  const head = async () => String((await git(execFile, ['-C', state.dir, 'rev-parse', 'HEAD'], opts)).stdout).trim();
  try {
    const from = await head();
    const current = await headBranch(execFile, state.dir, opts);
    // `HEAD` (or none) is the default branch: the one the pool prepared, pulled.
    const want = state.requestedBranch && state.requestedBranch !== 'HEAD' ? state.requestedBranch : null;
    if (want && want !== current) {
      await git(execFile, ['-C', state.dir, 'fetch', '--quiet', 'origin', want], opts);
      await git(execFile, ['-C', state.dir, 'checkout', '--quiet', '-B', want, `origin/${want}`], opts);
    } else {
      await git(execFile, ['-C', state.dir, 'pull', '--quiet', '--ff-only'], opts);
    }
    return { from, to: await head() };
  } catch (err) {
    return { error: `pull the prepared checkout: ${lastLine(err)}` };
  }
}

/**
 * Start empty on a project whose directory is the static layout's link to `checkout`: removes that link, so the
 * directory made next is the project's own and nothing is written into the abandoned clone, which stays on disk.
 * Anything else at `dir` (a real directory, a link elsewhere) is left alone. Whether it removed the link.
 */
function dropStaticLink(dir, checkout) {
  let link = null;
  try { link = fs.readlinkSync(dir); } catch { return false; }
  if (link !== checkout) return false;
  fs.unlinkSync(dir);
  return true;
}

function save(home, state, patch) {
  const next = { ...state, ...patch };
  writeJson(statePath(home, state.key || state.projectId), next);
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
    const linkError = ensureLink(state);
    if (linkError) {
      save(home, state, { status: 'failed', error: linkError });
      return 1;
    }
    // A pool's prepared checkout: brought up to date once, as the owner (the broker answers with their credential
    // now), in place. termag never pulls it again.
    if (state.pooled && !state.pulled) {
      const pulled = await pullPrepared(execFile, state, gitOpts);
      if (pulled.error) {
        save(home, state, { status: 'failed', error: pulled.error });
        return 1;
      }
      environmentPrepare.markAdopted(home, state.projectId, realIn(state.dir));
      state = save(home, state, { pulled: true, pulledFrom: pulled.from, pulledTo: pulled.to });
    }
    const branch = await headBranch(execFile, state.dir, gitOpts);
    save(home, state, { status: 'ready', branch, error: undefined });
    return 0;
  }
  // The project directory is checked before anything is cloned, so a link that can't be made costs no clone.
  if (state.link && lexists(state.link)) {
    let link = null;
    try { link = fs.readlinkSync(state.link); } catch { /* not a link */ }
    if (link !== state.dir) {
      save(home, state, { status: 'failed', error: `${state.link} already exists, so it can't link to ${state.dir}` });
      return 1;
    }
  }
  if (fs.existsSync(state.dir)) {
    save(home, state, { status: 'failed', error: `clone target already exists: ${state.dir}` });
    return 1;
  }

  const temp = tempCloneDir(state.dir, state.repo || state.projectId);
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

  // A repository of a workspace project brings its own guide; the
  // workspace's is the root's (agent/workspace.js).
  if (!state.repo) writeGuides(
    temp,
    // The project's name: its directory's, which is the link in the static layout.
    path.basename(state.link || state.dir),
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
  const linkError = ensureLink(state);
  if (linkError) {
    save(home, state, { status: 'failed', error: linkError });
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

// Asked of an instance, `termag-project-clone@probe.service`, not the template:
// systemd 255 (the boxes' Ubuntu 24.04) refuses `show` on a template name ("neither
// a valid invocation ID nor unit name"), so asking the template announced nothing.
// An instance of an installed template loads (`show` starts nothing); one of a
// missing template is `not-found`. Same probe as tool-update.js.
async function unitTemplateLoaded(execFile) {
  try {
    const { stdout } = await execFile(
      'systemctl',
      ['--user', 'show', '-p', 'LoadState', '--value', instanceUnit('probe')],
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
  const existing = readState(home, request.key);
  // The static layout, when the orchestrator asks for it: clone at ~/code/<repo> and link the project directory to it.
  let layout = {};
  if (request.staticDir) {
    const want = remapPath ? remapPath(request.staticDir) : request.staticDir;
    const choice = path.isAbsolute(want) ? staticChoice(want, request.dir, existing, request, home) : { ok: false, why: 'staticDir must stay absolute' };
    if (choice.ok) {
      request.link = request.dir;
      request.dir = want;
      if (choice.pooled) request.pooled = true;
      layout = { staticLayout: true };
    } else {
      layout = { staticLayout: false, staticRefused: choice.why };
    }
  }
  delete request.staticDir;
  // A multi-repo project's repository on a box made from a pooled environment: its directory is <root>/<name>, where
  // the root links to ~/code, so it is the prepared checkout at ~/code/<name>.
  if (!request.pooled && environmentPrepare.preparedCheckout(home, realIn(request.dir))) request.pooled = true;
  const unitState = await unitActiveState(execFile, request.key);
  const plan = planClone({ unitState, existing, request });
  if (plan.kind === 'ignore') return { ok: true, started: false, ignored: plan.why, ...layout };
  const unit = instanceUnit(request.key);
  if (plan.stop) await execFile('systemctl', ['--user', 'stop', unit], { timeout: 15000 });
  writeJson(statePath(home, request.key), plan.state);
  fs.rmSync(tempCloneDir(request.dir, request.repo || request.projectId), { recursive: true, force: true });
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
  return { ok: true, started: true, ...layout };
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
  STATIC_CAPABILITY,
  dropStaticLink,
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
