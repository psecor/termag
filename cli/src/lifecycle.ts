import type { Api, Box, Project } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json } from './output.js';

/**
 * Milestone 2: box create/start/stop/set/rm and project create/rename/archive.
 *
 * Boxes and projects are named on the command line and resolved here against
 * the lists, then acted on by id. A name may be a box's id too, which is how a
 * box named before the naming rule stays addressable.
 */

const LIFECYCLE_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 3_000;
const CREATE_WAIT_S = 20 * 60;
const START_WAIT_S = 10 * 60;
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const NAME_RULE = 'letters, digits, - and _ only';

const wait = { type: 'boolean' } as const;
const timeout = { type: 'string' } as const;
const ifNotExists = { type: 'boolean' } as const;

export const LIFECYCLE_COMMANDS: Record<string, CommandSpec> = {
  'box create': {
    summary: 'Create a box',
    usage: 'termag box create <name> [--wait] [--timeout <seconds>] [--if-not-exists]',
    options: { wait, timeout, 'if-not-exists': ifNotExists },
    maxArgs: 1,
  },
  'box start': {
    summary: 'Start a stopped box; its projects come back on their own',
    usage: 'termag box start <box> [--wait] [--timeout <seconds>]',
    options: { wait, timeout },
    maxArgs: 1,
  },
  'box stop': { summary: 'Stop a box, keeping its disk and projects', usage: 'termag box stop <box>', maxArgs: 1 },
  'box set': {
    summary: 'Change box settings: --auto-park hibernates it after that long idle, --terminate-after terminates it after that long hibernated',
    usage: 'termag box set <box> [--auto-park <hours>h|off] [--terminate-after <days>d|off]',
    options: { 'auto-park': { type: 'string' }, 'terminate-after': { type: 'string' } },
    maxArgs: 1,
  },
  'box rm': {
    summary: 'Terminate a box and archive its projects',
    usage: 'termag box rm <box> [--yes]',
    maxArgs: 1,
  },
  'project create': {
    summary: 'Create a project on a box, or on a new box with --new-box',
    usage: 'termag project create <box>/<name> --agent <agent> [--from <template|github-url|box/project>] [--new-box [--timeout <seconds>]] [--if-not-exists]',
    options: { agent: { type: 'string' }, from: { type: 'string' }, 'new-box': { type: 'boolean' }, timeout, 'if-not-exists': ifNotExists },
    maxArgs: 1,
  },
  'project rename': {
    summary: 'Rename a project; it stays on the same box',
    usage: 'termag project rename <box>/<project> <new-name>',
    maxArgs: 2,
  },
  'project archive': {
    summary: 'Archive a project',
    usage: 'termag project archive <box>/<project> [--yes]',
    maxArgs: 1,
  },
};

export const LIFECYCLE_ALIASES: Record<string, string> = {
  'box terminate': 'box rm',
  'project new': 'project create',
  'project mv': 'project rename',
};

/** Powered down or on the way there: `box start` is the way back, `box stop` has nothing to do. */
const PARKED = new Set(['stopping', 'stopped', 'hibernating', 'hibernated']);
const PARKING = new Set(['stopping', 'hibernating']);

function lifecycleApi(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  return authedApi(ctx, session(ctx, args), { timeoutMs: LIFECYCLE_TIMEOUT_MS });
}

function arg(args: ParsedArgs, i: number, what: string, command: string): string {
  const value = args.args[i];
  if (!value) throw usage(`Missing ${what}. Usage: ${LIFECYCLE_COMMANDS[command].usage}`);
  return value;
}

function checkName(name: string, kind: 'box' | 'project'): void {
  if (!NAME_RE.test(name)) throw usage(`"${name}" is not a valid ${kind} name (${NAME_RULE})`);
}

function boxRef(ref: string): string {
  if (ref.includes('/')) throw usage(`"${ref}" names a project; a box is named without a slash`);
  return ref;
}

export function parseProjectRef(ref: string): { box: string; project: string } {
  const parts = ref.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw usage(`"${ref}" is not a project; name one as <box>/<project>`);
  }
  return { box: parts[0], project: parts[1] };
}

async function listBoxes(api: Api): Promise<Box[]> {
  return (await api.request<{ boxes: Box[] }>('GET', '/boxes')).boxes;
}

async function listProjects(api: Api): Promise<Project[]> {
  return (await api.request<{ projects: Project[] }>('GET', '/projects')).projects;
}

export function findBox(boxes: Box[], ref: string): Box | null {
  return boxes.find(b => b.name === ref) ?? boxes.find(b => b.id === ref) ?? null;
}

async function resolveBox(api: Api, ref: string): Promise<Box> {
  const box = findBox(await listBoxes(api), boxRef(ref));
  if (!box) throw new CliError('not_found', `No box named "${ref}". Run \`termag box list\`.`);
  return box;
}

function projectIn(projects: Project[], box: Box, name: string): Project | null {
  return projects.find(p => p.box.id === box.id && p.name === name) ?? null;
}

export async function resolveProject(api: Api, ref: string): Promise<Project> {
  const { box: boxName, project } = parseProjectRef(ref);
  const [boxes, projects] = await Promise.all([listBoxes(api), listProjects(api)]);
  const box = findBox(boxes, boxName);
  if (!box) throw new CliError('not_found', `No box named "${boxName}". Run \`termag box list\`.`);
  const found = projectIn(projects, box, project);
  if (!found) throw new CliError('not_found', `No project "${project}" on ${box.name}. Run \`termag project list\`.`);
  return found;
}

function timeoutSeconds(args: ParsedArgs, fallback: number): number {
  const raw = args.options.timeout;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(n) || n <= 0) throw usage('--timeout takes a number of seconds');
  return n;
}

/** Destructive commands ask first, and need --yes when nobody is there to ask. */
export async function confirmOrRefuse(ctx: Ctx, args: ParsedArgs, question: string): Promise<void> {
  if (args.yes) return;
  if (!ctx.interactive || !ctx.confirm) throw usage(`${question.replace(/\?$/, '')}: pass --yes to confirm when no terminal is attached`);
  if (!(await ctx.confirm(`${question} [y/N] `))) throw new CliError('failed', 'Cancelled');
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Poll the box list until the box is running with its agent connected.
 * Progress goes to stderr (one line per state), never in --json mode.
 */
export async function waitForRunning(ctx: Ctx, api: Api, box: Box, timeoutS: number, quiet: boolean): Promise<Box> {
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_MS;
  let last = '';
  let current = box;
  for (;;) {
    if (current.state === 'running' && current.agentConnected) return current;
    if (current.state === 'failed') {
      throw new CliError('failed', `Box ${current.name} failed${current.error ? `: ${current.error}` : ''}`);
    }
    if (PARKED.has(current.state)) {
      throw new CliError('failed', `Box ${current.name} is ${current.state}; start it with \`termag box start ${current.name}\``);
    }
    const label = current.state === 'running' ? 'running, waiting for its agent' : current.state;
    if (!quiet && label !== last) ctx.err(`${current.name}: ${label} (${formatDuration(Date.now() - started)})`);
    last = label;
    if (Date.now() >= deadline) {
      throw new CliError('timeout', `Timed out after ${formatDuration(timeoutS * 1000)} waiting for ${current.name} to be running (it is ${label})`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    const next = (await listBoxes(api)).find(b => b.id === box.id);
    if (!next) throw new CliError('not_found', `Box ${box.name} is gone`);
    current = next;
  }
}

function emitBox(ctx: Ctx, args: ParsedArgs, box: Box, extra: Record<string, unknown>, text: string): ExitCode {
  if (args.json) ctx.out(json({ box, ...extra }));
  else ctx.out(text);
  return EXIT.OK;
}

/** POST /boxes, or with --if-not-exists the box of that name when there is one. */
async function ensureBox(api: Api, name: string, ifNotExists: boolean): Promise<{ box: Box; created: boolean; claimed: boolean }> {
  const existing = async () => (await listBoxes(api)).find(b => b.name === name) ?? null;
  const found = ifNotExists ? await existing() : null;
  if (found) return { box: found, created: false, claimed: false };
  try {
    const res = await api.request<{ box: Box; claimed: boolean }>('POST', '/boxes', { name });
    return { box: res.box, created: true, claimed: res.claimed };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { box: raced, created: false, claimed: false };
  }
}

async function cmdBoxCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = arg(args, 0, 'the box name', 'box create');
  boxRef(name);
  checkName(name, 'box');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  const { box: made, created, claimed } = await ensureBox(api, name, args.options['if-not-exists'] === true);
  const box = args.options.wait ? await waitForRunning(ctx, api, made, timeoutS, args.json) : made;
  let text: string;
  if (!created) text = `Box ${box.name} already exists (${box.state}).`;
  else if (args.options.wait) text = `Created box ${box.name}; it is running.`;
  else if (box.state === 'running') text = `Created box ${box.name} (running).`;
  else text = `Creating box ${box.name} (${box.state}); \`termag box create ${box.name} --wait --if-not-exists\` waits for it.`;
  return emitBox(ctx, args, box, { created, claimed }, text);
}

/**
 * The orchestrator starts a box only once it has stopped or hibernated, so a
 * box still on its way down is polled until it gets there.
 */
async function waitUntilParked(ctx: Ctx, api: Api, box: Box, deadline: number, quiet: boolean): Promise<Box> {
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_MS;
  let current = box;
  let last = '';
  while (PARKING.has(current.state)) {
    if (!quiet && current.state !== last) ctx.err(`${current.name}: ${current.state}, starting it once that finishes`);
    last = current.state;
    if (Date.now() >= deadline) {
      throw new CliError('timeout', `Timed out waiting for ${current.name} to finish ${current.state}; run \`termag box start ${current.name} --wait\` again`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    const next = (await listBoxes(api)).find(b => b.id === box.id);
    if (!next) throw new CliError('not_found', `Box ${box.name} is gone`);
    current = next;
  }
  return current;
}

async function sendStart(api: Api, box: Box): Promise<{ box: Box; started: boolean }> {
  if (box.state === 'running' || box.state === 'starting') return { box, started: false };
  return { box: (await api.request<{ box: Box }>('POST', `/boxes/${encodeURIComponent(box.id)}/start`)).box, started: true };
}

/**
 * `box start --wait`: let a box on its way down get there, start it, and wait
 * for its agent. The two waits get `timeoutS` each, so a long hibernate does
 * not leave the start too little time.
 */
export async function startAndWait(ctx: Ctx, api: Api, box: Box, timeoutS: number, quiet: boolean): Promise<{ box: Box; started: boolean }> {
  const r = await sendStart(api, await waitUntilParked(ctx, api, box, Date.now() + timeoutS * 1000, quiet));
  return { box: await waitForRunning(ctx, api, r.box, timeoutS, quiet), started: r.started };
}

/** The caller's box by name, or null when it is not theirs (or not there). */
export async function ownBox(api: Api, name: string): Promise<Box | null> {
  return findBox(await listBoxes(api), name);
}

export { START_WAIT_S };

async function cmdBoxStart(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box start');
  const timeoutS = timeoutSeconds(args, START_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  const found = await resolveBox(api, ref);
  const { box, started } = args.options.wait ? await startAndWait(ctx, api, found, timeoutS, args.json) : await sendStart(api, found);
  const text = started ? `Starting ${box.name} (${box.state}).` : `${box.name} is already ${box.state}.`;
  return emitBox(ctx, args, box, { started }, args.options.wait ? `${box.name} is running.` : text);
}

async function cmdBoxStop(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box stop');
  const api = await lifecycleApi(ctx, args);
  let box = await resolveBox(api, ref);
  if (PARKED.has(box.state)) {
    return emitBox(ctx, args, box, { stopped: false }, `${box.name} is already ${box.state}.`);
  }
  box = (await api.request<{ box: Box }>('POST', `/boxes/${encodeURIComponent(box.id)}/stop`)).box;
  return emitBox(ctx, args, box, { stopped: true }, `Stopping ${box.name}; its disk and projects are kept.`);
}

/** A whole number with an optional unit letter, or `off` (null). The server checks the range. */
function parseSetting(flag: string, unit: 'h' | 'd', example: string, raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === 'off') return null;
  const m = value.match(unit === 'h' ? /^(\d+)h?$/ : /^(\d+)d?$/);
  if (!m) throw usage(`--${flag} takes a number of ${unit === 'h' ? 'hours' : 'days'} (like ${example}) or off, not "${raw}"`);
  return Number(m[1]);
}

/** `--auto-park` as idleHibernateHours: `off` is null, `4h` or `4` is four hours. */
export function parseAutoPark(raw: string): number | null {
  return parseSetting('auto-park', 'h', '1h', raw);
}

/** `--terminate-after` as hibernatedTerminateDays: `off` is null, `7d` or `7` is seven days. */
export function parseTerminateAfter(raw: string): number | null {
  return parseSetting('terminate-after', 'd', '7d', raw);
}

interface LifecycleView {
  idleHibernateHours: number | null;
  hibernatedTerminateDays: number | null;
  warning: string | null;
}

async function cmdBoxSet(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box set');
  const autoPark = args.options['auto-park'];
  const terminateAfter = args.options['terminate-after'];
  const settings: { idleHibernateHours?: number | null; hibernatedTerminateDays?: number | null } = {};
  if (typeof autoPark === 'string') settings.idleHibernateHours = parseAutoPark(autoPark);
  if (typeof terminateAfter === 'string') settings.hibernatedTerminateDays = parseTerminateAfter(terminateAfter);
  if (!Object.keys(settings).length) {
    throw usage(`Give --auto-park, --terminate-after or both. Usage: ${LIFECYCLE_COMMANDS['box set'].usage}`);
  }
  const api = await lifecycleApi(ctx, args);
  const box = await resolveBox(api, ref);
  const { lifecycle } = await api.request<{ lifecycle: LifecycleView }>(
    'PATCH', `/boxes/${encodeURIComponent(box.id)}/lifecycle`, settings,
  );
  if (args.json) {
    ctx.out(json({ box: { id: box.id, name: box.name }, lifecycle }));
    return EXIT.OK;
  }
  if (lifecycle.warning) ctx.err(`Warning: ${lifecycle.warning}`);
  if ('idleHibernateHours' in settings) {
    const hours = lifecycle.idleHibernateHours;
    ctx.out(hours === null ? `Auto-park is off for ${box.name}.` : `${box.name} hibernates after ${hours} h idle.`);
  }
  if ('hibernatedTerminateDays' in settings) {
    const days = lifecycle.hibernatedTerminateDays;
    ctx.out(days === null
      ? `${box.name} is never terminated automatically.`
      : `${box.name} is terminated after ${days} ${days === 1 ? 'day' : 'days'} hibernated, or 90 days by default while it has work that isn't pushed anywhere.`);
  }
  return EXIT.OK;
}

async function cmdBoxRm(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box rm');
  const api = await lifecycleApi(ctx, args);
  const box = await resolveBox(api, ref);
  const projects = box.projects.map(p => p.name);
  await confirmOrRefuse(ctx, args, projects.length
    ? `Terminate ${box.name} and archive its projects (${projects.join(', ')})?`
    : `Terminate ${box.name}?`);
  const res = await api.request<{ archivedProjects: number }>('DELETE', `/boxes/${encodeURIComponent(box.id)}`, { confirmed: true });
  if (args.json) ctx.out(json({ box: { id: box.id, name: box.name }, terminated: true, archivedProjects: res.archivedProjects }));
  else ctx.out(`Terminated ${box.name}${res.archivedProjects ? ` and archived ${res.archivedProjects} project(s)` : ''}.`);
  return EXIT.OK;
}

function emitProject(ctx: Ctx, args: ParsedArgs, project: Project, extra: Record<string, unknown>, text: string): ExitCode {
  if (args.json) ctx.out(json({ project, ...extra }));
  else ctx.out(text);
  return EXIT.OK;
}

interface ProjectCreated {
  project: Project;
  created: boolean;
  /** The repo a fresh project is cloned from; null for an empty or un-archived one, or an orchestrator that predates `from`. */
  repoUrl: string | null;
  restored: boolean;
}

/** POST /projects, or with --if-not-exists the project of that name on the box when there is one. */
async function ensureProject(
  api: Api, box: Box, input: { name: string; agent: string; from?: string }, ifNotExists: boolean,
): Promise<ProjectCreated> {
  const existing = async () => projectIn(await listProjects(api), box, input.name);
  const found = ifNotExists ? await existing() : null;
  if (found) return { project: found, created: false, repoUrl: null, restored: false };
  const body: Record<string, string> = { boxId: box.id, name: input.name, agent: input.agent };
  if (input.from) body.from = input.from;
  try {
    const res = await api.request<{ project: Project; repoUrl?: string | null; restored?: boolean }>('POST', '/projects', body);
    return { project: res.project, created: true, repoUrl: res.repoUrl ?? null, restored: res.restored === true };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { project: raced, created: false, repoUrl: null, restored: false };
  }
}

/** A `--from` the new project did not take: an un-archived project, or an orchestrator from before `from`. */
function warnUnusedFrom(ctx: Ctx, from: string | undefined, result: ProjectCreated): void {
  if (!from || !result.created || result.repoUrl) return;
  ctx.err(result.restored
    ? `termag: ${result.project.ref} was restored from the archive with its old directory; --from applies only to a new project.`
    : `termag: the orchestrator ignored --from (it predates it); ${result.project.ref} starts empty.`);
}

function createdText(result: ProjectCreated, agent: string): string {
  const { project } = result;
  if (!result.created) return `${project.ref} already exists (${project.provider ?? '-'}).`;
  const cloning = result.repoUrl ? `; its agent pane clones ${result.repoUrl} first` : '';
  return `Created ${project.ref} (${project.provider ?? agent})${cloning}.`;
}

async function cmdProjectCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseProjectRef(arg(args, 0, '<box>/<name>', 'project create'));
  checkName(ref.project, 'project');
  const agent = args.options.agent;
  if (typeof agent !== 'string' || !agent) throw usage(`--agent is required. Usage: ${LIFECYCLE_COMMANDS['project create'].usage}`);
  const from = typeof args.options.from === 'string' ? args.options.from.trim() || undefined : undefined;
  if (args.options.from !== undefined && !from) throw usage('--from takes a template name or a GitHub repository URL');
  const newBox = args.options['new-box'] === true;
  if (!newBox && args.options.timeout !== undefined) throw usage('--timeout goes with --new-box, which waits for the box');
  if (newBox) checkName(ref.box, 'box');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const ifNotExists = args.options['if-not-exists'] === true;
  const api = await lifecycleApi(ctx, args);
  const input = { name: ref.project, agent, from };

  if (!newBox) {
    const box = await resolveBox(api, ref.box);
    const result = await ensureProject(api, box, input, ifNotExists);
    warnUnusedFrom(ctx, from, result);
    return emitProject(ctx, args, result.project, { created: result.created, repoUrl: result.repoUrl }, createdText(result, agent));
  }

  // The web form's "a new box…": create the box and, while it provisions, the
  // project, which the orchestrator sets up when the box's agent connects
  // (so an interrupted wait loses nothing). An orchestrator from before that
  // refuses an empty project until the agent is up; that one gets it after
  // the wait, as before.
  const made = await ensureBox(api, ref.box, ifNotExists);
  if (!args.json) {
    ctx.err(made.created
      ? `Created box ${made.box.name}${made.claimed ? ' (a warm box, ready now)' : ''}; ${ref.box}/${ref.project} is set up on it once it is running.`
      : `Using the existing box ${made.box.name} (${made.box.state}).`);
  }
  const refused = (err: CliError, boxName: string, state: string) => {
    const retry = `termag project create ${boxName}/${ref.project} --agent ${agent}${from ? ` --from ${from}` : ''}`;
    return new CliError(err.code, `Box ${boxName} is ${state}, but the project was not created: ${err.message.replace(/\.$/, '')}. Retry with \`${retry}\``);
  };
  let result: ProjectCreated | null = null;
  if (made.box.state === 'provisioning') {
    try {
      result = await ensureProject(api, made.box, input, ifNotExists);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      if (!/agent is not connected/i.test(err.message)) throw refused(err, made.box.name, 'still being created');
    }
  }
  let box: Box;
  try {
    box = await waitForRunning(ctx, api, made.box, timeoutS, args.json);
  } catch (err) {
    if (!(result && err instanceof CliError && err.code === 'failed')) throw err;
    throw new CliError(err.code, `${err.message.replace(/\.$/, '')}. ${result.project.ref} waits on it: Retry on the project in the web UI launches a new box.`);
  }
  if (!result) {
    try {
      result = await ensureProject(api, box, input, ifNotExists);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      throw refused(err, box.name, 'running');
    }
  }
  warnUnusedFrom(ctx, from, result);
  const boxText = made.created ? `Created box ${box.name}. ` : '';
  if (args.json) {
    ctx.out(json({ box, boxCreated: made.created, claimed: made.claimed, project: result.project, created: result.created, repoUrl: result.repoUrl }));
  } else {
    ctx.out(boxText + createdText(result, agent));
  }
  return EXIT.OK;
}

async function cmdProjectRename(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, '<box>/<project>', 'project rename');
  let newName = arg(args, 1, 'the new name', 'project rename');
  if (newName.includes('/')) {
    const target = parseProjectRef(newName);
    if (target.box !== parseProjectRef(ref).box) throw usage('A project stays on its box; give just the new name');
    newName = target.project;
  }
  checkName(newName, 'project');
  const api = await lifecycleApi(ctx, args);
  const project = await resolveProject(api, ref);
  const res = await api.request<{ project: Project }>('POST', `/projects/${encodeURIComponent(project.id)}/rename`, { name: newName });
  return emitProject(ctx, args, res.project, { renamedFrom: project.ref }, `Renamed ${project.ref} to ${res.project.ref}.`);
}

async function cmdProjectArchive(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, '<box>/<project>', 'project archive');
  const api = await lifecycleApi(ctx, args);
  const project = await resolveProject(api, ref);
  await confirmOrRefuse(ctx, args, `Archive ${project.ref}?`);
  await api.request('POST', `/projects/${encodeURIComponent(project.id)}/archive`);
  if (args.json) ctx.out(json({ project: { id: project.id, ref: project.ref }, archived: true }));
  else ctx.out(`Archived ${project.ref}.`);
  return EXIT.OK;
}

export const LIFECYCLE_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'box create': cmdBoxCreate,
  'box start': cmdBoxStart,
  'box stop': cmdBoxStop,
  'box set': cmdBoxSet,
  'box rm': cmdBoxRm,
  'project create': cmdProjectCreate,
  'project rename': cmdProjectRename,
  'project archive': cmdProjectArchive,
};
