import type { CommandSpec, ParsedArgs } from './args.js';
import { agentFromEnv } from './bug.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json } from './output.js';
import { redactSecrets } from './secretPatterns.js';
import { VERSION } from './version.js';

/**
 * `termag feedback`: an agent logs what a person said
 * about termag itself, in their words, and carries on. Anyone can log; only
 * admins read it, at /admin/feedback. The same path and context as `termag bug
 * report` (bug.ts): this CLI's version, the coding agent and model when the
 * environment says, and the session's project and workstream; the
 * orchestrator adds the box and its agent. Secret-shaped strings are redacted
 * here, before anything leaves the box, and again by the orchestrator.
 */

const KINDS = ['praise', 'problem', 'idea', 'other'];
/** The orchestrator's limit; checked here so a long paste is a usage error, not a round trip. */
const MAX_BODY = 5_000;

export const FEEDBACK_COMMANDS: Record<string, CommandSpec> = {
  feedback: {
    summary: 'Log feedback about termag that a person gave: praise, a problem, an idea',
    usage: 'termag feedback [--kind praise|problem|idea|other] [--agent <agent>] [--model <model>] (<text> | - < feedback.md)',
    options: {
      kind: { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
    },
    maxArgs: 1,
    details: `The text is the person's feedback about termag, in their words: one argument, or \`-\` to read it from stdin.
Text that starts with a dash goes after \`--\`: termag feedback -- "- the sidebar is confusing".
Kinds: ${KINDS.join(', ')} (default other). At most ${MAX_BODY} characters.
The CLI version, the agent and model (from the environment, or --agent / --model) and this session's project and workstream are attached.
Secret-shaped strings (tokens, keys) are replaced with [redacted: …] before sending.
Prints the feedback's id. Only admins read feedback, at /admin/feedback.`,
  },
};

interface Logged { id: string; status: string; redacted: string[] }

async function cmdFeedback(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const o = args.options;
  const arg = args.args[0];
  if (arg === undefined) throw usage(`Give the feedback as one argument, or \`-\` to read it from stdin. Usage: ${FEEDBACK_COMMANDS.feedback.usage}`);
  let text = arg;
  if (arg === '-') {
    if (!ctx.readStdin) throw new CliError('failed', 'Cannot read stdin here');
    text = await ctx.readStdin();
  }
  text = text.trim();
  if (!text) throw usage('The feedback is empty: give what the person said about termag');
  if (text.length > MAX_BODY) throw usage(`The feedback is at most ${MAX_BODY} characters`);
  let kind: string | undefined;
  if (o.kind !== undefined) {
    kind = String(o.kind).trim();
    if (!KINDS.includes(kind)) throw usage(`--kind takes one of ${KINDS.join(', ')}`);
  }

  const agent = agentFromEnv(ctx.env);
  const redacted = redactSecrets(text);
  // A marker can be longer than the secret it replaces, and the orchestrator
  // checks the length of what it is sent: check the text that is sent.
  if (redacted.text.length > MAX_BODY) {
    throw usage(`The feedback is at most ${MAX_BODY} characters once secrets are replaced with [redacted: …] (${redacted.text.length}); shorten it`);
  }
  const payload = {
    body: redacted.text,
    kind,
    cliVersion: VERSION,
    agentProvider: (typeof o.agent === 'string' ? o.agent : agent.provider) ?? undefined,
    agentModel: (typeof o.model === 'string' ? o.model : agent.model) ?? undefined,
    agentVersion: agent.version ?? undefined,
    projectId: ctx.env.TERMAG_PROJECT_ID || undefined,
    workstream: ctx.env.TERMAG_WORKSTREAM || undefined,
  };

  const api = await authedApi(ctx, session(ctx, args));
  const logged = await api.request<Logged>('POST', '/feedback', payload);
  const kinds = [...new Set([...redacted.redacted, ...logged.redacted])];
  if (args.json) { ctx.out(json({ ...logged, redacted: kinds })); return EXIT.OK; }
  ctx.out(`Logged feedback ${logged.id}. Thanks: termag's admins read every piece.`);
  if (kinds.length) ctx.err(`Redacted before logging: ${kinds.join(', ')}.`);
  return EXIT.OK;
}

export const FEEDBACK_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  feedback: cmdFeedback,
};
