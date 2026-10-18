'use strict';
/**
 * How the agent presents its token when it dials /termag/ws/agent.
 *
 * The token goes in an `Authorization: Bearer` header. It used to go in the
 * URL as `?token=`, which put it in every nginx and ALB request line on the
 * orchestrator. An orchestrator from before the header closes a header-only
 * upgrade with 1008 'token param required' (and newer ones never send that
 * reason), so on exactly that close the agent redials once with the token in
 * the query string, and tries the header again on its next reconnect.
 */

const LEGACY_REFUSAL = 'token param required';

function dialArgs(termagUrl, token, { tokenInQuery = false } = {}) {
  const url = new URL(termagUrl);
  url.searchParams.delete('token');
  if (tokenInQuery) {
    url.searchParams.set('token', token);
    return { url: url.toString(), options: {} };
  }
  return { url: url.toString(), options: { headers: { Authorization: `Bearer ${token}` } } };
}

function refusedForWantOfQueryToken(code, reason) {
  return code === 1008 && String(reason) === LEGACY_REFUSAL;
}

// The close code of an orchestrator that is draining for a deploy (backend
// services/orchestratorDrain.ts): another process serves behind the same
// address, so the agent redials at once instead of after its usual interval.
const DRAIN_CLOSE_CODE = 4503;
const DRAIN_REDIAL_MS = [250, 500, 1000, 2000];
const DRAIN_JITTER_MS = 500;

/**
 * How long to wait before redialling after a close. `drainCloses` counts drain
 * closes in a row: a redial the load balancer sent back to the draining
 * process is refused with the same code, so those back off, never past the
 * normal interval. A small jitter keeps a fleet from redialling in lockstep.
 */
function redialDelayMs(code, drainCloses, intervalSeconds, random = Math.random) {
  const normal = intervalSeconds * 1000;
  if (code !== DRAIN_CLOSE_CODE) return normal;
  const base = DRAIN_REDIAL_MS[Math.min(Math.max(drainCloses - 1, 0), DRAIN_REDIAL_MS.length - 1)];
  return Math.min(base + Math.floor(random() * DRAIN_JITTER_MS), normal);
}

module.exports = { dialArgs, refusedForWantOfQueryToken, redialDelayMs, LEGACY_REFUSAL, DRAIN_CLOSE_CODE };
