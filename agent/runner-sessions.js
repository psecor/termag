'use strict';
/**
 * Claude Code cloud sessions as the box agent's scanners see them
 *. The runner's tmux session is
 * `<user>-claude-runner-s<slot>-<order>-r` (backend
 * services/claudeRunnerSpawn.ts, the order id escaped `_` -> `__`, `.` -> `_d`).
 * The runner's base dir is `~/ccr/sessions/<order>`, the Claude child runs in
 * the checkout `<base>/example-org/webapp`, and the session's Claude
 * config lives beside it under `<base>/_sessions/<cse id>.claude-config/
 * projects/`, where the transcript for that cwd sits in the directory Claude
 * names by encoding the cwd. Pure helpers; the scanner composes them with
 * tmux.
 */
const path = require('path');
const { readdir } = require('fs/promises');

/** The tmux-safe form of a unix user name, as the backend writes it (`_` -> `__`, `.` -> `_d`). */
function tmuxSafe(s) { return String(s).replace(/_/g, '__').replace(/\./g, '_d'); }

/** Is this one of this user's runner tmux sessions? */
function isRunnerSessionName(name, username) {
  if (!name || !username) return false;
  const prefix = `${tmuxSafe(username)}-claude-runner-s`;
  return name.startsWith(prefix) && /^\d+-[A-Za-z0-9][A-Za-z0-9_-]*-r$/.test(name.slice(prefix.length));
}

/** The inverse of tmuxSafe: `__` -> `_`, `_d` -> `.`, read left to right (an order id is `[A-Za-z0-9._-]`, so this is unambiguous). */
function tmuxUnsafe(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '_' && s[i + 1] === '_') { out += '_'; i++; }
    else if (s[i] === '_' && s[i + 1] === 'd') { out += '.'; i++; }
    else out += s[i];
  }
  return out;
}

/** The order id a runner session serves, from its name; null for any other session. */
function orderFromRunnerSession(name, username) {
  if (!isRunnerSessionName(name, username)) return null;
  const rest = name.slice(`${tmuxSafe(username)}-claude-runner-s`.length);
  const m = /^\d+-([A-Za-z0-9][A-Za-z0-9_-]*)-r$/.exec(rest);
  return m ? tmuxUnsafe(m[1]) : null;
}

/**
 * The runner's base dir (`--base-dir`) for an order: `<root>/sessions/<order>`
 * where the root is ~/ccr unless the wrapper was told otherwise. From the
 * NAME, not the pane's cwd: the backend starts the pane in the runner state
 * dir (~/.termag/claude-runner), and the pane's only process is the wrapper,
 * so `pane_current_path` never points at the checkout.
 */
function runnerBaseDir(home, order, root) {
  if (!order) return null;
  return path.join(root || path.join(home, 'ccr'), 'sessions', order);
}

/** The session checkout inside a base dir: where the Claude child runs, which names its transcript dir. */
function runnerCheckout(base) { return path.join(base, 'example-org', 'webapp'); }

/** Claude encodes a cwd into a project-log dir name by replacing '/' and '.' with '-'. */
const encodeClaudeDir = (p) => p.replace(/[/.]/g, '-');

/**
 * The transcript directories of a runner session: one per session config
 * under the base dir (normally one), named by the checkout's encoded path.
 * Empty when the base dir has none yet.
 */
async function runnerProjectDirs(base) {
  if (!base) return [];
  let entries;
  try { entries = await readdir(path.join(base, '_sessions')); } catch { return []; }
  const encoded = encodeClaudeDir(runnerCheckout(base));
  return entries.filter(e => e.endsWith('.claude-config')).map(e => path.join(base, '_sessions', e, 'projects', encoded));
}

module.exports = { tmuxSafe, tmuxUnsafe, isRunnerSessionName, orderFromRunnerSession, runnerBaseDir, runnerCheckout, encodeClaudeDir, runnerProjectDirs };
