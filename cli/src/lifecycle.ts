import type { Api, Box, Project } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, boxSpecText, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json } from './output.js';

/**
 * Milestone 2: box create/start/stop/set/rename/resize/rm and project create/rename/archive.
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
const size = { type: 'string' } as const;
const SIZES = ['small', 'medium', 'large'];
const disk = { type: 'string' } as const;
/** The orchestrator's range for a new box's disk (backend services/boxDiskSize.ts). */
const DISK_GIB = { min: 50, max: 300 } as const;

/**
 * --for-ask, deprecated: the box or project is made for an ask, which gives
 * the box the ask-box lifecycle (it is sized like any other). `termag ask
 * --new-box` makes both and asks in one command, so nothing has to remember
 * the label; the simple UI no longer needs it either.
 */
const forAsk = { type: 'boolean' } as const;

export const FOR_ASK_DEPRECATED = 'termag: --for-ask is deprecated: `termag ask --new-box <box>/<project> <prompt|->` makes the box and the project for an ask, and asks, in one command';

export const LIFECYCLE_COMMANDS: Record<string, CommandSpec> = {
  'box create': {
    summary: 'Create a box; --size small (2 vCPU, 8 GB), medium (4, 16) or large (8, 32), else your default size; --disk 50 to 300 GB, else 120',
    usage: 'termag box create <name> [--size small|medium|large] [--disk <GB>] [--wait] [--timeout <seconds>] [--if-not-exists] [--for-ask] [--minimal]',
    options: { size, disk, wait, timeout, 'if-not-exists': ifNotExists, 'for-ask': forAsk, minimal: { type: 'boolean' } as const },
    maxArgs: 1,
  },
  'box start': {
    summary: 'Start a stopped box; its projects come back on their own',
    usage: 'termag box start <box> [--wait] [--timeout <seconds>]',
    options: { wait, timeout },
    maxArgs: 1,
  },
  'box stop': { summary: 'Stop a box, keeping its disk and projects', usage: 'termag box stop <box>', maxArgs: 1 },
  'box keep': {
    summary: 'Keep a running box up: restart its idle clock, as using it would, so auto-park waits another full limit',
    usage: 'termag box keep <box>',
    maxArgs: 1,
  },
  'box set': {
    summary: 'Change box settings: --auto-park parks it after that long idle, --terminate-after terminates it after that long parked',
    usage: 'termag box set <box> [--auto-park <hours>h|off] [--terminate-after <days>d|off]',
    options: { 'auto-park': { type: 'string' }, 'terminate-after': { type: 'string' } },
    maxArgs: 1,
  },
  'box rename': {
    summary: 'Rename a box; its projects stay on it, now named <new-name>/<project>',
    usage: 'termag box rename <box> <new-name>',
    maxArgs: 2,
  },
  'box resize': {
    summary: 'Resize a box to small (2 vCPU, 8 GB), medium (4, 16) or large (8, 32): it stops for two to three minutes, '
      + 'and running turns stop with it; a stopped or hibernated box is resized and left stopped',
    usage: 'termag box resize <box> <small|medium|large> [--force] [--wait] [--timeout <seconds>] [--yes]',
    options: { force: { type: 'boolean' }, wait, timeout },
    maxArgs: 2,
  },
  'box rm': {
    summary: 'Terminate a box and archive its projects',
    usage: 'termag box rm <box> [--yes]',
    maxArgs: 1,
  },
  'project create': {
    summary: 'Create a project on a box, or on a new box with --new-box (at --size, else the repository\'s or your default size)',
    usage: 'termag project create <box>/<name> --agent <agent> [--from <template|github-url|box/project>] [--new-box [--size small|medium|large] [--disk <GB>] [--timeout <seconds>]] [--if-not-exists] [--for-ask]',
    options: { agent: { type: 'string' }, from: { type: 'string' }, 'new-box': { type: 'boolean' }, size, disk, timeout, 'if-not-exists': ifNotExists, 'for-ask': forAsk },
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
  'box mv': 'box rename',
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

export function timeoutSeconds(args: ParsedArgs, fallback: number): number {
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

/** --size, checked here so a typo is a usage error before anything is asked of the orchestrator; undefined without it. */
function sizeOption(args: ParsedArgs): string | undefined {
  const raw = args.options.size;
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!SIZES.includes(value)) throw usage(`--size takes ${SIZES.join(', ')}`);
  return value;
}

/**
 * --disk, the new box's root disk in GB: a whole number from 50 to 300, checked
 * here so a typo is a usage error before anything is asked of the
 * orchestrator; undefined without it, when the box gets the repository's or 120.
 */
export function diskOption(args: ParsedArgs): number | undefined {
  const raw = args.options.disk;
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!(value >= DISK_GIB.min && value <= DISK_GIB.max)) throw usage(`--disk takes a whole number of GB from ${DISK_GIB.min} to ${DISK_GIB.max}`);
  return value;
}

/**
 * POST /boxes, or with --if-not-exists the box of that name when there is one
 * (whatever its size). A box whose launch failed isn't taken: the POST goes
 * ahead, and the orchestrator retires it and launches a new one, unless a
 * project waits on it (a 409; projectOnNewBox retries that project). `from`: what the project made on it starts from, so the
 * orchestrator can give the box that repository's default size and disk. `forAsk`: the
* orchestrator can give the box that repository's default size and disk. `forAsk`: the
 * box is made only to run asks in (--for-ask). `minimal`: the box-min flavor —
 * the lean Component=box-min image and no warm-pool claim; --size still sets
 * the instance type and --disk the disk, but nothing lands on the box but the
 * box contract (you bootstrap the rest; the termag-herdr pattern).
 */
export async function ensureBox(
  api: Api, name: string, ifNotExists: boolean, launch: { size?: string; diskGiB?: number; from?: string | string[]; forAsk?: boolean; minimal?: boolean } = {},
): Promise<MadeBox> {

  const existing = async () => (await listBoxes(api)).find(b => b.name === name) ?? null;
  const found = ifNotExists ? await existing() : null;
  if (found && found.state !== 'failed') return { box: found, created: false, claimed: false, warnings: [] };
  const body: Record<string, string | string[] | number | boolean> = { name };
  if (launch.size) body.size = launch.size;
  if (launch.diskGiB !== undefined) body.diskGiB = launch.diskGiB;
  if (launch.from) body.from = launch.from;
  if (launch.forAsk) body.createdFor = 'ask';
  // --minimal: launch the lean Component=box-min image instead of the full
  // bake, and bootstrap the box yourself (the termag-herdr pattern).
  if (launch.minimal) body.flavor = 'minimal';
  try {
    const res = await api.request<{ box: Box; claimed: boolean; warnings?: string[] }>('POST', '/boxes', body);
    return { box: res.box, created: true, claimed: res.claimed, warnings: res.warnings ?? [] };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { box: raced, created: false, claimed: false, warnings: [] };
  }
}

export interface MadeBox {
  box: Box;
  created: boolean;
  claimed: boolean;
  /** What of the repo's .termag/environment.json the orchestrator left out, and why; never an error. */
  warnings: string[];
}

/** The create's size warnings, on stderr: the box was made either way. */
function warnSizing(ctx: Ctx, made: Pick<MadeBox, 'warnings'>): void {
  for (const w of made.warnings) ctx.err(`termag: warning: ${w}`);
}

async function cmdBoxCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = arg(args, 0, 'the box name', 'box create');
  boxRef(name);
  checkName(name, 'box');
  const size = sizeOption(args);
  const diskGiB = diskOption(args);
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  if (args.options['for-ask'] === true) ctx.err(FOR_ASK_DEPRECATED);
  const ensured = await ensureBox(api, name, args.options['if-not-exists'] === true, { size, diskGiB, forAsk: args.options['for-ask'] === true, minimal: args.options.minimal === true });
  const { box: made, created, claimed } = ensured;
  warnSizing(ctx, ensured);
  const box = args.options.wait ? await waitForRunning(ctx, api, made, timeoutS, args.json) : made;
  const sizeText = boxSpecText(box);
  const sized = sizeText ? `, ${sizeText}` : '';
  const flavorWord = box.flavor === 'minimal' ? 'minimal ' : '';
  let text: string;
  if (!created) text = `Box ${box.name} already exists (${box.state}${sized}).`;
  else if (args.options.wait) text = `Created ${flavorWord}box ${box.name}${sizeText ? ` (${sizeText})` : ''}; it is running.`;
  else if (box.state === 'running') text = `Created ${flavorWord}box ${box.name} (running${sized}).`;
  else text = `Creating ${flavorWord}box ${box.name} (${box.state}${sized}); \`termag box create ${box.name} --wait --if-not-exists\` waits for it.`;
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
  try {
    return { box: (await api.request<{ box: Box }>('POST', `/boxes/${encodeURIComponent(box.id)}/start`)).box, started: true };
  } catch (err) {
    // Another start got there first (two ssh connections waking one box): the 409 is that start's, not a failure.
    if (!(err instanceof CliError) || err.code !== 'conflict') throw err;
    const now = (await listBoxes(api)).find(b => b.id === box.id);
    if (now?.state === 'starting' || now?.state === 'running') return { box: now, started: false };
    throw err;
  }
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

export { CREATE_WAIT_S, PARKED, START_WAIT_S };

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

const RESIZE_WAIT_S = 30 * 60;

/** What `box resize --wait` prints for each phase (backend services/boxResizePolicy.ts ResizePhase). */
const RESIZE_PHASE_TEXT: Record<string, string> = {
  resuming: 'resuming it from hibernation, so it can be stopped plainly',
  stopping: 'stopping',
  resizing: 'changing its instance type',
  starting: 'starting, waiting for its agent',
};

/** Poll the box list until its resize is no longer running; one stderr line per phase. */
async function waitForResize(ctx: Ctx, api: Api, box: Box, timeoutS: number, quiet: boolean): Promise<Box> {
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_MS;
  let last = '';
  let current = box;
  for (;;) {
    const r = current.resize;
    if (!r?.running) return current;
    const label = (r.phase && RESIZE_PHASE_TEXT[r.phase]) ?? r.phase ?? 'resizing';
    if (!quiet && label !== last) ctx.err(`${current.name}: ${label} (${formatDuration(Date.now() - started)})`);
    last = label;
    if (Date.now() >= deadline) {
      throw new CliError('timeout', `Timed out after ${formatDuration(timeoutS * 1000)}; ${current.name} is still being resized (${label})`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
    const next = (await listBoxes(api)).find(b => b.id === box.id);
    if (!next) throw new CliError('not_found', `Box ${box.name} is gone`);
    current = next;
  }
}

async function cmdBoxResize(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box resize');
  const raw = arg(args, 1, 'the size', 'box resize').trim().toLowerCase();
  if (!SIZES.includes(raw)) throw usage(`The size is one of ${SIZES.join(', ')}, not "${raw}" (sizes only, never an instance type)`);
  const timeoutS = timeoutSeconds(args, RESIZE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  const found = await resolveBox(api, ref);
  if (found.size === raw) return emitBox(ctx, args, found, { resized: false }, `${found.name} is already ${raw}.`);
  const down = found.state === 'stopped' || found.state === 'hibernated';
  await confirmOrRefuse(ctx, args, down
    ? `Resize ${found.name} to ${raw}? It is ${found.state}, and stays stopped.`
    : `Resize ${found.name} to ${raw}? It stops for two to three minutes, and anything running on it stops.`);
  const send = (force: boolean) => api.request<{ box: Box; resize: NonNullable<Box['resize']> }>(
    'POST', `/boxes/${encodeURIComponent(found.id)}/resize`, { size: raw, ...(force ? { force: true } : {}) });
  let res: { box: Box; resize: NonNullable<Box['resize']> };
  try {
    res = await send(args.options.force === true);
  } catch (err) {
    // Something is running on it: say what, and resize anyway only when told to.
    const body = err instanceof CliError ? err.body : undefined;
    if (!(body?.code === 'box_busy' && body.forceable === true)) throw err;
    const reasons = Array.isArray(body.blockers) ? (body.blockers as Array<{ reason: string }>).map(b => b.reason) : [];
    if (!args.yes && ctx.interactive && ctx.confirm) {
      for (const r of reasons) ctx.err(`  ${found.name}: ${r}`);
      if (!(await ctx.confirm(`Resize ${found.name} anyway? [y/N] `))) throw new CliError('failed', 'Cancelled');
    } else {
      throw new CliError('conflict', `${(err as Error).message} Pass --force to resize anyway.`, (err as CliError).status, body);
    }
    res = await send(true);
  }
  let box = res.box ?? found;
  if (!args.options.wait) {
    return emitBox(ctx, args, box, { resize: res.resize },
      `Resizing ${box.name} to ${raw}; \`termag box list\` shows when it is done, or run with --wait.`);
  }
  box = await waitForResize(ctx, api, box, timeoutS, args.json);
  const r = box.resize;
  if (r?.phase === 'failed') {
    if (args.json) ctx.out(json({ box, resize: r }));
    throw new CliError('failed', `Resizing ${box.name} failed: ${r.error ?? 'no reason given'}`);
  }
  const text = r?.phase === 'stopped'
    ? `${box.name} is now ${box.size ?? raw} (${box.instanceType ?? 'type unknown'}) and stopped; \`termag box start ${box.name}\` starts it.`
    : `${box.name} is now ${box.size ?? raw} (${box.instanceType ?? 'type unknown'}) and running.`;
  return emitBox(ctx, args, box, { resize: r }, text);
}

async function cmdBoxKeep(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box keep');
  const api = await lifecycleApi(ctx, args);
  const box = await resolveBox(api, ref);
  const { lifecycle } = await api.request<{ lifecycle: LifecycleView }>('POST', `/boxes/${encodeURIComponent(box.id)}/keep-running`);
  if (args.json) {
    ctx.out(json({ box: { id: box.id, name: box.name }, lifecycle }));
    return EXIT.OK;
  }
  const hours = lifecycle.idleLimitHours;
  ctx.out(hours ? `Kept ${box.name} running: it parks after another ${hours} h with no activity.` : `Kept ${box.name} running.`);
  return EXIT.OK;
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
  // The idle hours in effect and where they came from; an orchestrator from
  // before box-idle-park-hours leaves them out.
  idleLimitHours?: number | null;
  idleLimitSource?: 'own' | 'default' | null;
}

/**
 * What auto-park does on the box now, in one sentence. Its own hours stop it;
 * with none, box-idle-stop-enabled's window can still stop it.
 */
export function autoParkLine(name: string, lc: LifecycleView): string {
  if (lc.idleLimitSource === 'default') return `${name} has no idle setting of its own, so it is stopped after ${lc.idleLimitHours} h idle.`;
  const hours = lc.idleHibernateHours;
  if (hours === null) return `Auto-park is off for ${name}.`;
  return `${name} is stopped after ${hours} h idle.`;
}

/** What --terminate-after does on the box now, in one sentence. */
export function terminateAfterLine(name: string, lc: LifecycleView): string {
  const days = lc.hibernatedTerminateDays;
  if (days === null) return `${name} is never terminated automatically.`;
  const span = `${days} ${days === 1 ? 'day' : 'days'}`;
  return `${name} is terminated ${span} after auto-park stops it, or 90 days by default while it has work that isn't pushed anywhere.`;
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
  if ('idleHibernateHours' in settings) ctx.out(autoParkLine(box.name, lifecycle));
  if ('hibernatedTerminateDays' in settings) ctx.out(terminateAfterLine(box.name, lifecycle));
  return EXIT.OK;
}

async function cmdBoxRename(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box rename');
  const newName = boxRef(arg(args, 1, 'the new name', 'box rename'));
  checkName(newName, 'box');
  const api = await lifecycleApi(ctx, args);
  const found = await resolveBox(api, ref);
  if (found.name === newName) return emitBox(ctx, args, found, { renamedFrom: found.name }, `${found.name} already has that name.`);
  const { box } = await api.request<{ box: Box }>('POST', `/boxes/${encodeURIComponent(found.id)}/rename`, { name: newName });
  if (!args.json) ctx.err(`ssh reaches it as termag-${box.name} now; re-run \`termag ssh-config --install\` if your ssh config names termag-${found.name}.`);
  return emitBox(ctx, args, box, { renamedFrom: found.name }, `Renamed ${found.name} to ${box.name}.`);
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

export interface ProjectCreated {
  project: Project;
  created: boolean;
  /** A multi-repo project's checkouts, in `--from` order; absent for any other. */
  repos?: Array<{ name: string; url: string }>;
  /** The repo a fresh project is cloned from; null for an empty or un-archived one, or an orchestrator that predates `from`. */
  repoUrl: string | null;
  restored: boolean;
}

/** POST /projects, or with --if-not-exists the project of that name on the box when there is one. */
export async function ensureProject(
  api: Api, box: Box, input: { name: string; agent: string; from?: string | string[]; forAsk?: boolean }, ifNotExists: boolean,
): Promise<ProjectCreated> {
  const existing = async () => projectIn(await listProjects(api), box, input.name);
  const found = ifNotExists ? await existing() : null;
  if (found) return { project: found, created: false, repoUrl: null, restored: false };
  const body: Record<string, string | string[]> = { boxId: box.id, name: input.name, agent: input.agent };
  if (input.from?.length) body.from = input.from;
  if (input.forAsk) body.createdFor = 'ask';
  try {
    const res = await api.request<{ project: Project; repoUrl?: string | null; restored?: boolean; repos?: Array<{ name: string; url: string }> }>('POST', '/projects', body);
    return { project: res.project, created: true, repoUrl: res.repoUrl ?? null, restored: res.restored === true, ...(res.repos ? { repos: res.repos } : {}) };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { project: raced, created: false, repoUrl: null, restored: false };
  }
}

/** A `--from` the new project did not take: an un-archived project, or an orchestrator from before `from`. */
function warnUnusedFrom(ctx: Ctx, from: string | string[] | undefined, result: ProjectCreated): void {
  if (!from?.length || !result.created || result.repoUrl) return;
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
  if (!newBox && args.options.size !== undefined) throw usage('--size goes with --new-box; an existing box keeps its size');
  if (!newBox && args.options.disk !== undefined) throw usage('--disk goes with --new-box; an existing box keeps its disk');
  const size = sizeOption(args);
  const diskGiB = diskOption(args);
  if (newBox) checkName(ref.box, 'box');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const ifNotExists = args.options['if-not-exists'] === true;
  const api = await lifecycleApi(ctx, args);
  const input = { name: ref.project, agent, from, forAsk: args.options['for-ask'] === true };
  if (input.forAsk) ctx.err(FOR_ASK_DEPRECATED);

  if (!newBox) {
    const box = await resolveBox(api, ref.box);
    const result = await ensureProject(api, box, input, ifNotExists);
    warnUnusedFrom(ctx, from, result);
    return emitProject(ctx, args, result.project, { created: result.created, repoUrl: result.repoUrl }, createdText(result, agent));
  }

  const made = await projectOnNewBox(ctx, api, ref, input, { size, diskGiB, ifNotExists, timeoutS, quiet: args.json });
  const boxText = made.boxCreated ? `Created box ${made.box.name}. ` : '';
  if (args.json) {
    ctx.out(json({ box: made.box, boxCreated: made.boxCreated, claimed: made.claimed, project: made.result.project, created: made.result.created, repoUrl: made.result.repoUrl }));
  } else {
    ctx.out(boxText + createdText(made.result, agent));
  }
  return EXIT.OK;
}

export interface NewBoxProject {
  /** The box as last seen: running, or (startParked) parked with the project already on it. */
  box: Box;
  boxCreated: boolean;
  claimed: boolean;
  result: ProjectCreated;
}

/**
 * The web form's "a new box…": create the box and, while it provisions, the
 * project, which the orchestrator sets up when the box's agent connects (so
 * an interrupted wait loses nothing). An orchestrator from before that
 * refuses an empty project until the agent is up; that one gets it after the
 * wait, as before. `project create --new-box` and `termag ask --new-box` both
 * come here; the ask passes `startParked`, so an existing box that is stopped
 * is left for the ask to wake when the project is already on it, and started
 * here when it isn't.
 */
export async function projectOnNewBox(
  ctx: Ctx, api: Api, ref: { box: string; project: string },
  input: { name: string; agent: string; from?: string | string[]; forAsk?: boolean },
  opts: { size?: string; diskGiB?: number; ifNotExists: boolean; timeoutS: number; quiet: boolean; startParked?: boolean; retry?: string },
): Promise<NewBoxProject> {
  const { agent, from } = input;
  const ifNotExists = opts.ifNotExists;
  let made = await ensureBox(api, ref.box, ifNotExists, { size: opts.size, diskGiB: opts.diskGiB, from: from?.length ? from : undefined, forAsk: input.forAsk });
  warnSizing(ctx, made);
  if (made.box.state === 'failed' && ifNotExists) made = await relaunchFailed(ctx, api, made, ref, input.name, opts.quiet);
  if (!opts.quiet) {
    const sizeText = boxSpecText(made.box);
    const sized = sizeText ? ` (${sizeText})` : '';
    ctx.err(made.created
      ? `Created box ${made.box.name}${sized}${made.claimed ? ' (a warm box, ready now)' : ''}; ${ref.box}/${ref.project} is set up on it once it is running.`
      : `Using the existing box ${made.box.name} (${made.box.state}).`);
  }
  const refused = (err: CliError, boxName: string, state: string) => {
    const retry = opts.retry ?? `termag project create ${boxName}/${ref.project} --agent ${agent}${from ? ` --from ${[from].flat().join(' --from ')}` : ''}`;
    return new CliError(err.code, `Box ${boxName} is ${state}, but the project was not created: ${err.message.replace(/\.$/, '')}. Retry with \`${retry}\``);
  };
  const done = (box: Box, result: ProjectCreated): NewBoxProject => ({ box, boxCreated: made.created, claimed: made.claimed, result });
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
  if (opts.startParked && PARKED.has(made.box.state)) {
    // Already there: the ask starts the box itself (the orchestrator holds it until the box is up).
    const there = ifNotExists ? projectIn(await listProjects(api), made.box, input.name) : null;
    if (there) return done(made.box, { project: there, created: false, repoUrl: null, restored: false });
    box = (await startAndWait(ctx, api, made.box, opts.timeoutS, opts.quiet)).box;
  } else {
    try {
      box = await waitForRunning(ctx, api, made.box, opts.timeoutS, opts.quiet);
    } catch (err) {
      if (!(result && err instanceof CliError && err.code === 'failed')) throw err;
      throw new CliError(err.code, `${err.message.replace(/\.$/, '')}. ${result.project.ref} waits on it: Retry on the project in the web UI launches a new box.`);
    }
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
  return done(box, result);
}

/**
 * The box of that name failed to launch and its project waits on it, so the
 * orchestrator would not replace it on a create: the project's Retry
 * (POST /projects/:id/clone/retry) launches a new box of the same name and
 * size and moves the project onto it. Without that project the box is left
 * as it is, for waitForRunning to report.
 */
async function relaunchFailed(
  ctx: Ctx, api: Api, made: MadeBox, ref: { box: string; project: string }, project: string, quiet: boolean,
): Promise<MadeBox> {
  const waiting = projectIn(await listProjects(api), made.box, project);
  if (!waiting) return made;
  if (!quiet) ctx.err(`Box ${made.box.name} failed to launch; relaunching it with ${ref.box}/${ref.project}.`);
  const res = await api.request<{ project: Project }>('POST', `/projects/${encodeURIComponent(waiting.id)}/clone/retry`, {});
  const fresh = (await listBoxes(api)).find(b => b.id === res.project.box.id);
  if (!fresh) throw new CliError('not_found', `Box ${made.box.name} was relaunched, but the new box is not listed yet; run the command again`);
  return { box: fresh, created: true, claimed: false, warnings: [] };
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
  'box keep': cmdBoxKeep,
  'box set': cmdBoxSet,
  'box rename': cmdBoxRename,
  'box resize': cmdBoxResize,
  'box rm': cmdBoxRm,
  'project create': cmdProjectCreate,
  'project rename': cmdProjectRename,
  'project archive': cmdProjectArchive,
};
