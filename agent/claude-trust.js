'use strict';
/**
 * The `claude-trust-folder` RPC: accept Claude Code's folder-trust prompt
 * ("Is this a project you trust?") for one directory ahead of a launch, by
 * setting `projects[<dir>].hasTrustDialogAccepted` in Claude Code's global
 * config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`).
 *
 * A spawned agent's new project would otherwise sit at that prompt with its
 * brief unread. The backend says which check the folder must pass (`check`)
 * (services/agentSpawn.ts spawnFolderTrust), and this checks the folder that
 * is actually on disk before writing, because the trust bit makes Claude Code
 * run the folder's hooks, .mcp.json servers and settings at start:
 *   - "empty": nothing but what termag seeds a new project with (.git,
 *     AGENTS.md, CLAUDE.md), so there is no startup config to run;
 *   - "owner": the owner ticked trust for the project, and the folder is the
 *     project's own tree as the chat runner judges it (checkoutOwnTree: not a
 *     pull request, not a fork, upstream in the project's repository).
 * Anything else is refused and the prompt stays.
 *
 * Claude Code rewrites this file itself, so the write is a read-modify-rename:
 * a reader never sees half a file, and every other key is kept as read. It
 * also holds ~/.config/termag/claude-json.lock, the flock termag-credentials
 * and termag-reconcile take for their own writes of the file, so none of the
 * three writes over another (without flock(1), as on macOS, unlocked, as they are).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const CAPABILITIES = ['claude-trust-folder-v1'];

/** Where Claude Code keeps its global config for this user. */
function claudeConfigPath(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
}

/**
 * The keys Claude Code may look the folder up by: the path as given and, when
 * it is a symlink (gotcha: project dirs may be symlinks), its real path, which
 * is what a process started in it sees as its cwd.
 */
function trustKeys(dir) {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || /[\r\n]/.test(dir)) throw new Error('path required');
  if (!path.isAbsolute(dir)) throw new Error('path must be absolute');
  const given = path.normalize(dir).replace(/\/+$/, '') || '/';
  const st = fs.statSync(given);
  if (!st.isDirectory()) throw new Error('path is not a directory');
  const real = fs.realpathSync(given);
  return real === given ? [given] : [given, real];
}

/** What termag writes into a new project (agent.js initWiki, git-repo.js): nothing Claude Code runs. */
const SEED_ENTRIES = new Set(['.git', 'AGENTS.md', 'CLAUDE.md']);

/** Throws unless `dir` holds only termag's seed files. */
function assertSeedOnly(dir) {
  const extra = fs.readdirSync(dir).filter((e) => !SEED_ENTRIES.has(e));
  if (extra.length) throw new Error(`not an empty project: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`);
}

/**
 * Mark `dir` trusted once it passes `check` ("empty" or "owner"). Returns
 * whether anything changed (false when already trusted). `ownTree(dir)`
 * resolves whether the folder is the project's own tree (the chat runner's
 * readCheckoutFacts + checkoutOwnTree); agent.js passes it in.
 */
async function trustFolder(dir, { check, ownTree, configPath = claudeConfigPath(), write = lockedWrite } = {}) {
  const keys = trustKeys(dir);
  if (check === 'empty') assertSeedOnly(keys[keys.length - 1]);
  else if (check === 'owner') {
    if (typeof ownTree !== 'function' || !(await ownTree(keys[keys.length - 1]))) throw new Error('not the project\'s own tree (a pull request, a fork, or another upstream)');
  } else throw new Error('check must be "empty" or "owner"');
  return write(configPath, keys);
}

/** The lock the other ~/.claude.json writers hold (deploy/termag-credentials MCP_LOCK). */
function lockPath(home = os.homedir()) {
  return path.join(home, '.config', 'termag', 'claude-json.lock');
}

/** writeTrust under the shared flock, by re-running this file under flock(1); unlocked without it. */
async function lockedWrite(configPath, keys, { lock = lockPath(), exec = promisify(execFile) } = {}) {
  let out;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    // Async: waiting up to 30 s on the lock must not stall the agent's other panes and RPCs.
    ({ stdout: out } = await exec('flock', ['-w', '30', lock, process.execPath, __filename, '--write', configPath, JSON.stringify(keys)], { encoding: 'utf8', timeout: 40_000 }));
  } catch (err) {
    if (err.code === 'ENOENT') return writeTrust(configPath, keys);
    const why = String(err.stderr || '').trim() || (err.code === 1 ? 'another termag write held claude-json.lock too long' : err.message);
    throw new Error(`could not mark the folder trusted: ${why}`);
  }
  return out.trim() === 'changed';
}

/** Set hasTrustDialogAccepted for `keys` in the config. Returns whether it wrote. */
function writeTrust(configPath, keys) {
  let config = {};
  let mode = 0o600;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    mode = fs.statSync(configPath).mode & 0o777;
    // An unreadable config is Claude Code's to repair; overwriting it would lose the user's settings.
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${configPath}: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${configPath} is not a JSON object`);
  const projects = config.projects && typeof config.projects === 'object' ? config.projects : {};
  let changed = false;
  for (const k of keys) {
    const entry = projects[k] && typeof projects[k] === 'object' ? projects[k] : {};
    if (entry.hasTrustDialogAccepted === true) continue;
    projects[k] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return false;
  config.projects = projects;
  const tmp = `${configPath}.termag-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

// `node claude-trust.js --write <config> <keys-json>`: the write, run by lockedWrite under flock(1).
if (require.main === module && process.argv[2] === '--write') {
  try {
    process.stdout.write(writeTrust(process.argv[3], JSON.parse(process.argv[4])) ? 'changed\n' : 'unchanged\n');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { CAPABILITIES, SEED_ENTRIES, claudeConfigPath, trustKeys, trustFolder, lockPath, lockedWrite, writeTrust };
