import type { CommandSpec, ParsedArgs } from './args.js';
import { Api } from './api.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { formatDate, json, table } from './output.js';
import { redactSecrets } from './secretPatterns.js';
import { VERSION } from './version.js';

/**
 * `termag bug report`: an agent files a termag bug it
 * ran into, one report per bug. Anyone can file; only admins read them, triage
 * them and mark duplicates, at /admin/bugs or, on an admin's own box, with
 * `bug list`, `bug show` and `bug triage` below. The report carries
 * this CLI's version, the coding agent and model when the environment says,
 * and the project and workstream the agent runs in; the orchestrator adds the box and its agent. Secret-shaped strings are redacted
 * here, before anything leaves the box, and again by the orchestrator.
 */

const SEVERITIES = ['low', 'medium', 'high'];
const AREAS = ['spaces', 'asks', 'publish', 'boxes', 'chat', 'cli', 'broker', 'other'];
const STATUSES = ['new', 'triaged', 'duplicate', 'fixed', 'wontfix'];
/** The admin pages' "open" filter. */
const OPEN = ['new', 'triaged'];
const ADMIN_NOTE = `Admins only, on their own box: the box's own credential, checked against the owner's admin role on every call.
Every call is in the admin audit log, with the box.`;
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
Prints the report's id. Only admins read reports and mark duplicates.`,
  },
  'bug list': {
    summary: 'List termag bug reports, new first (admins, on their own box)',
    usage: 'termag bug list [--status <status>[,…]|open] [--area <area>[,…]] [--severity <severity>[,…]] [--q <text>] [--limit <n>]',
    options: {
      status: { type: 'string' },
      area: { type: 'string' },
      severity: { type: 'string' },
      q: { type: 'string' },
      limit: { type: 'string' },
    },
    maxArgs: 0,
    details: `Statuses: ${STATUSES.join(', ')}; open is ${OPEN.join(' and ')}. --q searches title, body, command and error output.
New reports come first, then the rest, newest first; --limit (default 50, at most 500) applies after that order.
${ADMIN_NOTE}`,
  },
  'bug show': {
    summary: 'Show one termag bug report with its history (admins, on their own box)',
    usage: 'termag bug show <id>',
    maxArgs: 1,
    details: ADMIN_NOTE,
  },
  'bug triage': {
    summary: 'Triage a termag bug report: status, duplicate, link, note (admins, on their own box)',
    usage: 'termag bug triage <id> [--status <status>] [--duplicate-of <id>] [--link <github issue or PR url>] [--note <text>]',
    options: {
      status: { type: 'string' },
      'duplicate-of': { type: 'string' },
      link: { type: 'string' },
      note: { type: 'string' },
    },
    maxArgs: 1,
    details: `Statuses: ${STATUSES.filter(x => x !== 'duplicate').join(', ')}; --duplicate-of sets duplicate, pointing at the original's root.
--link takes https://github.com/<owner>/<repo>/issues/<n> or /pull/<n>; --link '' clears it. --note goes into the history with the change.
${ADMIN_NOTE}`,
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

interface ReportSummary {
  id: string; title: string; status: string; severity: string; area: string; createdAt: string;
  reporter: string; box: string | null; linkUrl: string | null; duplicateOfId: string | null;
}

interface ReportDetail {
  report: {
    id: string; title: string; body: string; status: string; severity: string; area: string; createdAt: string; triagedAt: string | null;
    command: string | null; errorOutput: string | null; linkUrl: string | null; duplicateOfId: string | null; workstream: string | null;
    credential: string; agentProvider: string | null; agentModel: string | null; agentVersion: string | null; cliVersion: string | null;
    boxAgentCommit: string | null; boxAgentCapabilities?: string[]; boxImage: string | null; redacted: string[];
  };
  reporter: { user: string; box: string | null; project: string | null };
  events: Array<{ actor: string; createdAt: string; status: string | null; duplicateOfId: string | null; linkUrl: string | null; note: string | null }>;
  duplicateOf: { id: string; title: string } | null;
  duplicates: Array<{ id: string; title: string; status: string }>;
}

function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.options[name];
  return typeof v === 'string' ? v : undefined;
}

/** A comma list of `allowed` values, checked here so a typo is a usage error, not a round trip. */
function listOption(args: ParsedArgs, name: string, allowed: string[], aliases: Record<string, string[]> = {}): string | undefined {
  const raw = str(args, name);
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const part of raw.split(',').map(x => x.trim()).filter(Boolean)) {
    if (aliases[part]) { out.push(...aliases[part]); continue; }
    if (!allowed.includes(part)) throw usage(`--${name} takes ${[...allowed, ...Object.keys(aliases)].join(', ')} (comma-separated)`);
    out.push(part);
  }
  return out.length ? [...new Set(out)].join(',') : undefined;
}

function reportId(args: ParsedArgs, command: string): string {
  const id = args.args[0]?.trim();
  if (!id) throw usage(`Missing <id>. Usage: ${BUG_COMMANDS[command].usage}`);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw usage(`Not a bug report id: ${id}`);
  return id;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/**
 * The reads and the triage take a box's own credential only, so the box's
 * token wins here even over a `termag login` on the same machine (which
 * authedApi would prefer). Off a box, the sign-in goes and the orchestrator
 * says why it is refused.
 */
async function adminApi(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  const s = session(ctx, args);
  if (s.target.box) return new Api({ host: s.target.host, token: s.target.box.token, fetch: ctx.fetch });
  return authedApi(ctx, s);
}

async function cmdBugList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const q = new URLSearchParams();
  const status = listOption(args, 'status', STATUSES, { open: OPEN });
  const area = listOption(args, 'area', AREAS);
  const severity = listOption(args, 'severity', SEVERITIES);
  if (status) q.set('status', status);
  if (area) q.set('area', area);
  if (severity) q.set('severity', severity);
  const text = str(args, 'q')?.trim();
  if (text) q.set('q', text);
  const limit = str(args, 'limit') ?? '50';
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 500) throw usage('--limit is a whole number from 1 to 500');
  q.set('limit', limit);

  const api = await adminApi(ctx, args);
  const { reports } = await api.request<{ reports: ReportSummary[] }>('GET', `/bug-reports?${q}`);
  if (args.json) { ctx.out(json(reports)); return EXIT.OK; }
  if (reports.length === 0) { ctx.out('No bug reports match.'); return EXIT.OK; }
  ctx.out(table(
    ['ID', 'STATUS', 'SEV', 'AREA', 'FILED', 'REPORTER', 'TITLE'],
    reports.map(r => [
      r.id, r.status === 'duplicate' && r.duplicateOfId ? `dup of ${r.duplicateOfId}` : r.status, r.severity, r.area,
      formatDate(r.createdAt), r.box ? `${r.reporter} (${r.box})` : r.reporter, oneLine(r.title, 80),
    ]),
  ));
  return EXIT.OK;
}

function printDetail(ctx: Ctx, d: ReportDetail): void {
  const r = d.report;
  const agent = [r.agentProvider, r.agentVersion, r.agentModel].filter(Boolean).join(', ');
  const rows: Array<[string, string]> = [
    ['Report', r.id],
    ['Title', r.title],
    ['Status', r.status + (d.duplicateOf ? ` of ${d.duplicateOf.id} (${oneLine(d.duplicateOf.title, 60)})` : '')],
    ['Severity', r.severity],
    ['Area', r.area],
    ['Filed', `${formatDate(r.createdAt)} by ${d.reporter.user} with ${r.credential === 'box' ? 'a box token' : 'a sign-in'}`],
    ['Box', d.reporter.box ?? '-'],
    ['Project', d.reporter.project ? `${d.reporter.project}${r.workstream ? ` (${r.workstream})` : ''}` : '-'],
    ['Agent', agent || '-'],
    ['CLI', r.cliVersion ?? '-'],
    ['Box agent', r.boxAgentCommit ?? '-'],
    ['Capabilities', r.boxAgentCapabilities?.length ? r.boxAgentCapabilities.join(' ') : '-'],
    ['Box image', r.boxImage ?? '-'],
    ['Link', r.linkUrl ?? '-'],
  ];
  if (r.redacted.length) rows.push(['Redacted', r.redacted.join(', ')]);
  if (d.duplicates.length) rows.push(['Duplicates', d.duplicates.map(x => x.id).join(', ')]);
  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  for (const [k, v] of rows) ctx.out(`${(k + ':').padEnd(width)} ${v}`);
  if (r.command) { ctx.out(''); ctx.out('Command:'); ctx.out(`  ${r.command}`); }
  if (r.errorOutput) { ctx.out(''); ctx.out('Error output:'); ctx.out(r.errorOutput.trimEnd()); }
  ctx.out('');
  ctx.out(r.body.trimEnd());
  ctx.out('');
  if (d.events.length === 0) { ctx.out('Not triaged yet.'); return; }
  ctx.out('History:');
  for (const e of d.events) {
    const what = [
      e.status ? `status ${e.status}${e.status === 'duplicate' && e.duplicateOfId ? ` of ${e.duplicateOfId}` : ''}` : null,
      // An empty linkUrl is the link cleared; null, the link left as it was.
      e.linkUrl === '' ? 'cleared the link' : e.linkUrl ? `link ${e.linkUrl}` : null,
      e.note ? `"${oneLine(e.note, 120)}"` : null,
    ].filter(Boolean).join(', ');
    ctx.out(`  ${formatDate(e.createdAt)}  ${e.actor}: ${what || 'changed'}`);
  }
}

async function cmdBugShow(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const id = reportId(args, 'bug show');
  const api = await adminApi(ctx, args);
  const detail = await api.request<ReportDetail>('GET', `/bug-reports/${encodeURIComponent(id)}`);
  if (args.json) { ctx.out(json(detail)); return EXIT.OK; }
  printDetail(ctx, detail);
  return EXIT.OK;
}

async function cmdBugTriage(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const id = reportId(args, 'bug triage');
  const body: Record<string, string> = {};
  const status = str(args, 'status');
  if (status !== undefined) body.status = oneOf('status', status, STATUSES)!;
  const dup = str(args, 'duplicate-of');
  if (dup !== undefined) body.duplicateOf = dup.trim();
  const link = str(args, 'link');
  if (link !== undefined) body.link = link.trim();
  const note = str(args, 'note');
  if (note !== undefined) body.note = note;
  if (Object.keys(body).length === 0) throw usage(`Nothing to change. Usage: ${BUG_COMMANDS['bug triage'].usage}`);

  const api = await adminApi(ctx, args);
  const { report } = await api.request<{ report: ReportDetail['report'] }>('PATCH', `/bug-reports/${encodeURIComponent(id)}`, body);
  if (args.json) { ctx.out(json(report)); return EXIT.OK; }
  const parts = [`status ${report.status}${report.duplicateOfId ? ` of ${report.duplicateOfId}` : ''}`];
  if (report.linkUrl) parts.push(`link ${report.linkUrl}`);
  ctx.out(`Triaged ${report.id}: ${parts.join(', ')}.`);
  return EXIT.OK;
}

export const BUG_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'bug report': cmdBugReport,
  'bug list': cmdBugList,
  'bug show': cmdBugShow,
  'bug triage': cmdBugTriage,
};
