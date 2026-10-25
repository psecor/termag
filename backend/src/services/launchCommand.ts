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
 *
 * A workstream on a model backend other than its harness's default
 * (Workflow.backend) starts there, resume and prompt
 * included. Claude Code stays `claude`, with the backend's settings as its
 * one `--settings` (the box merges the telemetry ones in: Claude Code reads
 * only the last), and `&&` so a box where the backend is not set up says why
 * rather than starting Claude Code on its default. pi starts through the
 * backend's launcher in place of plain pi.
 */

import { PROVIDERS } from '../providers/registry';
import { FIREWORKS_CAPABILITY } from './fireworksGateway';

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
  /** The termag project and workstream the pane belongs to, for the session's resource (termag.project, termag.workstream). */
  project?: string | null;
  workstream?: string | null;
  /** The workstream's model backend (Workflow.backend); null or absent = the harness's default. */
  backend?: string | null;
  /** The model to start on (Workflow.model, `--model`), checked by the caller against
   *  services/modelChoices.ts; null or absent = the backend's default. */
  model?: string | null;
  /** On a non-default backend: Claude Code's small/fast model, and the context window to give the box. */
  fastModel?: string;
  context?: number;
}

// A model id is typed into a shell: aliases (opus), Fireworks ids
// (accounts/fireworks/models/kimi-k3), Bedrock profiles (us.anthropic.…:0).
const MODEL_ARG = /^[A-Za-z0-9._:/-]{1,160}$/;

/** `--model <id>` right after the command's first word, which is the harness. */
function withModel(command: string, modelArgs: string[]): string {
  if (modelArgs.length === 0) return command;
  const [first, ...rest] = command.split(' ');
  return [first, ...modelArgs, ...rest].join(' ');
}

// What a box must advertise to start a harness on each backend.
const BACKEND_CAPABILITY: Record<string, string> = { fireworks: FIREWORKS_CAPABILITY };

// pi's launcher per backend, in place of the launch command's first word.
const PI_LAUNCHER: Record<string, string> = { fireworks: 'termag-pi-fireworks' };

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A line typed into the pane instead of an agent that cannot start, saying why. */
export function refusalLine(why: string): string {
  return `echo ${shellQuote(why)}`;
}

/**
 * The launch moved onto the workstream's backend (`final`: typed as it is, or
 * `command`: still to be wrapped for telemetry). A box that cannot run it gets
 * a line that says so rather than the default backend in disguise. Null when
 * the backend is the default, the provider cannot run on it, or the command
 * is not the provider's own.
 */
function onBackend(
  launchCommand: string, opts: LaunchOptions & { id: string | null; env: string },
): { final: string } | { command: string } | null {
  const { provider, backend, capabilities, id, env, model, fastModel, context } = opts;
  if (!backend || !provider || !(PROVIDERS[provider]?.backends ?? []).includes(backend)) return null;
  const capability = BACKEND_CAPABILITY[backend];
  if (capability && !capabilities.includes(capability)) {
    return { final: refusalLine(`termag: this box cannot run ${PROVIDERS[provider].displayName} on ${backend} yet; update it (termag-box-update), or switch this workstream back to the default backend`) };
  }
  const [first, ...rest] = launchCommand.split(' ');
  if (first !== PROVIDERS[provider].launchCommand.split(' ')[0]) return null;
  // The model, Claude Code's fast model and the window go to the box script
  // with the launch: the box keeps no model list.
  const pick = [
    ...(model && MODEL_ARG.test(model) ? ['--model', model] : []),
    ...(provider === 'claude' && fastModel && MODEL_ARG.test(fastModel) ? ['--fast', fastModel] : []),
    ...(context && Number.isInteger(context) ? ['--context', String(context)] : []),
  ];
  if (provider === 'claude') {
    const settings = [`${env}termag-credentials launch-settings --backend ${backend}`, ...pick, id ?? '-'].join(' ');
    return { final: [`termag_settings=$(${settings}) && claude --settings "$termag_settings"`, ...rest].join(' ') };
  }
  const launcher = provider === 'pi' ? PI_LAUNCHER[backend] : undefined;
  return launcher ? { command: [launcher, ...pick, ...rest].join(' ') } : null;
}

// Project and workstream names are already limited to these by their routes
// (routes/projects.ts, routes/workstreams.ts); checked again here because the
// value is typed into a shell and goes into OTEL_RESOURCE_ATTRIBUTES unescaped.
const RESOURCE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `TERMAG_PROJECT=<p> TERMAG_WORKSTREAM=<w> ` ahead of the box script, which
 * reads the two into the resource (termag-credentials telemetry-launch,
 * termag-agent-otel). Environment, not flags, so a box whose scripts predate
 * them ignores the pair rather than fail the launch. Both or neither.
 */
export function resourceEnvPrefix(project?: string | null, workstream?: string | null): string {
  if (!project || !workstream || !RESOURCE_NAME.test(project) || !RESOURCE_NAME.test(workstream)) return '';
  return `TERMAG_PROJECT=${project} TERMAG_WORKSTREAM=${workstream} `;
}

/**
 * The provider's launch (or resume) command: Claude Code's with the telemetry
 * settings (the replay it came from, the project and the workstream) on a box
 * that can print them; Cursor's, Devin's and pi's through
 * termag-agent-otel on a box that has it, with the replay id when there is
 * one. Anything else, bare. A Claude launch with neither a replay nor a
 * project stays bare too, so nothing changes for a caller that names none.
 * A non-default backend first swaps in its launcher (onBackend), and a
 * chosen model goes in as `--model` right after the harness's word.
 */
export function launchCommandFor(launchCommand: string, { replaySessionId, capabilities, provider, project, workstream, backend, model, fastModel, context }: LaunchOptions): string {
  const id = replaySessionIdFrom(replaySessionId);
  const env = resourceEnvPrefix(project, workstream);
  const modelArgs = model && MODEL_ARG.test(model) ? ['--model', model] : [];
  const bare = launchCommand === 'claude';
  const moved = onBackend(launchCommand, { replaySessionId, capabilities, provider, project, workstream, backend, model, fastModel, context, id, env });
  if (moved && 'final' in moved) return moved.final;
  launchCommand = moved ? moved.command : withModel(launchCommand, modelArgs);
  if (provider && OTEL_WRAPPED.has(provider) && capabilities.includes(AGENT_TELEMETRY_CAPABILITY)) {
    return `${env}termag-agent-otel ${provider}${id ? ` --replay ${id}` : ''} -- ${launchCommand}`;
  }
  if (!bare) return launchCommand;
  if ((!id && !env) || !capabilities.includes(TELEMETRY_REPLAY_CAPABILITY)) return launchCommand;
  // `-` stands for "no replay": an older box script reads it as a bad id and
  // prints {}, the current one adds the project and workstream alone.
  return [`claude --settings "$(${env}termag-credentials telemetry-launch ${id ?? '-'})"`, ...modelArgs].join(' ');
}
