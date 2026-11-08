import type { Api, Box } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ErrorCode, type ExitCode } from './errors.js';
import { confirmOrRefuse, findBox, parseProjectRef } from './lifecycle.js';
import { formatDate, json, table } from './output.js';

/**
 * `termag automation`: the web UI's scheduled automations,
 * over /api/cli/v1/automations. The orchestrator's handlers
 * are the browser's, so what is refused there (the owner check, the minimum
 * interval, automations-enabled) is refused here, in the same words.
 *
 * An automation is a project of its own (kind `automation`), so it is named
 * like one, `<box>/<name>`, or by its id (`termag automation list`).
 */

const TIMEOUT_MS = 60_000;
const SHOWN_RUNS = 10;

const schedule = {
  every: { type: 'string' },
  at: { type: 'string' },
  weekdays: { type: 'boolean' },
  cron: { type: 'string' },
  tz: { type: 'string' },
} as const;
const settings = {
  tier: { type: 'string' },
  'max-minutes': { type: 'string' },
  'no-pr': { type: 'boolean' },
  'wake-box': { type: 'boolean' },
} as const;

const spaceOptions = {
  space: { type: 'string' },
} as const;

const SCHEDULE_USAGE = '(--every <15m|30m|1h|6h|1d|1w> [--at <HH:MM>] | --at <HH:MM> [--weekdays] | --cron "<m h dom mon dow>") [--tz <zone>]';

const SPACE_DETAILS = [
  '--space <name> attaches the automation to a space you can write to (editor or owner). Its files',
  'live in <space>:.termag/automations/<automation id>/, a folder fixed by its id: a rename never',
  'moves it, and it is not space memory (agents in the space don\'t load it).',
  '',
  'The folder holds README.md, memory/MEMORY.md, state.json and runs/<run>.md only while',
  'automation-space-folder-enabled is on for the owner. With it off, only the notes file',
  '(memory/MEMORY.md) is mirrored.',
].join('\n');

export const AUTOMATION_COMMANDS: Record<string, CommandSpec> = {
  'automation list': {
    summary: 'List your automations, with their schedule, state and next run',
    usage: 'termag automation list [<box>|<box>/<name>]',
    maxArgs: 1,
  },
  'automation create': {
    summary: 'Create an automation: a project whose prompt a fresh agent runs on a schedule; --preview shows the next runs and creates nothing',
    usage: `termag automation create <box>/<name> ${SCHEDULE_USAGE} [--from <github-url|template|box/project>]\n`
      + '       [--tier full|read] [--max-minutes <n>] [--no-pr] [--wake-box] [--space <name>]\n'
      + '       [--paused] [--preview] <prompt|->',
    options: { ...schedule, ...settings, ...spaceOptions, from: { type: 'string' }, paused: { type: 'boolean' }, preview: { type: 'boolean' } },
    maxArgs: 2,
    details: SPACE_DETAILS,
  },
  'automation show': {
    summary: 'Show an automation: its schedule, space folder, next runs and last runs with their state',
    usage: 'termag automation show <automation> [--runs <n>]',
    options: { runs: { type: 'string' } },
    maxArgs: 1,
  },
  'automation edit': {
    summary: 'Change an automation\'s schedule, prompt, name, space or settings; any change clears a pause',
    usage: `termag automation edit <automation> [${SCHEDULE_USAGE}] [--prompt <text|->] [--name <new-name>]\n`
      + '       [--tier full|read] [--max-minutes <n>] [--pr|--no-pr] [--wake-box|--no-wake-box]\n'
      + '       [--space <name>|--no-space]',
    options: {
      ...schedule, ...settings, ...spaceOptions, prompt: { type: 'string' }, name: { type: 'string' }, pr: { type: 'boolean' },
      'no-wake-box': { type: 'boolean' }, 'no-space': { type: 'boolean' },
    },
    maxArgs: 1,
    details: `${SPACE_DETAILS}\n\n`
      + '--space with another space leaves the files in the old one where they are: the orchestrator\n'
      + 'does not copy them. --no-space detaches it; its files stay in the space.',
  },
  'automation pause': {
    summary: 'Pause an automation: no scheduled runs until it is resumed (Run now still works)',
    usage: 'termag automation pause <automation>',
    maxArgs: 1,
  },
  'automation resume': {
    summary: 'Resume a paused automation, from its next occurrence (missed ones are not owed)',
    usage: 'termag automation resume <automation>',
    maxArgs: 1,
  },
  'automation run': {
    summary: 'Run an automation now, as its Run now button does',
    usage: 'termag automation run <automation>',
    maxArgs: 1,
  },
  'automation stop': {
    summary: 'Stop a live run of an automation',
    usage: 'termag automation stop <automation> <run>',
    maxArgs: 2,
  },
  'automation rm': {
    summary: 'Delete an automation: its project is archived and its runs stop; the run history stays',
    usage: 'termag automation rm <automation> [--yes]',
    maxArgs: 1,
  },
};

export const AUTOMATION_ALIASES: Record<string, string> = {
  'automation ls': 'automation list',
  'automation new': 'automation create',
  'automation delete': 'automation rm',
};

export interface RunView {
  id: string;
  trigger: string;
  scheduledFor: string;
  state: string;
  reason: string | null;
  reasonLabel: string | null;
  workstream: string | null;
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  changesLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
}

export interface AutomationView {
  id: string;
  projectId: string;
  projectName: string;
  instanceId: string | null;
  repoUrl: string | null;
  schedule: string;
  timezone: string;
  prompt: string;
  tier: string;
  enabled: boolean;
  prOnChange: boolean;
  wakeBox: boolean;
  maxRunMinutes: number;
  pausedReason: string | null;
  /** Wakes of its box EC2 refused in a row (absent from orchestrators before it). */
  boxStartFailures?: { count: number; since: string | null; lastError: string | null } | null;
  nextRunAt: string | null;
  next: string[];
  lastRun: RunView | null;
  owner: boolean;
  /** The space it lives in, and its folder there; null with no space (absent from orchestrators before spaces). */
  spaceName?: string | null;
  spaceFolder?: string | null;
  runs?: RunView[];
}

interface Preview {
  normalised: string;
  timezone: string;
  next: string[];
  minGapMinutes: number | null;
  tooFrequent: number | null;
}

function automationApi(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  return authedApi(ctx, session(ctx, args), { timeoutMs: TIMEOUT_MS });
}

function arg(args: ParsedArgs, i: number, what: string, command: string): string {
  const value = args.args[i];
  if (!value) throw usage(`Missing ${what}. Usage: ${AUTOMATION_COMMANDS[command].usage}`);
  return value;
}

const str = (args: ParsedArgs, name: string): string | undefined =>
  typeof args.options[name] === 'string' ? args.options[name] as string : undefined;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function atTime(at: string): { h: number; m: number } {
  const m = HHMM.exec(at);
  if (!m) throw usage(`--at takes a time of day as HH:MM, e.g. 07:30 (got "${at}")`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

/**
 * The cron expression the schedule options stand for, or null when none was
 * given. --every takes the intervals that divide an hour or a day evenly, so
 * that every gap is the same; anything else is --cron. The orchestrator
 * checks the minimum interval (15 minutes by default, automation-limits).
 */
export function scheduleFrom(opts: { every?: string; at?: string; weekdays?: boolean; cron?: string }): string | null {
  const { every, at, weekdays, cron } = opts;
  if (cron !== undefined && (every !== undefined || at !== undefined || weekdays)) throw usage('--cron is the whole schedule; leave out --every, --at and --weekdays');
  if (cron !== undefined) {
    if (!cron.trim()) throw usage('--cron takes a cron expression, e.g. "0 7 * * 1-5"');
    return cron.trim();
  }
  if (weekdays && at === undefined) throw usage('--weekdays needs --at <HH:MM>');
  if (every === undefined) {
    if (at === undefined) return null;
    const t = atTime(at);
    return `${t.m} ${t.h} * * ${weekdays ? '1-5' : '*'}`;
  }
  if (weekdays) throw usage('--weekdays goes with --at alone; use --cron for anything else');
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(every.trim());
  if (!m) throw usage(`--every takes an interval such as 15m, 1h, 1d or 1w (got "${every}")`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const evenly = (what: string) => usage(`--every ${every} does not divide ${what} evenly; use --cron for that schedule`);
  if (at !== undefined && unit !== 'd' && unit !== 'w') throw usage('--at goes with --every 1d or 1w, or on its own for daily');
  if (unit === 'm' || unit === 'min') {
    if (n === 60) return '0 * * * *';
    if (n < 1 || n > 60 || 60 % n !== 0) throw evenly('an hour');
    return n === 1 ? '* * * * *' : `*/${n} * * * *`;
  }
  if (unit === 'h') {
    if (n === 24) return '0 0 * * *';
    if (n < 1 || n > 24 || 24 % n !== 0) throw evenly('a day');
    return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
  }
  if (n !== 1) throw usage(`--every ${every}: only 1d and 1w; use --cron for longer gaps`);
  const t = at !== undefined ? atTime(at) : { h: 0, m: 0 };
  return unit === 'd' ? `${t.m} ${t.h} * * *` : `${t.m} ${t.h} * * 1`;
}

function scheduleOptions(args: ParsedArgs): string | null {
  return scheduleFrom({ every: str(args, 'every'), at: str(args, 'at'), weekdays: args.options.weekdays === true, cron: str(args, 'cron') });
}

/** This machine's timezone, the one the web UI defaults to as well. */
export function localTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The optional settings common to create and edit, as the request body takes them. */
function settingsBody(args: ParsedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tier = str(args, 'tier');
  if (tier !== undefined) {
    if (tier !== 'full' && tier !== 'read') throw usage('--tier is full or read');
    out.tier = tier;
  }
  const max = str(args, 'max-minutes');
  if (max !== undefined) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1) throw usage('--max-minutes takes a whole number of minutes');
    out.maxRunMinutes = n;
  }
  if (args.options.pr === true && args.options['no-pr'] === true) throw usage('--pr and --no-pr contradict each other');
  if (args.options.pr === true) out.prOnChange = true;
  if (args.options['no-pr'] === true) out.prOnChange = false;
  if (args.options['wake-box'] === true && args.options['no-wake-box'] === true) throw usage('--wake-box and --no-wake-box contradict each other');
  if (args.options['wake-box'] === true) out.wakeBox = true;
  if (args.options['no-wake-box'] === true) out.wakeBox = false;
  return out;
}

const SPACE_NAME = /^[a-z0-9-]{2,40}$/;

function spaceNameFrom(raw: string): string {
  if (!SPACE_NAME.test(raw)) throw usage(`--space takes a space's name: 2 to 40 lowercase letters, digits and dashes (got "${raw}")`);
  return raw;
}

/**
 * --space and (edit) --no-space, as the request body takes them. There is no
 * folder to send: the orchestrator fixes it (.termag/automations/<id>).
 */
function spaceBody(args: ParsedArgs): { spaceName?: string | null } {
  const name = str(args, 'space');
  if (args.options['no-space'] === true) {
    if (name !== undefined) throw usage('--space and --no-space contradict each other');
    return { spaceName: null };
  }
  return name !== undefined ? { spaceName: spaceNameFrom(name) } : {};
}

/** `<space>:<folder>/`, or '-' with no space. */
function spaceOf(a: Pick<AutomationView, 'spaceName' | 'spaceFolder'>): string {
  if (!a.spaceName) return '-';
  return a.spaceFolder ? `${a.spaceName}:${a.spaceFolder}/` : a.spaceName;
}

/**
 * The orchestrator's space refusals (services/automations/spaceSync.ts
 * SYNC_REFUSAL_TEXT, routes/automations.ts), said with what to do about
 * them and an exit code by what they are, not the 400 they come as.
 * Anything else is rethrown as it is.
 */
export function spaceError(err: unknown, spaceName: string | null | undefined): never {
  if (!(err instanceof CliError) || typeof err.body?.code !== 'string') throw err;
  const space = spaceName ? `"${spaceName}"` : 'that space';
  const refuse = (code: ErrorCode, message: string): never => { throw new CliError(code, message, err.status, err.body); };
  switch (err.body.code) {
    case 'space_not_found':
      return refuse('not_found', `No space ${space} that you are a member of. \`termag space ls\` lists yours.`);
    case 'space_forbidden':
      return refuse('forbidden', `You can't write to space ${space}: an automation needs editor or owner there. An owner can make you an editor with \`termag space members ${spaceName ?? '<space>'} add <your email> editor\`.`);
    case 'space_read_only':
      return refuse('forbidden', `Space ${space} is read-only, so an automation can't keep its files there. Pick another space.`);
    case 'shared_outside_space':
      return refuse('forbidden', err.message);
    default:
      throw err;
  }
}

async function readPrompt(ctx: Ctx, raw: string): Promise<string> {
  if (raw !== '-') return raw;
  if (!ctx.readStdin) throw usage('reading the prompt from stdin is not available here');
  return ctx.readStdin();
}

async function listBoxes(api: Api): Promise<Box[]> {
  return (await api.request<{ boxes: Box[] }>('GET', '/boxes')).boxes;
}

/** `<box>/<name>` where the box is the caller's, else the name and that it is shared. */
function refOf(a: AutomationView, boxes: Box[]): string {
  const box = boxes.find(b => b.id === a.instanceId);
  return box ? `${box.name}/${a.projectName}` : `${a.projectName} (shared)`;
}

/**
 * The automation's id for an id or a `<box>/<name>`. An id goes as it is (the
 * orchestrator takes an automation's id or its project's); a name is looked
 * up in the list, so it names only automations the caller can see.
 */
export async function resolveAutomation(api: Api, ref: string): Promise<{ id: string; ref: string }> {
  if (!ref.includes('/')) return { id: ref, ref };
  const { box: boxName, project } = parseProjectRef(ref);
  const [all, boxes] = await Promise.all([api.request<AutomationView[]>('GET', '/automations'), listBoxes(api)]);
  const box = findBox(boxes, boxName);
  if (!box) throw new CliError('not_found', `No box named "${boxName}". Run \`termag box list\`.`);
  const found = all.find(a => a.instanceId === box.id && a.projectName === project);
  if (!found) throw new CliError('not_found', `No automation "${project}" on ${box.name}. Run \`termag automation list\`.`);
  return { id: found.id, ref: `${box.name}/${found.projectName}` };
}

function stateOf(a: Pick<AutomationView, 'enabled' | 'pausedReason'>): string {
  if (a.pausedReason) return `paused: ${a.pausedReason.replace(/_/g, ' ')}`;
  return a.enabled ? 'enabled' : 'paused';
}

/** "couldn't start its box 6 times since 2026-10-30 00:00 UTC (Insufficient capacity.)" */
function boxStartFailures(f: NonNullable<AutomationView['boxStartFailures']>): string {
  const times = f.count === 1 ? 'once' : `${f.count} times`;
  return `couldn't start its box ${times}${f.since ? ` since ${formatDate(f.since)}` : ''}${f.lastError ? ` (${f.lastError})` : ''}`;
}

function runState(r: RunView): string {
  return r.reasonLabel ? `${r.state}: ${r.reasonLabel}` : r.state;
}

function took(sec: number | null): string {
  if (sec === null) return '-';
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function runResult(r: RunView): string {
  return r.prUrl ?? (r.summary ? oneLine(r.summary, 60) : null) ?? r.changesLabel ?? '-';
}

async function cmdList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await automationApi(ctx, args);
  const [all, boxes] = await Promise.all([api.request<AutomationView[]>('GET', '/automations'), listBoxes(api)]);
  let shown = all;
  const filter = args.args[0];
  if (filter) {
    const [boxName, name] = filter.split('/');
    const box = findBox(boxes, boxName);
    if (!box) throw new CliError('not_found', `No box named "${boxName}". Run \`termag box list\`.`);
    shown = all.filter(a => a.instanceId === box.id && (!name || a.projectName === name));
  }
  if (args.json) { ctx.out(json({ automations: shown.map(a => ({ ref: refOf(a, boxes), ...a })) })); return EXIT.OK; }
  if (shown.length === 0) {
    ctx.out(filter ? `No automations match ${filter}.` : 'No automations. Create one with `termag automation create <box>/<name> --every 1h - < prompt.md`.');
    return EXIT.OK;
  }
  ctx.out(table(
    ['AUTOMATION', 'ID', 'SCHEDULE', 'STATE', 'NEXT', 'LAST RUN', 'SPACE'],
    shown.map(a => [
      refOf(a, boxes),
      a.id,
      `${a.schedule} ${a.timezone}`,
      stateOf(a),
      a.next[0] ? formatDate(a.next[0]) : '-',
      a.lastRun ? `${runState(a.lastRun)} ${formatDate(a.lastRun.scheduledFor)}` : '-',
      spaceOf(a),
    ]),
  ));
  return EXIT.OK;
}

function printPreview(ctx: Ctx, p: Preview): void {
  ctx.out(`Schedule: ${p.normalised} (${p.timezone})${p.minGapMinutes !== null ? `, at least ${p.minGapMinutes} min apart` : ''}`);
  ctx.out(`Next runs: ${p.next.map(formatDate).join(', ') || 'none'}`);
}

async function cmdCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, '<box>/<name>', 'automation create');
  const { box: boxName, project: name } = parseProjectRef(ref);
  const cron = scheduleOptions(args);
  if (!cron) throw usage(`An automation needs a schedule: ${SCHEDULE_USAGE}`);
  const timezone = str(args, 'tz') ?? localTimezone();
  const api = await automationApi(ctx, args);

  if (args.options.preview === true) {
    const p = await api.request<Preview>('POST', '/automations/preview', { schedule: cron, timezone });
    if (args.json) ctx.out(json(p));
    else printPreview(ctx, p);
    if (p.tooFrequent !== null) {
      throw usage(`create would refuse this schedule: it runs every ${p.minGapMinutes} minutes; the minimum is ${p.tooFrequent}`);
    }
    return EXIT.OK;
  }

  const prompt = await readPrompt(ctx, arg(args, 1, 'the prompt (or - to read it from stdin)', 'automation create'));
  if (!prompt.trim()) throw usage('The prompt is empty');
  const inSpace = spaceBody(args);
  const box = findBox(await listBoxes(api), boxName);
  if (!box) throw new CliError('not_found', `No box named "${boxName}". Run \`termag box list\`.`);
  const from = str(args, 'from');
  const body: Record<string, unknown> = {
    name, instanceId: box.id, schedule: cron, timezone, prompt, ...settingsBody(args), ...inSpace,
    ...(from !== undefined ? { from } : {}),
    ...(args.options.paused === true ? { enabled: false } : {}),
  };
  const res = await api.request<{ project: { id: string; name: string }; automation: AutomationView; next: string[] }>('POST', '/automations', body)
    .catch(err => spaceError(err, inSpace.spaceName));
  const a = res.automation;
  if (args.json) { ctx.out(json({ ref: `${box.name}/${a.projectName}`, ...res })); return EXIT.OK; }
  ctx.out(`Created automation ${box.name}/${a.projectName} (${a.id}): ${a.schedule} ${a.timezone}, ${a.tier} tier${a.enabled ? '' : ', paused'}.`);
  if (a.enabled && res.next.length) ctx.out(`Next runs: ${res.next.map(formatDate).join(', ')}`);
  if (a.spaceName) ctx.out(`Its files live in ${spaceOf(a)}`);
  ctx.out(`Run it now with \`termag automation run ${box.name}/${a.projectName}\`.`);
  return EXIT.OK;
}

async function cmdShow(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const raw = str(args, 'runs');
  const shownRuns = raw === undefined ? SHOWN_RUNS : Number(raw);
  if (!Number.isInteger(shownRuns) || shownRuns < 0) throw usage('--runs takes a number of runs');
  const api = await automationApi(ctx, args);
  const { id } = await resolveAutomation(api, arg(args, 0, '<automation>', 'automation show'));
  const [a, boxes] = await Promise.all([api.request<AutomationView>('GET', `/automations/${encodeURIComponent(id)}`), listBoxes(api)]);
  const ref = refOf(a, boxes);
  const runs = (a.runs ?? []).slice(0, shownRuns);
  if (args.json) { ctx.out(json({ ref, ...a, runs })); return EXIT.OK; }
  ctx.out(`${ref} (${a.id})`);
  const rows: Array<[string, string]> = [
    ['Schedule', `${a.schedule} (${a.timezone})`],
    ['State', stateOf(a) + (a.owner ? '' : ', shared with you')],
    ...(a.boxStartFailures ? [['Box', boxStartFailures(a.boxStartFailures)] as [string, string]] : []),
    ['Next runs', a.next.map(formatDate).join(', ') || '-'],
    ['Tier', `${a.tier}, at most ${a.maxRunMinutes} min a run${a.prOnChange ? ', opens a draft PR when it commits' : ''}${a.wakeBox ? ', wakes its box' : ''}`],
    ['Repository', a.repoUrl ?? '-'],
    ['Space', spaceOf(a)],
    ['Prompt', oneLine(a.prompt, 100)],
    ['Web', `${api.host}/automations/${a.projectId}`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  for (const [k, v] of rows) ctx.out(`${(k + ':').padEnd(width)} ${v}`);
  ctx.out('');
  if (runs.length === 0) { ctx.out('No runs yet.'); return EXIT.OK; }
  ctx.out(table(
    ['RUN', 'TRIGGER', 'SCHEDULED', 'STATE', 'TOOK', 'RESULT'],
    runs.map(r => [r.id, r.trigger, formatDate(r.scheduledFor), runState(r), took(r.durationSec), runResult(r)]),
  ));
  return EXIT.OK;
}

async function patch(ctx: Ctx, args: ParsedArgs, command: string, body: Record<string, unknown>): Promise<{ api: Api; ref: string; a: AutomationView }> {
  const api = await automationApi(ctx, args);
  const { id, ref } = await resolveAutomation(api, arg(args, 0, '<automation>', command));
  const a = await api.request<AutomationView>('PATCH', `/automations/${encodeURIComponent(id)}`, body);
  return { api, ref, a };
}

async function cmdEdit(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const body: Record<string, unknown> = settingsBody(args);
  const cron = scheduleOptions(args);
  if (cron) body.schedule = cron;
  const tz = str(args, 'tz');
  if (tz !== undefined) body.timezone = tz;
  const rawPrompt = str(args, 'prompt');
  if (rawPrompt !== undefined) {
    const prompt = await readPrompt(ctx, rawPrompt);
    if (!prompt.trim()) throw usage('The prompt is empty');
    body.prompt = prompt;
  }
  const inSpace = spaceBody(args);
  Object.assign(body, inSpace);
  const newName = str(args, 'name');
  if (Object.keys(body).length === 0 && newName === undefined) throw usage(`Nothing to change. Usage: ${AUTOMATION_COMMANDS['automation edit'].usage}`);
  const api = await automationApi(ctx, args);
  const { id, ref } = await resolveAutomation(api, arg(args, 0, '<automation>', 'automation edit'));
  // Where its files were, to say they stay there when the space changes.
  const before = Object.keys(inSpace).length ? await api.request<AutomationView>('GET', `/automations/${encodeURIComponent(id)}`) : null;
  let a = Object.keys(body).length
    ? await api.request<AutomationView>('PATCH', `/automations/${encodeURIComponent(id)}`, body)
      .catch(err => spaceError(err, inSpace.spaceName ?? before?.spaceName))
    : await api.request<AutomationView>('GET', `/automations/${encodeURIComponent(id)}`);
  if (newName !== undefined) {
    // The automation's name is its project's: renamed as `termag project rename` renames it.
    await api.request('POST', `/projects/${encodeURIComponent(a.projectId)}/rename`, { name: newName });
    a = await api.request<AutomationView>('GET', `/automations/${encodeURIComponent(a.id)}`);
  }
  const boxes = await listBoxes(api);
  if (args.json) { ctx.out(json({ ref: refOf(a, boxes), ...a })); return EXIT.OK; }
  ctx.out(`Updated ${refOf(a, boxes)}${newName !== undefined ? ` (was ${ref})` : ''}: ${a.schedule} ${a.timezone}, ${stateOf(a)}.`);
  if (a.next.length) ctx.out(`Next runs: ${a.next.map(formatDate).join(', ')}`);
  if (before) for (const line of spaceMoveNote(before, a)) ctx.out(line);
  return EXIT.OK;
}

/** What `edit` says when the space changed: where the files are now, and that the old space's stay. */
export function spaceMoveNote(before: AutomationView, after: AutomationView): string[] {
  const was = spaceOf(before);
  const now = spaceOf(after);
  if (was === now) return after.spaceName ? [`Space: ${now} (unchanged)`] : [];
  if (!after.spaceName) return [`Detached from ${before.spaceName}. Its files stay in ${was}.`];
  if (!before.spaceName) return [`Its files live in ${now}`];
  return [
    `Its files now live in ${now}.`,
    `The files in ${was} stay there: the orchestrator does not copy them. To bring them along:`,
    `  termag space get -r ${was} <dir> && termag space put -r <dir> ${now}`,
  ];
}

async function cmdPause(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const { ref, a } = await patch(ctx, args, 'automation pause', { enabled: false });
  if (args.json) ctx.out(json({ ref, ...a }));
  else ctx.out(`Paused ${ref}; \`termag automation resume ${ref}\` turns it back on.`);
  return EXIT.OK;
}

async function cmdResume(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const { ref, a } = await patch(ctx, args, 'automation resume', { enabled: true });
  if (args.json) { ctx.out(json({ ref, ...a })); return EXIT.OK; }
  ctx.out(`Resumed ${ref}.${a.next[0] ? ` Next run ${formatDate(a.next[0])}.` : ''}`);
  return EXIT.OK;
}

async function cmdRun(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await automationApi(ctx, args);
  const { id, ref } = await resolveAutomation(api, arg(args, 0, '<automation>', 'automation run'));
  const res = await api.request<{ run: RunView | null; decision: { kind: string; wake?: boolean } }>('POST', `/automations/${encodeURIComponent(id)}/run`);
  if (args.json) { ctx.out(json({ ref, ...res })); return EXIT.OK; }
  const run = res.run;
  if (res.decision.kind === 'pending') {
    ctx.out(`Run ${run?.id ?? ''} of ${ref} is waiting for its box${res.decision.wake ? ', which is starting' : ''}.`);
  } else {
    ctx.out(`Started run ${run?.id ?? ''} of ${ref}${run?.workstream ? ` in ${run.workstream}` : ''}.`);
  }
  ctx.out(`Follow it with \`termag automation show ${ref}\`; stop it with \`termag automation stop ${ref} ${run?.id ?? '<run>'}\`.`);
  return EXIT.OK;
}

async function cmdStop(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await automationApi(ctx, args);
  const { id, ref } = await resolveAutomation(api, arg(args, 0, '<automation>', 'automation stop'));
  const runId = arg(args, 1, 'the run (its id, from `termag automation show`)', 'automation stop');
  await api.request('POST', `/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stop`);
  if (args.json) ctx.out(json({ ref, run: runId, stopped: true }));
  else ctx.out(`Stopped run ${runId} of ${ref}.`);
  return EXIT.OK;
}

async function cmdRm(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const api = await automationApi(ctx, args);
  const { id, ref } = await resolveAutomation(api, arg(args, 0, '<automation>', 'automation rm'));
  await confirmOrRefuse(ctx, args, `Delete automation ${ref} (its project is archived, and no more runs start)?`);
  await api.request('DELETE', `/automations/${encodeURIComponent(id)}`);
  if (args.json) ctx.out(json({ ref, id, deleted: true }));
  else ctx.out(`Deleted automation ${ref}.`);
  return EXIT.OK;
}

export const AUTOMATION_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'automation list': cmdList,
  'automation create': cmdCreate,
  'automation show': cmdShow,
  'automation edit': cmdEdit,
  'automation pause': cmdPause,
  'automation resume': cmdResume,
  'automation run': cmdRun,
  'automation stop': cmdStop,
  'automation rm': cmdRm,
};
