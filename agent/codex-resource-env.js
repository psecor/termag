'use strict';

// The pane's project and workstream for the Codex app server's telemetry
// resource. The orchestrator names them in the
// codex-session-start RPC, agent.js puts them in the status bridge's
// environment as TERMAG_PROJECT / TERMAG_WORKSTREAM, and termag-agent-otel,
// which the bridge starts `codex app-server` through, reads the pair onto the
// resource as termag.project / termag.workstream. The same shape the typed
// launches use ahead of the other agents' commands (backend
// services/launchCommand.ts resourceEnvPrefix): both or neither, ids only.

const RESOURCE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// A spawn's ids, as backend services/launchCommand.ts spawnEnvPrefix checks them.
const SPAWN_ID = /^[a-z0-9]{8,40}$/;
const SPAWN_KEYS = ['TERMAG_SPAWN_ID', 'TERMAG_SPAWN_ROOT', 'TERMAG_SPAWN_DEPTH',
  'TERMAG_SPAWN_PARENT_PROJECT', 'TERMAG_SPAWN_PARENT_WORKSTREAM', 'TERMAG_SPAWN_PARENT_BOX'];
const KEYS = ['TERMAG_PROJECT', 'TERMAG_WORKSTREAM', ...SPAWN_KEYS];

/**
 * A spawned workstream's TERMAG_SPAWN_* from the payload's `spawn` (the
 * orchestrator's spawnTelemetryFor), which termag-credentials work-resource
 * reads onto the resource as termag.spawn.*, as the typed launches'
 * spawnEnvPrefix does for the other agents. Each bad value is left out on its
 * own (the parent's project and workstream together), and everything without
 * a good id.
 */
function spawnEnv(spawn) {
  if (!spawn || typeof spawn !== 'object' || typeof spawn.id !== 'string' || !SPAWN_ID.test(spawn.id)) return {};
  const out = { TERMAG_SPAWN_ID: spawn.id };
  if (typeof spawn.root === 'string' && SPAWN_ID.test(spawn.root)) out.TERMAG_SPAWN_ROOT = spawn.root;
  if (Number.isInteger(spawn.depth) && spawn.depth >= 1 && spawn.depth <= 999) out.TERMAG_SPAWN_DEPTH = String(spawn.depth);
  if (typeof spawn.parentProject === 'string' && typeof spawn.parentWorkstream === 'string'
      && RESOURCE_NAME.test(spawn.parentProject) && RESOURCE_NAME.test(spawn.parentWorkstream)) {
    out.TERMAG_SPAWN_PARENT_PROJECT = spawn.parentProject;
    out.TERMAG_SPAWN_PARENT_WORKSTREAM = spawn.parentWorkstream;
  }
  if (typeof spawn.parentBox === 'string' && SPAWN_ID.test(spawn.parentBox)) out.TERMAG_SPAWN_PARENT_BOX = spawn.parentBox;
  return out;
}

/**
 * The environment pair for a codex-session-start payload: `{TERMAG_PROJECT,
 * TERMAG_WORKSTREAM}` when the payload names both and both are ids, else `{}`
 * (an older orchestrator sends neither; a bad value drops the pair, never
 * the launch), plus a spawned workstream's TERMAG_SPAWN_* (spawnEnv).
 */
function codexResourceEnv(payload) {
  const spawn = spawnEnv(payload && payload.spawn);
  const project = payload && payload.project;
  const workstream = payload && payload.workstream;
  if (typeof project !== 'string' || typeof workstream !== 'string') return spawn;
  if (!RESOURCE_NAME.test(project) || !RESOURCE_NAME.test(workstream)) return spawn;
  return { TERMAG_PROJECT: project, TERMAG_WORKSTREAM: workstream, ...spawn };
}

/** A copy of `env` without the pair or a spawn, so a session that names none inherits none. */
function withoutResourceEnv(env) {
  const out = { ...env };
  for (const key of KEYS) delete out[key];
  return out;
}

/**
 * The status bridge's environment, which the app server inherits: `env`
 * without an inherited pair, the session's own pair (codexResourceEnv), and
 * TERMAG_SESSION_KIND=interactive, the kind its resource carries, which the
 * app server's commands inherit in turn. The kind
 * replaces whatever `env` carried.
 */
function codexBridgeEnv(env, resourceEnv = {}) {
  return { ...withoutResourceEnv(env), ...resourceEnv, TERMAG_SESSION_KIND: 'interactive' };
}

module.exports = { codexResourceEnv, spawnEnv, withoutResourceEnv, codexBridgeEnv };
