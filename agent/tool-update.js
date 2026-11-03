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
// deploy/termag-node-update, from termag-node-update@.service).
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
});

/** The run id the orchestrator mints (a cuid fits); the backend checks the same pattern. */
const RUN_ID = /^[a-z0-9]{20,40}$/;

const isComponent = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(TOOL_UNITS, c);
const isRoot = (c) => Object.prototype.hasOwnProperty.call(ROOT_HELPERS, c);
const isRunId = (r) => typeof r === 'string' && RUN_ID.test(r);

/** `termag-claude-update@.service` + run → `termag-claude-update@<run>.service`. */
function instanceUnit(component, run) {
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
async function loadedComponents(execFile) {
  const out = [];
  for (const component of Object.keys(TOOL_UNITS)) {
    try {
      // A root tool's unit is the system manager's (which any user may ask),
      // and it counts only while sudo lets this user run its helper.
      const manager = isRoot(component) ? '--system' : '--user';
      const { stdout } = await execFile('systemctl', [manager, 'show', '-p', 'LoadState', '--value', instanceUnit(component, 'probe')], { timeout: 5000 });
      if (String(stdout).trim() !== 'loaded') continue;
      if (isRoot(component)) await execFile('sudo', ['-n', '-l', ROOT_HELPERS[component], 'probe'], { timeout: 5000 });
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

module.exports = { CAPABILITIES, COMPONENT_CAPABILITIES, TOOL_UNITS, ROOT_HELPERS, RUN_ID, instanceUnit, loadedComponents, capabilities, startToolUpdate };
