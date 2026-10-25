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
const KEYS = ['TERMAG_PROJECT', 'TERMAG_WORKSTREAM'];

/**
 * The environment pair for a codex-session-start payload: `{TERMAG_PROJECT,
 * TERMAG_WORKSTREAM}` when the payload names both and both are ids, else `{}`
 * (an older orchestrator sends neither; a bad value drops the pair, never
 * the launch).
 */
function codexResourceEnv(payload) {
  const project = payload && payload.project;
  const workstream = payload && payload.workstream;
  if (typeof project !== 'string' || typeof workstream !== 'string') return {};
  if (!RESOURCE_NAME.test(project) || !RESOURCE_NAME.test(workstream)) return {};
  return { TERMAG_PROJECT: project, TERMAG_WORKSTREAM: workstream };
}

/** A copy of `env` without the pair, so a session that names none inherits none. */
function withoutResourceEnv(env) {
  const out = { ...env };
  for (const key of KEYS) delete out[key];
  return out;
}

module.exports = { codexResourceEnv, withoutResourceEnv };
