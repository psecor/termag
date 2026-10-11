import type { Api, Box, Project } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json } from './output.js';

/**
 * Milestone 2: box create/start/stop/rm and project create/rename/archive.
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
  'box rm': {
    summary: 'Terminate a box and archive its projects',
    usage: 'termag box rm <box> [--yes]',
    maxArgs: 1,
  },
  'project create': {
    summary: 'Create a project on a box',
    usage: 'termag project create <box>/<name> --agent <agent> [--if-not-exists]',
    options: { agent: { type: 'string' }, 'if-not-exists': ifNotExists },
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

async function resolveProject(api: Api, ref: string): Promise<Project> {
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
async function confirmOrRefuse(ctx: Ctx, args: ParsedArgs, question: string): Promise<void> {
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

async function cmdBoxCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = arg(args, 0, 'the box name', 'box create');
  boxRef(name);
  checkName(name, 'box');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  const existing = async () => (await listBoxes(api)).find(b => b.name === name) ?? null;

  let box: Box | null = args.options['if-not-exists'] ? await existing() : null;
  let created = false;
  let claimed = false;
  if (!box) {
    try {
      const res = await api.request<{ box: Box; claimed: boolean }>('POST', '/boxes', { name });
      box = res.box;
      claimed = res.claimed;
      created = true;
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'conflict' && args.options['if-not-exists'])) throw err;
      box = await existing();
      if (!box) throw err;
    }
  }
  if (args.options.wait) box = await waitForRunning(ctx, api, box, timeoutS, args.json);
  let text: string;
  if (!created) text = `Box ${box.name} already exists (${box.state}).`;
  else if (args.options.wait) text = `Created box ${box.name}; it is running.`;
  else if (box.state === 'running') text = `Created box ${box.name} (running).`;
  else text = `Creating box ${box.name} (${box.state}); \`termag box create ${box.name} --wait --if-not-exists\` waits for it.`;
  return emitBox(ctx, args, box, { created, claimed }, text);
}

async function cmdBoxStart(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box start');
  const timeoutS = timeoutSeconds(args, START_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  let box = await resolveBox(api, ref);
  let started = false;
  if (box.state !== 'running' && box.state !== 'starting') {
    box = (await api.request<{ box: Box }>('POST', `/boxes/${encodeURIComponent(box.id)}/start`)).box;
    started = true;
  }
  if (args.options.wait) box = await waitForRunning(ctx, api, box, timeoutS, args.json);
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

async function cmdProjectCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseProjectRef(arg(args, 0, '<box>/<name>', 'project create'));
  checkName(ref.project, 'project');
  const agent = args.options.agent;
  if (typeof agent !== 'string' || !agent) throw usage(`--agent is required. Usage: ${LIFECYCLE_COMMANDS['project create'].usage}`);
  const api = await lifecycleApi(ctx, args);
  const box = await resolveBox(api, ref.box);
  const existing = async () => projectIn(await listProjects(api), box, ref.project);

  let project: Project | null = args.options['if-not-exists'] ? await existing() : null;
  let created = false;
  if (!project) {
    try {
      const res = await api.request<{ project: Project }>('POST', '/projects', { boxId: box.id, name: ref.project, agent });
      project = res.project;
      created = true;
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'conflict' && args.options['if-not-exists'])) throw err;
      project = await existing();
      if (!project) throw err;
    }
  }
  const text = created
    ? `Created ${project.ref} (${project.provider ?? agent}).`
    : `${project.ref} already exists (${project.provider ?? '-'}).`;
  return emitProject(ctx, args, project, { created }, text);
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
  'box rm': cmdBoxRm,
  'project create': cmdProjectCreate,
  'project rename': cmdProjectRename,
  'project archive': cmdProjectArchive,
};
