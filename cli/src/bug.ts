import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json } from './output.js';
import { redactSecrets } from './secretPatterns.js';
import { VERSION } from './version.js';

/**
 * `termag bug report`: an agent files a termag bug it
 * ran into, one report per bug. Reports are write-only from here: admins read
 * them, triage them and mark duplicates at /admin/bugs. The report carries
 * this CLI's version, the coding agent and model when the environment says,
 * and the project and workstream the agent runs in; the orchestrator adds the box and its agent. Secret-shaped strings are redacted
 * here, before anything leaves the box, and again by the orchestrator.
 */

const SEVERITIES = ['low', 'medium', 'high'];
const AREAS = ['spaces', 'asks', 'publish', 'boxes', 'chat', 'cli', 'broker', 'other'];
/** The orchestrator keeps the tail of longer error output; sending more is wasted. */
const ERROR_TAIL = 20_000;

export const BUG_COMMANDS: Record<string, CommandSpec> = {
  'bug report': {
    summary: 'Report a termag bug: a termag command or feature that behaved wrongly',
    usage: 'termag bug report --title <title> [--severity low|medium|high] [--area <area>] [--command <command>] [--error-file <path>] [--agent <agent>] [--model <model>] - < body.md',
    options: {
      title: { type: 'string' },
      severity: { type: 'string' },
      area: { type: 'string' },
      command: { type: 'string' },
      'error-file': { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
    },
    maxArgs: 1,
    details: `The body is Markdown on stdin (\`-\`): what you ran, what you expected, what happened.
Areas: ${AREAS.join(', ')} (default other). Severity defaults to medium.
--command is the termag command that went wrong; --error-file a file with its error output (the last ${ERROR_TAIL / 1000}k characters are kept).
The CLI version, the agent and model (from the environment, or --agent / --model) and this session's project and workstream are attached.
Secret-shaped strings (tokens, keys) are replaced with [redacted: …] before sending.
Prints the report's id. Reports are write-only from the CLI; admins triage them and mark duplicates.`,
  },
};

/** The coding agent this CLI runs under, from what the agents put in the environment. */
export function agentFromEnv(env: NodeJS.ProcessEnv): { provider: string | null; version: string | null; model: string | null } {
  // Claude Code: AI_AGENT=claude-code_2-1-312_agent.
  const m = env.AI_AGENT?.match(/^([a-z][a-z0-9-]*?)_(\d+(?:-\d+)*)_agent$/);
  const name = m?.[1] ?? null;
  const provider = name === 'claude-code' || (!name && env.CLAUDECODE === '1') ? 'claude'
    : name ?? (env.CODEX_SANDBOX || env.CODEX_THREAD_ID ? 'codex' : null);
  return {
    provider,
    version: m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : null,
    model: (provider === 'claude' ? env.ANTHROPIC_MODEL : undefined)?.trim() || null,
  };
}

function oneOf(name: string, value: unknown, allowed: string[]): string | undefined {
  if (value === undefined) return undefined;
  const v = String(value).trim();
  if (!allowed.includes(v)) throw usage(`--${name} takes one of ${allowed.join(', ')}`);
  return v;
}

interface Filed { id: string; status: string; redacted: string[] }

async function cmdBugReport(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const o = args.options;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) throw usage(`Missing --title. Usage: ${BUG_COMMANDS['bug report'].usage}`);
  if (args.args[0] !== '-') throw usage('Give the body on stdin: `termag bug report --title "…" - < body.md`');
  const severity = oneOf('severity', o.severity, SEVERITIES);
  const area = oneOf('area', o.area, AREAS);
  if (!ctx.readStdin) throw new CliError('failed', 'Cannot read stdin here');
  const body = (await ctx.readStdin()).trim();
  if (!body) throw usage('The body on stdin is empty: say what you ran, what you expected and what happened');

  let errorOutput: string | undefined;
  if (typeof o['error-file'] === 'string') {
    const text = ctx.readFile(o['error-file']);
    if (text === null) throw new CliError('not_found', `Can't read --error-file ${o['error-file']}`);
    errorOutput = text;
  }

  const agent = agentFromEnv(ctx.env);
  const redacted = new Set<string>();
  const clean = (s: string | undefined | null): string | undefined => {
    if (!s) return undefined;
    const r = redactSecrets(s);
    r.redacted.forEach(k => redacted.add(k));
    return r.text;
  };
  const tail = (s: string | undefined) => s && s.length > ERROR_TAIL ? s.slice(-ERROR_TAIL) : s;
  const payload = {
    title: clean(title), body: clean(body), severity, area,
    command: clean(typeof o.command === 'string' ? o.command : undefined),
    // Redacted before the tail is cut, so a key whose header falls outside the tail still goes.
    errorOutput: tail(clean(errorOutput)),
    cliVersion: VERSION,
    agentProvider: (typeof o.agent === 'string' ? o.agent : agent.provider) ?? undefined,
    agentModel: (typeof o.model === 'string' ? o.model : agent.model) ?? undefined,
    agentVersion: agent.version ?? undefined,
    projectId: ctx.env.TERMAG_PROJECT_ID || undefined,
    workstream: ctx.env.TERMAG_WORKSTREAM || undefined,
  };

  const api = await authedApi(ctx, session(ctx, args));
  const filed = await api.request<Filed>('POST', '/bug-reports', payload);
  const kinds = [...new Set([...redacted, ...filed.redacted])];
  if (args.json) { ctx.out(json({ ...filed, redacted: kinds })); return EXIT.OK; }
  ctx.out(`Filed bug report ${filed.id}.`);
  if (kinds.length) ctx.err(`Redacted before filing: ${kinds.join(', ')}.`);
  ctx.out(`Mention ${filed.id} in your handoff.`);
  return EXIT.OK;
}

export const BUG_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'bug report': cmdBugReport,
};
