/**
 * The command typed into an agent pane, and what it can carry: the browser
 * session recording the launch came from (a deployment that adds a recorder
 * returns its id from frontend/src/observability.ts replaySessionId; termag
 * ships none), and, for the agents other than Claude Code, termag's telemetry.
 *
 * A browser-started Claude Code session can be filed under that recording by
 * a `termag.replay.id` resource attribute holding its id; a `--settings` key
 * outranks the user settings file termag's telemetry is merged into
 * (deploy/termag-credentials apply telemetry), so the launch types
 * `claude --settings "$(termag-credentials telemetry-launch <id>)"` and the
 * box prints the settings' resource attributes plus the id (or `{}` when
 * termag's telemetry is off there, so the launch never breaks on it). Only a
 * box whose agent advertises TELEMETRY_REPLAY_CAPABILITY has the subcommand;
 * everything else gets the bare command. A shared trace id is not on offer:
 * an interactive Claude Code session ignores an inbound TRACEPARENT by
 * design, so this is the join.
 */

export const TELEMETRY_REPLAY_CAPABILITY = 'telemetry-replay-v1';

/**
 * The box has termag-agent-otel and takes the agent-telemetry delivery
 * (services/credentialDelivery.ts). Cursor, Devin and
 * pi launches go through it there: Devin needs it for its export at
 * all, and the other two get the replay id from it. Codex is started by the
 * box's status bridge, which uses it itself.
 */
export const AGENT_TELEMETRY_CAPABILITY = 'agent-telemetry-v1';
const OTEL_WRAPPED = new Set(['cursor', 'devin', 'pi']);

// A recorder id is up to 28 base62 characters; the box script accepts
// the same range. Letters and digits only: the id is typed into a shell and
// goes into OTEL_RESOURCE_ATTRIBUTES unescaped.
const REPLAY_SESSION_ID = /^[A-Za-z0-9]{20,64}$/;

/** The replay id a request carried, or null for anything that is not one. */
export function replaySessionIdFrom(value: unknown): string | null {
  return typeof value === 'string' && REPLAY_SESSION_ID.test(value) ? value : null;
}

export interface LaunchOptions {
  /** The replay the launch came from (replaySessionIdFrom), if any. */
  replaySessionId?: string | null;
  /** The box agent's advertised capabilities. */
  capabilities: string[];
  /** The registry id of the provider whose command this is. */
  provider?: string;
}

/**
 * The provider's launch (or resume) command: Claude Code's with the replay
 * settings when it came from a browser and lands on a box that can print
 * them; Cursor's, Devin's and pi's through termag-agent-otel on a box
 * that has it, with the replay id when there is one. Anything else, bare.
 */
export function launchCommandFor(launchCommand: string, { replaySessionId, capabilities, provider }: LaunchOptions): string {
  const id = replaySessionIdFrom(replaySessionId);
  if (provider && OTEL_WRAPPED.has(provider) && capabilities.includes(AGENT_TELEMETRY_CAPABILITY)) {
    return `termag-agent-otel ${provider}${id ? ` --replay ${id}` : ''} -- ${launchCommand}`;
  }
  if (launchCommand !== 'claude') return launchCommand;
  if (!id || !capabilities.includes(TELEMETRY_REPLAY_CAPABILITY)) return launchCommand;
  return `claude --settings "$(termag-credentials telemetry-launch ${id})"`;
}
