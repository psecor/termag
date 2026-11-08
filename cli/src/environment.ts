import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { EXIT, usage, type ExitCode } from './errors.js';
import { confirmOrRefuse } from './lifecycle.js';
import { formatDate, json, table } from './output.js';

/**
 * `termag environment` (alias `termag env`): environments
 * over /api/cli/v1/environments, the web UI's own actions, so
 * a definition is validated against the same schema and every change is the
 * same audit event, recorded as the person. A box's own credential reads
 * only; the orchestrator answers 403 to its create, edit and delete. An environment is named by its name.
 *
 * A definition comes from --file <path.json>, from stdin with `-`, or as a
 * pointer, --pointer <owner/name>:<branch>:<path> (an empty branch is the
 * repository's default, an empty path `.termag/environment.json`).
 *
 * An environment is personal (its owner's alone) or shared (everyone's, from
 * a file on its repository's default branch). `create` makes a personal one
 * unless --shared; `share` and `unshare` are the owner's switch. The
 * orchestrator checks the shared rules and its refusal, which says the rule,
 * is passed on as it comes.
 */

const TIMEOUT_MS = 60_000;
const DEFINITION_USAGE = '(--file <path.json> | - | --pointer <owner/name>:<branch>:<path>)';
const definitionOptions = { file: { type: 'string' }, pointer: { type: 'string' } } as const;

export const ENVIRONMENT_COMMANDS: Record<string, CommandSpec> = {
  'environment list': {
    summary: 'List your personal environments, then the shared ones (anyone can use and edit those)',
    usage: 'termag environment list',
    maxArgs: 0,
  },
  'environment show': {
    summary: 'Show an environment: its definition or pointer, and the repositories it resolves to now',
    usage: 'termag environment show <name>',
    maxArgs: 1,
  },
  'environment create': {
    summary: 'Create an environment from a definition (JSON, checked against docs/environment.schema.json) or a pointer to a file',
    usage: `termag environment create <name> ${DEFINITION_USAGE} [--shared]`,
    options: { ...definitionOptions, shared: { type: 'boolean' } },
    maxArgs: 2,
    details: '--file reads the definition (environment.json\'s JSON, with "repos" and "resources") from a file, and - from stdin.\n'
      + '--pointer <owner/name>:<branch>:<path> points at a file in a repository instead, read from that branch when a box is\n'
      + 'made; an empty branch is the default branch, an empty path .termag/environment.json.\n'
      + 'It is personal, yours alone, unless --shared: everyone signed in may then use and edit it, and it must be a\n'
      + '--pointer to a file on its repository\'s default branch. Then deploy from it:\n'
      + '  termag project create <box>/<name> --agent claude --new-box --environment <name>',
  },
  'environment edit': {
    summary: 'Replace an environment\'s definition or pointer (every change is in its history)',
    usage: `termag environment edit <name> ${DEFINITION_USAGE}`,
    options: definitionOptions,
    maxArgs: 2,
  },
  'environment share': {
    summary: 'Share your environment with everyone: it must point at a file on its repository\'s default branch',
    usage: 'termag environment share <name>',
    maxArgs: 1,
  },
  'environment unshare': {
    summary: 'Make your shared environment personal again: only you see and use it',
    usage: 'termag environment unshare <name>',
    maxArgs: 1,
  },
  'environment history': {
    summary: 'An environment\'s history: every change, who made it and when, newest first',
    usage: 'termag environment history <name>',
    maxArgs: 1,
  },
  'environment delete': {
    summary: 'Delete an environment, a shared one for everyone (its history stays; projects made from it keep their repositories)',
    usage: 'termag environment delete <name> [--yes]',
    maxArgs: 1,
  },
};

export const ENVIRONMENT_ALIASES: Record<string, string> = {
  'environment ls': 'environment list',
  'environment rm': 'environment delete',
  ...Object.fromEntries(Object.keys(ENVIRONMENT_COMMANDS).map(c => [c.replace(/^environment /, 'env '), c])),
  'env ls': 'environment list',
  'env rm': 'environment delete',
};

interface RepoView { repo: string; branch?: string; path?: string }
interface Person { email: string; name: string }
type Fields = { name: string; kind: 'inline'; definition: Record<string, unknown> } | { name: string; kind: 'pointer'; file: { repo: string; branch: string | null; path: string } };
type Visibility = 'personal' | 'shared';
type EnvironmentView = Fields & { id: string; updatedAt: string; createdBy: Person | null; updatedBy: Person | null; visibility: Visibility; owner: Person | null };
type Snapshot = Fields & { visibility?: Visibility };
interface EventView { id: string; at: string; action: string; actor: Person | null; before: Snapshot | null; after: Snapshot | null }

function api(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  return authedApi(ctx, session(ctx, args), { timeoutMs: TIMEOUT_MS });
}

function nameArg(args: ParsedArgs, command: string): string {
  const value = args.args[0];
  if (!value) throw usage(`Missing the environment's name. Usage: ${ENVIRONMENT_COMMANDS[command].usage}`);
  return value;
}

const path = (name: string) => `/environments/${encodeURIComponent(name)}`;
const person = (p: Person | null) => (p ? p.name || p.email : 'someone no longer in termag');
const pointerLabel = (f: { repo: string; branch: string | null; path: string }) => `${f.repo}:${f.branch ?? ''}:${f.path}`;
const repoLabel = (r: RepoView) => {
  const extra = [r.branch ? `branch ${r.branch}` : '', r.path ? `in ${r.path}/` : ''].filter(Boolean);
  return extra.length ? `${r.repo} (${extra.join(', ')})` : r.repo;
};

/** `owner/name:branch:path` as a pointer: the branch and path may be empty (the default branch, `.termag/environment.json`). */
export function parsePointer(raw: string): { repo: string; branch?: string; path?: string } {
  const [repo, branch = '', ...rest] = raw.split(':');
  const filePath = rest.join(':');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw usage(`--pointer takes <owner/name>:<branch>:<path>, e.g. example-org/webapp:main:.termag/full-stack/environment.json; "${raw}" doesn't start with owner/name`);
  return { repo, ...(branch ? { branch } : {}), ...(filePath ? { path: filePath } : {}) };
}

/** The create's or edit's body from --file, `-` (stdin) or --pointer: exactly one of them. */
async function definitionBody(ctx: Ctx, args: ParsedArgs, name: string, command: string): Promise<Record<string, unknown>> {
  const file = typeof args.options.file === 'string' ? args.options.file : undefined;
  const pointer = typeof args.options.pointer === 'string' ? args.options.pointer : undefined;
  const stdin = args.args[1] === '-';
  if (args.args[1] !== undefined && !stdin) throw usage(`Unexpected "${args.args[1]}". Usage: ${ENVIRONMENT_COMMANDS[command].usage}`);
  if ([file, pointer, stdin ? '-' : undefined].filter(Boolean).length !== 1) {
    throw usage(`Give the definition one way: --file <path.json>, - (stdin), or --pointer <owner/name>:<branch>:<path>. Usage: ${ENVIRONMENT_COMMANDS[command].usage}`);
  }
  if (pointer) return { name, kind: 'pointer', file: parsePointer(pointer) };
  let text: string | null;
  if (file) {
    text = ctx.readFile(file);
    if (text === null) throw usage(`Can't read ${file}`);
  } else {
    if (!ctx.readStdin) throw usage('reading the definition from stdin is not available here');
    text = await ctx.readStdin();
  }
  // Sent as text: the orchestrator parses it, so a JSON error reads as the UI's does.
  return { name, kind: 'inline', definition: text };
}

async function cmdList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const { environments } = await (await api(ctx, args)).request<{ environments: EnvironmentView[] }>('GET', '/environments');
  if (args.json) { ctx.out(json(environments)); return EXIT.OK; }
  if (!environments.length) { ctx.out('No environments yet. `termag environment create <name> --file <path.json>` makes one.'); return EXIT.OK; }
  // The orchestrator lists the caller's personal ones first, then the shared ones.
  ctx.out(table(['NAME', 'WHO', 'DEFINITION', 'EDITED', 'BY'], environments.map(e => [
    e.name, e.visibility, e.kind === 'pointer' ? `file ${pointerLabel(e.file)}` : 'inline', formatDate(e.updatedAt), person(e.updatedBy),
  ])));
  return EXIT.OK;
}

async function cmdShow(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = nameArg(args, 'environment show');
  const a = await api(ctx, args);
  const { environment: env } = await a.request<{ environment: EnvironmentView }>('GET', path(name));
  const resolved = await a.request<{ repos: RepoView[]; size: unknown; warnings: string[] }>('GET', `${path(name)}/resolved`).catch(() => null);
  if (args.json) { ctx.out(json({ ...env, ...(resolved ? { resolved } : {}) })); return EXIT.OK; }
  const lines = [`${env.name} · ${env.visibility}, owned by ${person(env.owner)} · edited ${formatDate(env.updatedAt)} by ${person(env.updatedBy)}`];
  if (env.kind === 'pointer') lines.push(`File: ${pointerLabel(env.file)}`);
  else lines.push('Definition:', JSON.stringify(env.definition, null, 2));
  if (resolved) {
    lines.push('Repositories:', ...resolved.repos.map(r => `  ${repoLabel(r)}`));
    if (resolved.size) lines.push(`Size: ${typeof resolved.size === 'string' ? resolved.size : JSON.stringify(resolved.size)}`);
    for (const w of resolved.warnings) lines.push(`warning: ${w}`);
  }
  lines.push(`Deploy: termag project create <box>/<name> --agent claude --new-box --environment ${env.name}`);
  ctx.out(lines.join('\n'));
  return EXIT.OK;
}

async function cmdCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = nameArg(args, 'environment create');
  const body = await definitionBody(ctx, args, name, 'environment create');
  const visibility: Visibility = args.options.shared === true ? 'shared' : 'personal';
  const { environment: env } = await (await api(ctx, args)).request<{ environment: EnvironmentView }>('POST', '/environments', { ...body, visibility });
  if (args.json) { ctx.out(json(env)); return EXIT.OK; }
  ctx.out(`Created ${env.visibility} environment ${env.name} (${env.kind === 'pointer' ? `file ${pointerLabel(env.file)}` : 'inline'}).`);
  ctx.out(`Next: termag project create <box>/<name> --agent claude --new-box --environment ${env.name}`);
  return EXIT.OK;
}

async function cmdEdit(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = nameArg(args, 'environment edit');
  const body = await definitionBody(ctx, args, name, 'environment edit');
  const { environment: env, changed } = await (await api(ctx, args)).request<{ environment: EnvironmentView; changed: boolean }>('PUT', path(name), body);
  if (args.json) { ctx.out(json({ ...env, changed })); return EXIT.OK; }
  ctx.out(changed ? `Saved environment ${env.name}.` : `Environment ${env.name} already says that; nothing changed.`);
  return EXIT.OK;
}

/** The owner's switch: `share` or `unshare`. */
function cmdSwitch(to: Visibility) {
  const command = to === 'shared' ? 'environment share' : 'environment unshare';
  return async (ctx: Ctx, args: ParsedArgs): Promise<ExitCode> => {
    const name = nameArg(args, command);
    const { environment: env, changed } = await (await api(ctx, args))
      .request<{ environment: EnvironmentView; changed: boolean }>('POST', `${path(name)}/visibility`, { visibility: to });
    if (args.json) { ctx.out(json({ ...env, changed })); return EXIT.OK; }
    ctx.out(!changed ? `Environment ${env.name} is already ${to}.`
      : to === 'shared' ? `Shared environment ${env.name}: everyone signed in can use and edit it.`
      : `Environment ${env.name} is personal: only you see and use it.`);
    return EXIT.OK;
  };
}

/** One event's changes, as `history` lists them: what a create made, each changed key, a pointer's move. */
export function changeLines(e: Pick<EventView, 'action' | 'before' | 'after'>): string[] {
  const form = (f: Fields) => (f.kind === 'pointer' ? `file ${pointerLabel(f.file)}` : `inline (${Object.keys(f.definition).filter(k => k !== '$schema').join(', ') || 'empty'})`);
  const { before, after } = e;
  if (e.action === 'environment.visibility') return after?.visibility ? [`${before?.visibility ?? 'personal'} → ${after.visibility}`] : [];
  if (!before || !after) return [form((after ?? before)!)];
  const lines: string[] = [];
  if (before.name !== after.name) lines.push(`renamed ${before.name} → ${after.name}`);
  if (before.kind !== after.kind) lines.push(`${form(before)} → ${form(after)}`);
  else if (before.kind === 'pointer' && after.kind === 'pointer') {
    if (pointerLabel(before.file) !== pointerLabel(after.file)) lines.push(`file ${pointerLabel(before.file)} → ${pointerLabel(after.file)}`);
  } else if (before.kind === 'inline' && after.kind === 'inline') {
    for (const k of [...new Set([...Object.keys(before.definition), ...Object.keys(after.definition)])]) {
      const was = JSON.stringify(before.definition[k]);
      const now = JSON.stringify(after.definition[k]);
      if (was !== now) lines.push(was === undefined ? `added ${k}: ${now}` : now === undefined ? `removed ${k}` : `${k}: ${was} → ${now}`);
    }
  }
  return lines;
}

async function cmdHistory(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = nameArg(args, 'environment history');
  const { events } = await (await api(ctx, args)).request<{ events: EventView[] }>('GET', `${path(name)}/events`);
  if (args.json) { ctx.out(json(events)); return EXIT.OK; }
  if (!events.length) { ctx.out(`No history for ${name}.`); return EXIT.OK; }
  const word: Record<string, string> = { 'environment.create': 'Created', 'environment.update': 'Edited', 'environment.delete': 'Deleted', 'environment.visibility': 'Switched' };
  ctx.out(events.map(e => [`${formatDate(e.at)}  ${word[e.action] ?? e.action} by ${person(e.actor)}`, ...changeLines(e).map(l => `  ${l}`)].join('\n')).join('\n'));
  return EXIT.OK;
}

async function cmdDelete(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = nameArg(args, 'environment delete');
  await confirmOrRefuse(ctx, args, `Delete environment ${name} (a shared one for everyone; its history stays)?`);
  await (await api(ctx, args)).request('DELETE', path(name));
  if (args.json) ctx.out(json({ name, deleted: true }));
  else ctx.out(`Deleted environment ${name}.`);
  return EXIT.OK;
}

export const ENVIRONMENT_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'environment list': cmdList,
  'environment show': cmdShow,
  'environment create': cmdCreate,
  'environment edit': cmdEdit,
  'environment share': cmdSwitch('shared'),
  'environment unshare': cmdSwitch('personal'),
  'environment history': cmdHistory,
  'environment delete': cmdDelete,
};
