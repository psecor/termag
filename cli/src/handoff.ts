import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { confirmOrRefuse, resolveProject } from './lifecycle.js';
import { json } from './output.js';

/**
 * `termag handoff <box>/<project>[@<workstream>]`:
 * the agent writes a handoff for the next agent, then its context is cleared
 * or compacted in place or the pane restarts (on another agent with --agent),
 * and the next agent starts on the handoff. The orchestrator does all of it
 * once the agent is at its prompt; --wait follows it to the end.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 3_000;
// Longer than the backend's own timeouts (30 min to be idle, 10 to write, 10 to reset), so --wait sees how it ended.
const WAIT_S = 60 * 60;
const MODES = ['clear', 'compact', 'restart'] as const;
const OPEN = new Set(['requested', 'writing', 'written', 'resetting']);
const REF_RE = /^[^/@\s]+\/[^/@\s]+(@[A-Za-z0-9_-]+)?$/;

export const HANDOFF_COMMANDS: Record<string, CommandSpec> = {
  handoff: {
    summary: 'Hand an agent off: it writes a handoff, then its context is cleared or compacted, or the pane restarts, and the next agent starts on it',
    usage: 'termag handoff <box>/<project>[@<workstream>] [--mode clear|compact|restart] [--agent <agent>] [--note <text>] [--wait [--timeout <seconds>]] [--yes]',
    options: {
      mode: { type: 'string' },
      agent: { type: 'string' },
      note: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
    },
    maxArgs: 1,
  },
};

interface HandoffView {
  id: string;
  mode: string;
  requestedMode: string;
  fromProvider: string;
  toProvider: string | null;
  state: string;
  reason: string | null;
}

const STATE_LABEL: Record<string, string> = {
  requested: 'waiting for the agent to finish its turn',
  writing: 'the agent is writing its handoff',
  written: 'handoff saved; waiting for the agent to be at its prompt',
  resetting: 'resetting the pane',
  done: 'done: the next agent is starting on the handoff',
  failed: 'failed',
  aborted: 'aborted',
};

function whatHappens(h: HandoffView): string {
  if (h.mode === 'restart') return `restart${h.toProvider ? ` on ${h.toProvider}` : ''}`;
  return h.mode;
}

async function follow(ctx: Ctx, api: Api, h: HandoffView, timeoutS: number, quiet: boolean): Promise<HandoffView> {
  const deadline = Date.now() + timeoutS * 1000;
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_MS;
  let current = h;
  let last = '';
  for (;;) {
    if (!quiet && current.state !== last) ctx.err(`${STATE_LABEL[current.state] ?? current.state}${current.reason && !OPEN.has(current.state) ? `: ${current.reason}` : ''}`);
    last = current.state;
    if (!OPEN.has(current.state)) return current;
    if (Date.now() >= deadline) throw new CliError('timeout', `Timed out waiting for handoff ${h.id} (it is ${current.state}); it carries on without you`);
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    current = await api.request<HandoffView>('GET', `/handoffs/${encodeURIComponent(h.id)}`);
  }
}

async function cmdHandoff(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = args.args[0];
  if (!ref) throw usage(`Missing <box>/<project>. Usage: ${HANDOFF_COMMANDS.handoff.usage}`);
  if (!REF_RE.test(ref)) throw usage(`"${ref}" is not <box>/<project> or <box>/<project>@<workstream>`);
  const [projectRef, workstream = 'main'] = ref.split('@');
  const mode = args.options.mode ?? (args.options.agent ? 'restart' : 'clear');
  if (typeof mode !== 'string' || !MODES.includes(mode as typeof MODES[number])) throw usage(`--mode takes ${MODES.join(', ')}`);
  if (args.options.agent !== undefined && mode !== 'restart') throw usage('--agent starts another agent, which only --mode restart does');
  const timeoutRaw = args.options.timeout;
  if (timeoutRaw !== undefined && !args.options.wait) throw usage('--timeout limits --wait, which was not given');
  const timeoutS = timeoutRaw === undefined ? WAIT_S : Number(timeoutRaw);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw usage('--timeout takes a number of seconds');

  const api = await authedApi(ctx, session(ctx, args), { timeoutMs: REQUEST_TIMEOUT_MS });
  const project = await resolveProject(api, projectRef);
  if (!project.workstreams.includes(workstream)) {
    throw new CliError('not_found', `No workstream "${workstream}" in ${project.ref} (it has ${project.workstreams.join(', ')})`);
  }
  const where = workstream === 'main' ? project.ref : `${project.ref}@${workstream}`;
  await confirmOrRefuse(ctx, args, `Hand off the agent in ${where} (${mode}${args.options.agent ? ` on ${args.options.agent}` : ''})?`);

  const body = {
    mode, workstream, surface: 'cli',
    ...(typeof args.options.agent === 'string' ? { provider: args.options.agent } : {}),
    ...(typeof args.options.note === 'string' ? { note: args.options.note } : {}),
  };
  let started: { handoff: HandoffView; note?: string };
  try {
    started = await api.request<{ handoff: HandoffView; note?: string }>('POST', `/projects/${encodeURIComponent(project.id)}/handoff`, body);
  } catch (err) {
    // One is already under way for this agent: with --wait, follow that one.
    const openId = err instanceof CliError && err.body?.code === 'handoff_open' ? err.body.handoffId : undefined;
    if (!args.options.wait || typeof openId !== 'string') throw err;
    if (!args.json) ctx.err(`A handoff of ${where} is already under way (${openId}); following it.`);
    started = { handoff: await api.request<HandoffView>('GET', `/handoffs/${encodeURIComponent(openId)}`) };
  }
  let h = started.handoff;
  if (!args.json && h.state === 'requested') {
    ctx.out(`Handing off ${where} (${whatHappens(h)}, handoff ${h.id}): when its turn ends the agent writes a handoff, then the pane is reset and the next agent starts on it.`);
    if (started.note) ctx.out(`Note: ${started.note}`);
  }
  if (args.options.wait) h = await follow(ctx, api, h, timeoutS, !!args.json);
  if (args.json) ctx.out(json({ handoff: h, ...(started.note ? { note: started.note } : {}) }));
  if (h.state === 'failed' || h.state === 'aborted') {
    throw new CliError('failed', `Handoff ${h.id} ${h.state}${h.reason ? `: ${h.reason}` : ''}`);
  }
  return EXIT.OK;
}

export const HANDOFF_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  handoff: cmdHandoff,
};
