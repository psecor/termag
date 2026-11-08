'use strict';
// Tool updates, the agent's side (phase 2).
// The update itself is the component's recipe, run by
// its systemd template unit with the run id as the instance name (Claude
// Code: deploy/termag-claude-update --run <id>, from
// termag-claude-update@.service; Codex: deploy/termag-codex-update, from
// termag-codex-update@.service; the Cursor agent: deploy/termag-cursor-update,
// from termag-cursor-update@.service; the Devin CLI: deploy/termag-devin-update,
// from termag-devin-update@.service; pi: deploy/termag-pi-update, from
// termag-pi-update@.service; the GitHub CLI: deploy/termag-gh-update, as root,
// from the system unit termag-gh-update@.service; the AWS CLI v2:
// deploy/termag-aws-update, as root, from termag-aws-update@.service; Node:
// deploy/termag-node-update, from termag-node-update@.service; Python:
// deploy/termag-python-update, from termag-python-update@.service; Docker:
// deploy/termag-docker-update, as root, from the system unit
// termag-docker-update.service at the box's start, never from this RPC).
// This module only starts that unit when the orchestrator asks (the
// `tool-update {component, run}` RPC), and says whether this box can.
//
// No version, target or command crosses the RPC: the recipe fetches its own
// policy from the orchestrator with the agent token, so the inventory's rule
// (never a remote-execution channel) holds. The
// component is a key of a fixed table and the run an id that cannot carry
// anything a shell or systemd would read, so the unit name is built from
// nothing the orchestrator chose beyond those.
//
// Kept apart from agent.js so it can be tested with a fake execFile, like
// box-update.js: the agent has no hot reload and runs on many boxes at once.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPABILITIES = ['tool-update-v1'];

/**
 * Each updatable tool and the template unit its run starts. A later tool adds
 * a row here and in COMPONENT_CAPABILITIES (and its recipe and unit in
 * deploy/, and its registry entry on the orchestrator,
 * backend/src/services/toolUpdate/components.ts, whose `capability` is the
 * same string).
 */
const TOOL_UNITS = Object.freeze({
  claude: 'termag-claude-update@.service',
  codex: 'termag-codex-update@.service',
  cursor: 'termag-cursor-update@.service',
  devin: 'termag-devin-update@.service',
  pi: 'termag-pi-update@.service',
  gh: 'termag-gh-update@.service',
  aws: 'termag-aws-update@.service',
  node: 'termag-node-update@.service',
  python: 'termag-python-update@.service',
  docker: 'termag-docker-update.service',
});

/**
 * The tools updated only at the box's start ("Docker:
 * an update at the box's start"): their unit is a system unit that boot runs
 * before the tool's own service, and nothing starts it on a running box. The
 * orchestrator queues their runs and never sends this RPC for them; the agent
 * announces the capability while the unit is enabled, and refuses the RPC.
 */
const AT_START = Object.freeze({ docker: true });

/**
 * What a user tool's recipe updates, under the agent user's home, beyond its
 * unit: a component is offered only where all of it is there. Python's recipe
 * updates pyenv's uv-managed CPython (packer/scripts/setup.sh), which the
 * minimal box flavor does not have (its python3 is the system's): announcing
 * the capability there would let the sweep queue floor runs that can only
 * fail. The files are not enough for Python: COMPONENT_CHECKS.python checks
 * the layout too.
 */
const COMPONENT_REQUIRES = Object.freeze({
  python: ['.pyenv/bin/pyenv', '.local/bin/uv'],
});

/** An x.y.z, as the recipes' is_version (deploy/termag-tool-update-lib). */
const XYZ = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The environment deploy/termag-python-update runs uv and pyenv in, built from
 * the agent's own (both are children of the user's systemd): every UV_
 * variable gone, and PYTHONPATH, PYTHONHOME, PYTHONSTARTUP, PYTHONUSERBASE and
 * PYENV_VERSION (the recipe's `compgen -e` loop and `unset`), ~/.local/bin
 * first on PATH and the system's last (its `PATH=`), PYENV_ROOT defaulted to
 * ~/.pyenv. HOME, XDG_DATA_HOME and the rest are kept, as the recipe keeps
 * them. Change one, change the other.
 */
const RECIPE_UNSET = ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYENV_VERSION'];
function pythonRecipeEnv(env, home) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith('UV_') || RECIPE_UNSET.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  out.HOME = home;
  out.PATH = `${path.join(home, '.local/bin')}:${out.PATH || ''}:/usr/local/bin:/usr/bin:/bin`;
  out.PYENV_ROOT = out.PYENV_ROOT || path.join(home, '.pyenv');
  return out;
}

/**
 * Whether Python's recipe can work on this box's layout: the same checks
 * deploy/termag-python-update makes before it installs anything, asked the
 * same way (keep them the same: pyenv_global_name / pyenv_global, then the
 * `case "$OLD_PREFIX"` on `uvc 20 python dir`):
 *   - pyenv's global, the first line `$PYENV_ROOT/bin/pyenv global` prints
 *     (pyenv reads `version`, then `global`, then `default` under PYENV_ROOT,
 *     else says `system`), is an x.y.z. The images baked before 2026-09-30
 *     (c7527b495) set the bare minor `3.13` on a CPython pyenv built.
 *   - $PYENV_ROOT/versions/<x.y.z> resolves (realpath) to a
 *     `cpython-<x.y.z>-…` directory right in uv's Python install directory,
 *     the one `uv python dir --no-config` names in the recipe's environment
 *     (pythonRecipeEnv: no UV_PYTHON_INSTALL_DIR, so ~/.local/share/uv/python
 *     unless XDG_DATA_HOME moves it). A pyenv-built x.y.z is a directory of
 *     its own under ~/.pyenv/versions, and fails this.
 * Both run ~/.local/bin/uv: the recipe's `uv` is the first on its PATH, which
 * starts with ~/.local/bin, and COMPONENT_REQUIRES has the agent offer Python
 * only where that one exists.
 * Resolves to null when it can, else to why not. Never throws.
 */
async function pythonLayout(execFile, { home = os.homedir(), env = process.env, fsp = fs.promises } = {}) {
  try {
    const renv = pythonRecipeEnv(env, home);
    const root = renv.PYENV_ROOT;
    const opts = { env: renv, cwd: home, timeout: 5000 };
    let global;
    try {
      const { stdout } = await execFile(path.join(root, 'bin/pyenv'), ['global'], opts);
      global = String(stdout).split('\n')[0].trim();
    } catch (err) {
      return `pyenv global did not answer: ${String((err && err.code) || (err && err.message) || err).slice(0, 80)}`;
    }
    if (!XYZ.test(global)) return `pyenv global ${JSON.stringify(global.slice(0, 40))} is not an x.y.z (an image older than uv's Python, or none)`;
    const { stdout } = await execFile(path.join(home, '.local/bin/uv'), ['python', 'dir', '--no-config'], opts);
    const uvDir = String(stdout).split('\n')[0].trim();
    if (!uvDir) return 'uv python dir names no directory';
    const [real, realUv] = await Promise.all([fsp.realpath(path.join(root, 'versions', global)), fsp.realpath(uvDir)]);
    if (path.dirname(real) !== realUv) {
      const own = await fsp.realpath(path.join(root, 'versions')).catch(() => null);
      return `pyenv's ${global} is ${real}, not in uv's ${realUv}${path.dirname(real) === own ? ' (pyenv-built)' : ''}`;
    }
    // cpython-<x.y.z>-<platform>: the recipe's ${OLD_PREFIX##*/cpython-}, then ${have%%-*}.
    const m = /^cpython-([^-]+)-/.exec(path.basename(real));
    if (!m || !XYZ.test(m[1])) return `pyenv's ${global} is ${real}, not a uv CPython x.y.z`;
    return null;
  } catch (err) {
    return `could not read the layout: ${String((err && err.code) || (err && err.message) || err).slice(0, 80)}`;
  }
}

/**
 * Checks beyond COMPONENT_REQUIRES' files, for a component whose recipe works
 * only on some layouts: each resolves to null when the component can be
 * offered, else to why not (logged once at startup).
 */
const COMPONENT_CHECKS = Object.freeze({
  python: pythonLayout,
});

/**
 * The tools whose update runs as root: their unit is a system unit, and the agent starts it only
 * through the root-owned helper named here, the one command a sudoers rule
 * lets it run (deploy/termag-<tool>-update-setup installs both). The helper takes
 * the run id and nothing else; the agent never runs systemctl as root, and
 * never needs a broader sudo.
 */
const ROOT_HELPERS = Object.freeze({
  gh: '/usr/local/libexec/termag/termag-gh-update-start',
  aws: '/usr/local/libexec/termag/termag-aws-update-start',
});

/**
 * What the agent announces for each component whose unit is loaded: the
 * orchestrator sends a run of a tool only to a box that announces that
 * tool's. Claude Code's is the contract's tool-update-v1, so an orchestrator
 * that predates Codex reads this box as it always has.
 */
const COMPONENT_CAPABILITIES = Object.freeze({
  claude: CAPABILITIES[0],
  codex: 'tool-update-codex-v1',
  cursor: 'tool-update-cursor-v1',
  devin: 'tool-update-devin-v1',
  pi: 'tool-update-pi-v1',
  gh: 'tool-update-gh-v1',
  aws: 'tool-update-aws-v1',
  node: 'tool-update-node-v1',
  python: 'tool-update-python-v1',
  docker: 'tool-update-docker-v1',
});

/** The run id the orchestrator mints (a cuid fits); the backend checks the same pattern. */
const RUN_ID = /^[a-z0-9]{20,40}$/;

const isComponent = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(TOOL_UNITS, c);
const isRoot = (c) => Object.prototype.hasOwnProperty.call(ROOT_HELPERS, c);
const isAtStart = (c) => Object.prototype.hasOwnProperty.call(AT_START, c);
const isRunId = (r) => typeof r === 'string' && RUN_ID.test(r);

/** `termag-claude-update@.service` + run → `termag-claude-update@<run>.service`. */
function instanceUnit(component, run) {
  if (isAtStart(component)) return TOOL_UNITS[component];
  return TOOL_UNITS[component].replace('@.service', `@${run}.service`);
}

/**
 * The components whose template unit this user's systemd has loaded, i.e.
 * termag-reconcile has installed it from a checkout that has it. Read once at
 * startup, like the box-update unit: the agent is restarted by the box update
 * that brings the unit, so the next process sees it. Never throws.
 *
 * Asked of an instance, `<name>@probe.service`, not the template itself:
 * systemd 255 (the boxes' Ubuntu 24.04) refuses `show` on a template name
 * ("neither a valid invocation ID nor unit name"), and an instance of an
 * installed template loads (`show` starts nothing), while one of a missing
 * template is `not-found`.
 */
async function loadedComponents(execFile, { exists = fs.existsSync, home = os.homedir(), checks = COMPONENT_CHECKS, log = console.log } = {}) {
  const out = [];
  for (const component of Object.keys(TOOL_UNITS)) {
    const needs = COMPONENT_REQUIRES[component] || [];
    if (!needs.every((p) => { try { return exists(path.join(home, p)); } catch { return false; } })) continue;
    try {
      // An at-start tool's unit counts once it is enabled: boot runs it then.
      if (isAtStart(component)) {
        const { stdout } = await execFile('systemctl', ['--system', 'show', '-p', 'UnitFileState', '--value', TOOL_UNITS[component]], { timeout: 5000 });
        if (String(stdout).trim() === 'enabled') out.push(component);
        continue;
      }
      // A root tool's unit is the system manager's (which any user may ask),
      // and it counts only while sudo lets this user run its helper.
      const manager = isRoot(component) ? '--system' : '--user';
      const { stdout } = await execFile('systemctl', [manager, 'show', '-p', 'LoadState', '--value', instanceUnit(component, 'probe')], { timeout: 5000 });
      if (String(stdout).trim() !== 'loaded') continue;
      if (isRoot(component)) await execFile('sudo', ['-n', '-l', ROOT_HELPERS[component], 'probe'], { timeout: 5000 });
      if (checks[component]) {
        const why = await checks[component](execFile, { home });
        if (why) { log(`[AGENT] tool updates: ${component} not offered: ${why}`); continue; }
      }
      out.push(component);
    } catch {
      // Not loaded, or no systemd: this component is not offered.
    }
  }
  return out;
}

/**
 * The capabilities, one per component whose unit is loaded: the orchestrator
 * reads `tool-update-v1` as "a claude run can start here" and
 * `tool-update-codex-v1` as the same for Codex, and a box without the unit
 * would answer every run with "not found".
 */
function capabilities(loaded) {
  return Object.keys(TOOL_UNITS).filter((c) => loaded.includes(c)).map((c) => COMPONENT_CAPABILITIES[c]);
}

/**
 * The `tool-update` RPC: start the component's unit for this run and return
 * at once (`--no-block`; the run drains sessions for up to an hour). Throws,
 * so the agent replies `{error}`, only when the unit was not started: the
 * orchestrator reads an error as a refusal and ends the run, and a timeout as
 * "maybe started". systemd runs one instance per run id at a time, so a
 * repeated RPC for the same run joins the one already running.
 */
async function startToolUpdate(msg, execFile) {
  const component = msg && msg.component;
  const run = msg && msg.run;
  if (!isComponent(component)) throw new Error(`tool-update: unknown component ${JSON.stringify(String(component)).slice(0, 40)}`);
  if (!isRunId(run)) throw new Error('tool-update: run is not a run id');
  // Never on a running box: the orchestrator queues these for the box's next start.
  if (isAtStart(component)) throw new Error(`tool-update: ${component} is updated only when the box starts (${TOOL_UNITS[component]}); nothing started`);
  const unit = instanceUnit(component, run);
  try {
    if (isRoot(component)) await execFile('sudo', ['-n', ROOT_HELPERS[component], run], { timeout: 10_000 });
    else await execFile('systemctl', ['--user', 'start', '--no-block', unit], { timeout: 10_000 });
  } catch (err) {
    const text = String((err && (err.stderr || err.message)) || '').trim();
    const detail = text.split('\n').filter(Boolean).pop() || 'systemctl failed';
    if (/not found|could not be found|no such/i.test(detail)) {
      throw new Error(`${TOOL_UNITS[component]} is not installed on this box; run termag-reconcile from a checkout that has it`);
    }
    if (isRoot(component) && /password is required|not allowed|may not run/i.test(detail)) {
      throw new Error(`sudo does not let this user start ${TOOL_UNITS[component]}; run termag-reconcile (termag-${component}-update-setup)`);
    }
    throw new Error(`could not start ${unit}: ${detail}`);
  }
  return { started: true, unit };
}

module.exports = { AT_START, CAPABILITIES, COMPONENT_CAPABILITIES, COMPONENT_CHECKS, COMPONENT_REQUIRES, TOOL_UNITS, ROOT_HELPERS, RUN_ID, instanceUnit, loadedComponents, capabilities, pythonLayout, pythonRecipeEnv, startToolUpdate };
