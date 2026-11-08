'use strict';

// A repository's environment file, as the box reads it:
// `setup`, `run`, `seed`, `ports` and `secrets`. `resources`
// and `base` are the orchestrator's, read from GitHub when a box is made
// (backend services/repoEnvironment.ts); this side reads the file in the
// checkout, the code the steps run against. Pure: no exec, no network. Nothing
// here throws on the file's content: what it can't use is left out with a
// warning, as the orchestrator does for `resources`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = '.termag/environment.json';
const MAX_BYTES = 16 * 1024;
const MAX_PORTS = 8;
const MAX_COMMAND = 4096;
// `stop`: run by termag-env down before it closes the session (plan-outbox #47).
const STEPS = ['setup', 'run', 'seed', 'stop'];
// Phase 5 of the design (per-workstream slots); named so a file written for
// later says why it changes nothing yet.
const NOT_YET = ['slots', 'envFile', 'host'];
// An `env` name: a shell variable's; its value is text, literal (no ${slot} or secret expansion).
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VALUE = 4096;
// The schema's pattern for a name (docs/environment.schema.json, "secrets"), with a length cap.
const SECRET_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const URL_PATH_RE = /^\/[\x21-\x7e]{0,511}$/;
const HTTPS_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const SSH_RE = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
const SLUG_RE = /^([\w.-]+)\/([\w.-]+)$/;

/** owner/name in lower case, for a slug, an https or an ssh GitHub URL; else null. */
function repoKey(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = HTTPS_RE.exec(s) || SSH_RE.exec(s) || SLUG_RE.exec(s);
  // '.' and '..' are no GitHub owner or name, and a name becomes a directory under a multi-repo root
  // (checkoutOf): never one that leaves it (Security Agent, #998).
  if (!m || [m[1], m[2]].some(part => part === '.' || part === '..')) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

function describe(value) {
  const text = JSON.stringify(value);
  return text && text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** A repository's checkout: found by its origin, else at its `path` (or its name) under a multi-repo root. */
function checkoutOf(repo, ctx) {
  if (ctx.checkouts && ctx.checkouts[repo]) return ctx.checkouts[repo];
  const entry = ctx.repos && ctx.repos.find(r => r.repo === repo);
  if (entry && ctx.root && ctx.multi) {
    const name = entry.path || repo.split('/')[1];
    // Only a directory directly under the root, never '.' or '..' (Security Agent, #998).
    if (!name || name === '.' || name === '..' || name.includes('/')) return undefined;
    const dir = path.join(ctx.root, name);
    return (ctx.existsSync || fs.existsSync)(dir) ? dir : undefined;
  }
  return undefined;
}

/** The file's `repos`: [{ repo, branch?, path? }], each repo owner/name in lower case. */
function parseRepos(value, warnings) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    warnings.push(`"repos" is ${describe(value)}, not a list, so it was left out`);
    return null;
  }
  const out = [];
  for (const [i, r] of value.entries()) {
    const repo = repoKey(r && typeof r === 'object' ? r.repo : r);
    if (!repo) { warnings.push(`repos[${i}] is ${describe(r)}, not { "repo": "owner/name" }, so it was left out`); continue; }
    if (out.some(o => o.repo === repo)) continue;
    const p = r && typeof r === 'object' && typeof r.path === 'string' && /^[\w.-]+$/.test(r.path) && r.path !== '.' && r.path !== '..' ? r.path : null;
    out.push({ repo, ...(p ? { path: p } : {}), ...(r && typeof r.branch === 'string' ? { branch: r.branch } : {}) });
  }
  return out;
}

/**
 * One step key as the entries to run: a string runs in the file's repository;
 * a map runs each entry in its repository's checkout, in the order written.
 */
function parseStep(key, value, ctx, warnings) {
  if (value === undefined || value === null) return [];
  const one = (repo, dir, command, label) => {
    if (typeof command !== 'string' || !command.trim()) {
      warnings.push(`"${label}" is ${describe(command)}, not a command, so it was left out`);
      return null;
    }
    if (command.length > MAX_COMMAND) {
      warnings.push(`"${label}" is over ${MAX_COMMAND} characters, so it was left out`);
      return null;
    }
    return { repo, dir, command };
  };
  if (typeof value === 'string') {
    if (!ctx.fileDir) {
      warnings.push(`"${key}" has no checkout to run in (the file names no repository this project has), so it was left out`);
      return [];
    }
    const entry = one(ctx.fileRepo, ctx.fileDir, value, key);
    return entry ? [entry] : [];
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`"${key}" is ${describe(value)}, not a command or a map of repository to command, so it was left out`);
    return [];
  }
  const out = [];
  for (const [name, command] of Object.entries(value)) {
    const repo = repoKey(name);
    // The file's `repos` (and a pointer's own repository) name what a map may; a file with none, its checkouts.
    const named = !ctx.repos || (repo && ctx.repos.some(r => r.repo === repo));
    const dir = named && repo ? checkoutOf(repo, ctx) : undefined;
    if (!dir) {
      warnings.push(`"${key}" names ${name}, which is not one of this environment's ${ctx.repos ? 'repositories' : 'checkouts'}, so it was skipped`);
      continue;
    }
    const entry = one(repo, dir, command, `${key}.${name}`);
    if (entry) out.push(entry);
  }
  return out;
}

function parsePort(value, index, warnings) {
  const where = `ports[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${where} is ${describe(value)}, not { "port": <number> }, so it was left out`);
    return null;
  }
  const { port, name, health, path: at } = value;
  if (port && typeof port === 'object') {
    warnings.push(`${where}: a port per slot ({ "base", "step" }) needs "slots", which termag does not use yet, so it was left out`);
    return null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`${where}: "port" is ${describe(port)}, not a whole number from 1 to 65535, so it was left out`);
    return null;
  }
  for (const [k, v] of [['health', health], ['path', at]]) {
    if (v !== undefined && v !== null && (typeof v !== 'string' || !URL_PATH_RE.test(v))) {
      warnings.push(`${where}: "${k}" is ${describe(v)}; it must start with / , so the port was left out`);
      return null;
    }
  }
  return {
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : `port ${port}`,
    port,
    health: typeof health === 'string' ? health : null,
    path: typeof at === 'string' ? at : '/',
  };
}

/**
 * The file's steps for the checkouts named in `ctx`:
 *   { fileRepo, fileDir, checkouts: { 'owner/name': dir }, root?, multi? }
 * → { repos, setup, run, seed: [{ repo, dir, command }], ports, secrets, warnings }.
 * `repos` is the file's own list (an environment's);
 * with one, a map step may name only those (and a pointer's own repository,
 * `fileRepo`), and a string step without a file repository (an inline file)
 * runs in the first of them.
 */
function parseEnvironmentFile(text, ctx, where = DEFAULT_PATH) {
  const empty = { repos: null, env: {}, setup: [], run: [], seed: [], stop: [], ports: [], secrets: [], warnings: [] };
  let data;
  try { data = JSON.parse(text); } catch {
    return { ...empty, warnings: [`${where} is not valid JSON, so it was ignored`] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...empty, warnings: [`${where} is not a JSON object, so it was ignored`] };
  }
  const warnings = [];
  const out = { ...empty, warnings };
  out.repos = parseRepos(data.repos, warnings);
  let stepCtx = ctx;
  if (out.repos) {
    const repos = ctx.fileRepo && !out.repos.some(r => r.repo === ctx.fileRepo) ? [{ repo: ctx.fileRepo }, ...out.repos] : out.repos;
    stepCtx = { ...ctx, repos };
    if (!ctx.fileDir && repos.length) stepCtx.fileDir = checkoutOf(repos[0].repo, stepCtx) || null;
    if (!ctx.fileRepo && repos.length) stepCtx.fileRepo = repos[0].repo;
  }
  for (const key of STEPS) out[key] = parseStep(key, data[key], stepCtx, warnings);

  if (data.ports !== undefined) {
    if (!Array.isArray(data.ports)) {
      warnings.push(`"ports" is ${describe(data.ports)}, not a list, so it was left out`);
    } else {
      const seen = new Set();
      for (const [i, p] of data.ports.entries()) {
        const port = parsePort(p, i, warnings);
        if (!port || seen.has(port.port)) continue;
        if (out.ports.length >= MAX_PORTS) { warnings.push(`only the first ${MAX_PORTS} ports are used`); break; }
        seen.add(port.port);
        out.ports.push(port);
      }
    }
  }

  if (data.secrets !== undefined) {
    if (!Array.isArray(data.secrets)) {
      warnings.push(`"secrets" is ${describe(data.secrets)}, not a list of names, so it was left out`);
    } else {
      for (const name of data.secrets) {
        if (typeof name === 'string' && SECRET_RE.test(name)) { if (!out.secrets.includes(name)) out.secrets.push(name); }
        else warnings.push(`"secrets" holds ${describe(name)}, which is not a variable name (names only, never values), so it was left out`);
      }
    }
  }

  // The file's own variables, for every step (docs/environment.schema.json "env").
  if (data.env !== undefined) {
    if (!data.env || typeof data.env !== 'object' || Array.isArray(data.env)) {
      warnings.push(`"env" is ${describe(data.env)}, not a map of names to text, so it was left out`);
    } else {
      for (const [name, value] of Object.entries(data.env)) {
        if (!ENV_NAME_RE.test(name)) { warnings.push(`env ${JSON.stringify(name)} is not a variable name, so it was left out`); continue; }
        if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) { warnings.push(`env ${name} is ${typeof value === 'string' ? `over ${MAX_ENV_VALUE} characters` : describe(value)}, not text, so it was left out`); continue; }
        out.env[name] = value;
      }
    }
  }
  for (const key of NOT_YET) {
    if (data[key] !== undefined) warnings.push(`"${key}" is not used yet (per-workstream slots come later), so it was ignored`);
  }
  return out;
}

/**
 * The `secrets` names as the variables the steps get. A name already in the
 * environment the steps inherit counts as resolved. Anything else is a
 * warning, and the steps run without it.
 *   deps: { env }
 */
function resolveSecrets(names, deps) {
  const env = {};
  const resolved = [];
  const missing = [];
  const warnings = [];
  for (const name of names) {
    if (deps.env && typeof deps.env[name] === 'string' && deps.env[name] !== '') {
      resolved.push({ name, via: 'your environment' });
      continue;
    }
    missing.push(name);
    warnings.push(`${name} is not something termag delivers, so the steps run without it`);
  }
  return { env, resolved, missing, warnings };
}

/** A directory's key: its name, made safe, and a hash of its full path, for the state file and the tmux session. */
function envKey(dir) {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'checkout';
  return `${base}-${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8)}`;
}

/**
 * A checkout's git dir and the common dir holding its config: `.git` itself,
 * or for a worktree (a workstream's checkout, whose `.git` is a file
 * `gitdir: <main>/.git/worktrees/<name>`) the dir it names and that dir's
 * `commondir`. null where there is no git checkout.
 */
function gitDirs(dir, readFileSync = fs.readFileSync) {
  const dotGit = path.join(dir, '.git');
  let text = null;
  try { text = readFileSync(dotGit, 'utf8'); } catch (err) {
    if (err && err.code === 'EISDIR') return { gitDir: dotGit, commonDir: dotGit, worktree: false };
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text || '');
  if (!m) return null;
  const gitDir = path.resolve(dir, m[1]);
  let common = gitDir;
  try { common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
  return { gitDir, commonDir: common, worktree: true };
}

/** The main checkout a worktree belongs to (its common dir's parent); null for a main checkout or no checkout. */
function mainCheckoutOf(dir, readFileSync = fs.readFileSync) {
  const g = gitDirs(dir, readFileSync);
  return g && g.worktree && path.basename(g.commonDir) === '.git' ? path.dirname(g.commonDir) : null;
}

/**
 * The project a workstream's directory belongs to: `<project>/.worktrees/<ws>`
 * is a workstream of `<project>`, a single repository's worktree or a
 * multi-repo project's plain folder of them;
 * else a worktree's main checkout (mainCheckoutOf); else null.
 */
function projectRootOf(dir, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  const parent = path.dirname(dir);
  if (path.basename(parent) === '.worktrees') {
    const root = path.dirname(parent);
    if (existsSync(path.join(root, '.termag-workspace')) || existsSync(path.join(root, '.git'))) return root;
  }
  // A repository inside a multi-repo workstream: <project>/.worktrees/<ws>/<repo>, where an ask's chat runs
  // (askCwd). The project is the workspace two levels up (Bugbot, #998).
  const grand = path.dirname(parent);
  if (path.basename(grand) === '.worktrees') {
    const root = path.dirname(grand);
    if (existsSync(path.join(root, '.termag-workspace'))) return root;
  }
  return mainCheckoutOf(dir, readFileSync);
}

/**
 * The checkouts an environment's app is served from (loadPlan's result): its file's `repos` and its own
 * repository's, else every checkout found, with `dir` itself. Share preview and `up` both own ports by these
 * (browser-guest.js portOwnership; Bugbot, #998).
 */
function environmentCheckouts(loaded, dir) {
  const found = (loaded && loaded.checkouts) || {};
  const plan = loaded && loaded.plan;
  // Each found as its steps find it (checkoutOf): by origin, else at its `path` under a multi-repo root (Bugbot, #998).
  const ctx = { checkouts: found, repos: plan && plan.repos, root: loaded && loaded.root, multi: !!(loaded && loaded.multi) };
  const named = plan && plan.repos
    ? [loaded.fileRepo, ...plan.repos.map(r => r.repo)].filter(Boolean).map(r => checkoutOf(r, ctx)).filter(Boolean)
    : null;
  // A file that names its repos owns only theirs, none when none is here; only a file that names none falls back
  // to every checkout (Bugbot, #998).
  if (named && plan.repos.length) return [...new Set(named)];
  return [...new Set([dir, ...Object.values(found)])];
}

/** A port's URL: at [::1] when the box found it there alone (environment-run.js probePort), else localhost. */
function portUrl(p) {
  return `http://${p && p.host === '::1' ? '[::1]' : 'localhost'}:${p.port}${p.path || '/'}`;
}

function originOf(dir, readFileSync) {
  const g = gitDirs(dir, readFileSync);
  if (!g) return null;
  let text;
  try { text = readFileSync(path.join(g.commonDir, 'config'), 'utf8'); } catch { return null; }
  const section = /\[remote "origin"\]([^[]*)/.exec(text);
  const url = section && /^\s*url\s*=\s*(.+?)\s*$/m.exec(section[1]);
  return url ? repoKey(url[1]) : null;
}

/**
 * The checkouts under `dir`: the checkout itself, or for a multi-repo
 * project's root (not a git repository) each
 * checkout in it, by its origin's owner/name.
 */
function findCheckouts(dir, { readFileSync = fs.readFileSync, readdirSync = fs.readdirSync } = {}) {
  const own = originOf(dir, readFileSync);
  if (own) return { [own]: dir };
  const out = {};
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const sub = path.join(dir, name);
    const repo = originOf(sub, readFileSync);
    if (repo && !out[repo]) out[repo] = sub;
  }
  return out;
}

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const PHASE_STATES = new Set(['none', 'pending', 'running', 'succeeded', 'failed', 'skipped']);

function phaseOf(p) {
  if (!p || typeof p !== 'object' || !PHASE_STATES.has(p.state)) return { state: 'none' };
  const out = { state: p.state };
  for (const k of ['startedAt', 'finishedAt']) if (typeof p[k] === 'string') out[k] = p[k];
  if (Number.isFinite(p.durationMs)) out.durationMs = p.durationMs;
  if (Number.isInteger(p.exitCode)) out.exitCode = p.exitCode;
  if (typeof p.error === 'string') out.error = p.error.slice(0, 300);
  if (p.rerun === true) out.rerun = true;
  return out;
}

/**
 * The orchestrator's view of one state file (environment-run.js): phases with
 * their times, ports with their health, secret names and warnings. Commands,
 * resolved values and paths stay on the box. null for a run with no project
 * (termag-env in an ask's clone, say).
 */
function frameFromEnvState(state) {
  if (!state || typeof state !== 'object' || typeof state.projectId !== 'string' || !state.projectId) return null;
  const ports = Array.isArray(state.ports) ? state.ports.filter(p => p && Number.isInteger(p.port)).slice(0, MAX_PORTS).map(p => ({
    name: String(p.name || `port ${p.port}`).slice(0, 40),
    port: p.port,
    path: typeof p.path === 'string' ? p.path : '/',
    healthy: p.healthy === true,
    ...(p.host === '::1' ? { host: '::1' } : {}),
    ...(typeof p.checkedAt === 'string' ? { checkedAt: p.checkedAt } : {}),
  })) : [];
  const names = (list) => Array.isArray(list) ? list.filter(n => typeof n === 'string' && SECRET_RE.test(n)) : [];
  return {
    type: 'environment-status',
    projectId: state.projectId,
    ...(typeof state.instanceId === 'string' ? { instanceId: state.instanceId } : {}),
    status: {
      state: typeof state.state === 'string' ? state.state : 'none',
      ...(typeof state.file === 'string' ? { file: state.file } : {}),
      // Why it's held, and what started the chain: the card and the setup event say them (#998).
      ...(typeof state.held === 'string' && state.held ? { held: state.held.slice(0, 40) } : {}),
      ...(state.trigger === 'claim' || state.trigger === 'trust' || state.trigger === 'cli' || state.trigger === 'pool' ? { trigger: state.trigger } : {}),
      // The commit of each repository setup last succeeded at: an environment pool records it as what it prepared.
      ...(state.setupCommit && typeof state.setupCommit === 'object' ? { setupCommit: Object.fromEntries(Object.entries(state.setupCommit).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v)).slice(0, 10)) } : {}),
      // A pool box's adopted chain, so the setup event can say it ran before claim.
      ...(state.preparedByPool === true ? { preparedByPool: true } : {}),
      // An environment pool's prepare or refresh it ran for: the orchestrator counts only its own refresh's success.
      ...(typeof state.prepareId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(state.prepareId) ? { prepareId: state.prepareId } : {}),
      setup: phaseOf(state.setup),
      run: phaseOf(state.run),
      seed: phaseOf(state.seed),
      ports,
      secrets: {
        resolved: names(state.secrets && Array.isArray(state.secrets.resolved) ? state.secrets.resolved.map(r => r && r.name) : []),
        missing: names(state.secrets && state.secrets.missing),
      },
      warnings: Array.isArray(state.warnings) ? state.warnings.filter(w => typeof w === 'string').slice(0, 20).map(w => w.slice(0, 300)) : [],
      ...(typeof state.updatedAt === 'string' ? { updatedAt: state.updatedAt } : {}),
    },
  };
}

const IN_FLIGHT = new Set(['pending', 'setup', 'starting', 'waiting', 'seeding']);
// A box agent's token (tmag_) or a termag CLI token (tmcli_, `termag login`): neither ever reaches a prompt.
const TERMAG_TOKEN_RE = /(?:tmag|tmcli)_[A-Za-z0-9._-]+/g;

/** `text` with each of `values` (8 characters or more, so not a word of the text) and any termag token replaced by [redacted]. */
function redactSecrets(text, values = []) {
  let out = String(text).replace(TERMAG_TOKEN_RE, '[redacted]');
  for (const v of values || []) {
    if (typeof v === 'string' && v.length >= 8) out = out.split(v).join('[redacted]');
  }
  return out;
}
const LOG_TAIL_LINES = 15;
const LOG_TAIL_CHARS = 1500;

/**
 * What an agent's turn is told about its checkout's environment (the
 * person's decision on #998: no hold, setup runs beside the agent). While the
 * steps run, every turn: which step, how to check, and that the ports aren't
 * up yet, so it plans and does what doesn't need the app. Once they settle,
 * one line on the next turn, with the log's tail on a failure; only for a
 * session that was told they were running. `seen` is what the session was
 * told (the caller keeps it per chat): `{ text, seen }`, text null for none.
 *   opts: { now, logTail(phase) → string }
 */
const NOTICE_TAG_RE = /<(\/?)(termag-box-notice|space-memory-notice)/gi;
const MAX_TURN_NOTICE = 3000;

/**
 * A notice's text as it may enter the hidden notice block: port names, a step's error and its log are the
 * checkout's, so neither block's delimiters survive, and the notice is capped (Security Agent, #998).
 */
function noticeSafe(text) {
  const t = String(text).replace(NOTICE_TAG_RE, '&lt;$1$2');
  return t.length <= MAX_TURN_NOTICE ? t : `${t.slice(0, MAX_TURN_NOTICE - 1)}…`;
}

function turnNotice(state, seen = {}, opts = {}) {
  const r = turnNoticeText(state, seen, opts);
  return r.text ? { ...r, text: noticeSafe(r.text) } : r;
}

function turnNoticeText(state, seen = {}, opts = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const told = seen && seen.told === true;
  const ports = Array.isArray(s.ports) ? s.ports.filter(p => p && Number.isInteger(p.port)) : [];
  if (IN_FLIGHT.has(s.state)) {
    const setup = s.setup || {};
    const now = opts.now ?? Date.now();
    const started = setup.startedAt ? Date.parse(setup.startedAt) : NaN;
    const where = s.state === 'setup' || s.state === 'pending'
      ? `setup has run ${Number.isFinite(started) && now > started ? formatDuration(now - started) : 'a moment'}, then the app starts`
      : s.state === 'seeding' ? 'the app is up and seeding'
      : `setup took ${formatDuration(setup.durationMs || 0)}; the app is starting, waiting for its ports`;
    // Seeding runs once every port is healthy: none to name. Else the ones not up yet (Bugbot, #998).
    const down = s.state === 'seeding' ? [] : ports.filter(p => p.healthy !== true);
    const portText = down.length ? ` ${down.length === 1 ? 'Its port' : 'Its ports'} ${down.map(p => `${p.name} :${p.port}`).join(', ')} ${down.length === 1 ? "isn't" : "aren't"} up yet.` : '';
    return {
      text: `The environment for this checkout is still setting up: ${where}.${portText} Plan, and do the work that doesn't need it; \`termag-env status\` shows where it is.`,
      seen: { told: true },
    };
  }
  if (!told || !['up', 'ready', 'failed'].includes(s.state)) return { text: null, seen: seen || {} };
  const settled = { told: false, settled: s.updatedAt || s.state };
  if (s.state === 'failed') {
    const step = ['setup', 'run', 'seed'].find(k => s[k] && s[k].state === 'failed') || 'setup';
    const p = s[step] || {};
    const took = Number.isFinite(p.durationMs) ? ` after ${formatDuration(p.durationMs)}` : '';
    let tail = '';
    try { tail = opts.logTail ? String(opts.logTail(step) || '') : ''; } catch { tail = ''; }
    tail = tail.split('\n').slice(-LOG_TAIL_LINES).join('\n').slice(-LOG_TAIL_CHARS).trim();
    // The notice goes into the model's prompt: never a value a step was given (a delivered secret) or a termag token (Security Agent, #998).
    const redact = (text) => redactSecrets(text, opts.secretValues);
    return {
      text: redact(`The environment's ${step} failed${took}: ${p.error || 'it exited non-zero'}.${tail ? ` The end of its log:\n\`\`\`\n${tail}\n\`\`\`\n` : ' '}\`termag-env status\` shows it; fix it and \`termag-env up\` runs it again.`),
      seen: settled,
    };
  }
  const setup = s.setup && s.setup.state === 'succeeded' && Number.isFinite(s.setup.durationMs) ? `setup took ${formatDuration(s.setup.durationMs)}` : 'set up';
  return {
    text: s.state === 'up'
      ? `The environment is ready: ${setup} and the app is up${ports.length ? ` (${ports.map(p => `${p.name} ${portUrl(p)}`).join(', ')})` : ''}.`
      : `The environment is ready: ${setup}.`,
    seen: settled,
  };
}

module.exports = {
  turnNotice,
  environmentCheckouts,
  portUrl,
  mainCheckoutOf,
  projectRootOf,
  redactSecrets,
  DEFAULT_PATH,
  MAX_BYTES,
  repoKey,
  checkoutOf,
  parseEnvironmentFile,
  resolveSecrets,
  envKey,
  findCheckouts,
  formatDuration,
  frameFromEnvState,
};
