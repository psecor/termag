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
/**
 * termag setup on or off for a new box: --no-setup, or
 * --setup whatever the repository's environment.json says. Not --minimal,
 * which a lean image is to use.
 */
const setup = { type: 'boolean' } as const;
const noSetup = { type: 'boolean' } as const;

/** What setup off leaves to the box's owner, said wherever one is made. */
export const SETUP_OFF_NOTE = 'termag delivers no skills, agent config or credentials there: set the box up yourself.';

export const FOR_ASK_DEPRECATED = 'termag: --for-ask is deprecated: `termag ask --new-box <box>/<project> <prompt|->` makes the box and the project for an ask, and asks, in one command';

export const LIFECYCLE_COMMANDS: Record<string, CommandSpec> = {
  'box create': {
    summary: 'Create a box; --size small (2 vCPU, 8 GB), medium (4, 16) or large (8, 32), else your default size; --disk 50 to 300 GB, else 120; --minimal for the lean image; --no-setup to turn termag setup off',
    usage: 'termag box create <name> [--size small|medium|large] [--disk <GB>] [--from <github-url>] [--setup|--no-setup] [--wait] [--timeout <seconds>] [--if-not-exists] [--for-ask] [--minimal]',
    options: { size, disk, from: { type: 'string' }, setup, 'no-setup': noSetup, wait, timeout, 'if-not-exists': ifNotExists, 'for-ask': forAsk, minimal: { type: 'boolean' } as const },
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
      + 'and running turns stop with it; a stopped or hibernated box is resized and left stopped. '
      + '--disk grows its disk (up to 300 GB, never smaller, once every six hours) with the box up',
    usage: 'termag box resize <box> [small|medium|large] [--disk <GB>] [--force] [--wait] [--timeout <seconds>] [--yes]',
    options: { force: { type: 'boolean' }, wait, timeout, disk },
    maxArgs: 2,
  },
  'box rm': {
    summary: 'Terminate a box and archive its projects',
    usage: 'termag box rm <box> [--yes]',
    maxArgs: 1,
  },
  'project create': {
    summary: 'Create a project on a box, or on a new box with --new-box (at --size, else the repository\'s or environment\'s or your default size)',
    usage: 'termag project create <box>/<name> --agent <agent> [--model opus|sonnet|haiku] [--from <template|github-url|box/project> | --environment <name>] [--new-box [--size small|medium|large] [--disk <GB>] [--setup|--no-setup] [--timeout <seconds>]] [--if-not-exists] [--for-ask]',
    options: { agent: { type: 'string' }, model: { type: 'string' }, from: { type: 'string' }, environment: { type: 'string' }, 'new-box': { type: 'boolean' }, size, disk, setup, 'no-setup': noSetup, timeout, 'if-not-exists': ifNotExists, 'for-ask': forAsk },
    details: '--environment <name>  Start from an environment: the project holds its repositories, a\n'
      + "                      multi-repo project for two or more, and with --new-box the box is sized by its definition\n"
      + '                      (--size and --disk still win). Instead of --from.\n'
      + '--model <tier>        The Claude model its main workstream starts on, in its agent pane and its chat: opus,\n'
      + '                      sonnet or haiku. Claude Code (--agent claude) only; without it, the default.',
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

export async function listProjects(api: Api): Promise<Project[]> {
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

/** --environment's name, lower case; undefined without it. The orchestrator says whether there is one. */
export function environmentOption(args: ParsedArgs): string | undefined {
  const raw = args.options.environment;
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw usage('--environment takes an environment\'s name (lowercase letters, digits and -)');
  return value;
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
 * --setup or --no-setup, checked here so both at once is a
 * usage error before anything is asked of the orchestrator; undefined
 * without either, when a repository's environment.json may decide.
 */
function setupOption(args: ParsedArgs): boolean | undefined {
  if (args.options.setup === true && args.options['no-setup'] === true) throw usage('--setup and --no-setup contradict each other');
  return args.options.setup === true ? true : args.options['no-setup'] === true ? false : undefined;
}

/**
 * POST /boxes, or with --if-not-exists the box of that name when there is one
 * (whatever its size, disk or termag setup). A box whose launch failed isn't taken:
 * the POST goes ahead, and the orchestrator retires it and launches a new one,
 * unless a project waits on it (a 409; projectOnNewBox retries that project).
 * `from`: what the project made on it starts from, so the orchestrator can
 * give the box that repository's default size, disk and termag setup; this
 * CLI states the setup (stateSetup), so it sends `useRepoSetup`.
 * `setupEnabled`: --setup or --no-setup, which win over it. `forAsk`: the box
 * is made only to run asks in (--for-ask). `minimal`: the box-min flavor —
 * the lean Component=box-min image and no warm-pool claim; --size still sets
 * the instance type and --disk the disk, but nothing lands on the box but the
 * box contract (you bootstrap the rest; the termag-herdr pattern).
 */
export async function ensureBox(
  api: Api, name: string, ifNotExists: boolean,
  launch: { size?: string; diskGiB?: number; from?: string | string[]; environment?: string; forAsk?: boolean; setupEnabled?: boolean; minimal?: boolean } = {},
): Promise<MadeBox> {

  const existing = async () => (await listBoxes(api)).find(b => b.name === name) ?? null;
  const found = ifNotExists ? await existing() : null;
  if (found && found.state !== 'failed') return { box: found, created: false, claimed: false, warnings: [], repoSetup: null };
  const body: Record<string, string | string[] | number | boolean> = { name };
  if (launch.size) body.size = launch.size;
  if (launch.diskGiB !== undefined) body.diskGiB = launch.diskGiB;
  if (launch.from) body.from = launch.from;
  if (launch.environment) body.environment = launch.environment;
  if (launch.forAsk) body.createdFor = 'ask';
  if (launch.setupEnabled !== undefined) body.setupEnabled = launch.setupEnabled;
  if (launch.from) body.useRepoSetup = true;
  // --minimal: launch the lean Component=box-min image instead of the full
  // bake, and bootstrap the box yourself (the termag-herdr pattern).
  if (launch.minimal) body.flavor = 'minimal';
  try {
    const res = await api.request<{ box: Box; claimed: boolean; pool?: 'environment'; warnings?: string[]; repoSetup?: RepoSetup; disk?: DiskNote }>('POST', '/boxes', body);
    return { box: res.box, created: true, claimed: res.claimed, ...(res.pool ? { pool: res.pool } : {}), warnings: res.warnings ?? [], repoSetup: res.repoSetup ?? null, disk: res.disk ?? null };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { box: raced, created: false, claimed: false, warnings: [], repoSetup: null };
  }
}

export interface MadeBox {
  box: Box;
  created: boolean;
  claimed: boolean;
  /** `environment`: claimed from an environment pool (a stopped box with its setup run), not the warm pool. */
  pool?: 'environment';
  /** What of the repo's .termag/environment.json the orchestrator left out, and why; never an error. */
  warnings: string[];
  /** The repos' environment.json turned termag setup off (null when not, or it can't be off for you), and whether the box has it off. */
  repoSetup: RepoSetup | null;
  /** The disk asked for (or the repo's) against the image's floor: what the box gets, and whether it was raised. */
  disk?: DiskNote | null;
}

interface RepoSetup { setupEnabled: false; repos: string[]; applied: boolean }

/** The 201's `disk` (backend services/boxImageFloor.ts). `floorKnown: false`: the launch may still raise it. */
interface DiskNote { requestedGiB: number; diskGiB: number; raised: boolean; floorKnown: boolean }

/**
 * A disk under the image's own snapshot is never raised silently: one line on
 * stderr from the 201's `disk`, or, once the box has launched (`launched`),
 * from the disk it got. `asked`: --disk.
 */
export function stateDisk(ctx: Ctx, made: Pick<MadeBox, 'created' | 'disk'>, box: Pick<Box, 'diskGiB'>, asked: number | undefined, launched: boolean): void {
  if (!made.created) return;
  const note = made.disk ?? null;
  const requested = note?.requestedGiB ?? asked;
  if (requested === undefined) return;
  const got = Math.max(note?.diskGiB ?? requested, launched && box.diskGiB ? box.diskGiB : 0);
  const what = asked !== undefined ? `--disk ${requested}` : `a ${requested} GB disk`;
  if (got > requested) ctx.err(`termag: ${what} is below the image's ${got} GB minimum; using ${got} GB`);
  else if (note && !note.floorKnown && !launched) ctx.err(`termag: ${what} may be raised to the image's minimum when the box launches; \`termag box list\` shows the disk it got`);
}

/**
 * A repository's setupEnabled is never applied silently:
 * the create says on stderr when the box has setup off because of it, or on
 * though it asked for off. `asked`: --setup or --no-setup; `override`
 * replaces the --setup line, for a caller that turned it on itself (an ask).
 */
function stateSetup(ctx: Ctx, made: Pick<MadeBox, 'box' | 'created' | 'repoSetup'>, asked: boolean | undefined, override?: string): void {
  const rs = made.repoSetup;
  if (!made.created || !rs) return;
  const where = `${rs.repos.join(', ')}'s .termag/environment.json ${rs.repos.length > 1 ? 'say' : 'says'} "setupEnabled": false`;
  if (rs.applied) ctx.err(`termag: ${made.box.name} has termag setup off: ${where}; \`--setup\` turns it on. ${SETUP_OFF_NOTE}`);
  else if (override) ctx.err(`termag: ${where}, but ${override}`);
  else if (asked === true) ctx.err(`termag: ${made.box.name} has termag setup on (--setup), though ${where}.`);
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
  const setupEnabled = setupOption(args);
  const from = typeof args.options.from === 'string' ? args.options.from.trim() || undefined : undefined;
  if (args.options.from !== undefined && !from) throw usage('--from takes a GitHub repository URL');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  if (args.options['for-ask'] === true) ctx.err(FOR_ASK_DEPRECATED);
  const ensured = await ensureBox(api, name, args.options['if-not-exists'] === true, { size, diskGiB, from, setupEnabled, forAsk: args.options['for-ask'] === true, minimal: args.options.minimal === true });
  const { box: made, created, claimed } = ensured;
  warnSizing(ctx, ensured);
  stateSetup(ctx, ensured, setupEnabled);
  const box = args.options.wait ? await waitForRunning(ctx, api, made, timeoutS, args.json) : made;
  stateDisk(ctx, ensured, box, diskGiB, args.options.wait === true || box.state === 'running');
  const sizeText = boxSpecText(box);
  const sized = sizeText ? `, ${sizeText}` : '';
  const flavorWord = box.flavor === 'minimal' ? 'minimal ' : '';
  let text: string;
  const off = box.setupEnabled === false ? ', termag setup off' : '';
  if (!created) text = `Box ${box.name} already exists (${box.state}${sized}${off}).`;
  else if (args.options.wait) text = `Created ${flavorWord}box ${box.name}${sizeText || off ? ` (${sizeText}${sizeText ? off : off.slice(2)})` : ''}; it is running.`;
  else if (box.state === 'running') text = `Created ${flavorWord}box ${box.name} (running${sized}${off}).`;
  else text = `Creating ${flavorWord}box ${box.name} (${box.state}${sized}${off}); \`termag box create ${box.name} --wait --if-not-exists\` waits for it.`;
  if (created && off && !ensured.repoSetup?.applied) text += ` ${SETUP_OFF_NOTE}`;
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
  disk: 'waiting for its disk to grow',
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

/** "from 120 GB to 200 GB", or "to 200 GB" when the box's disk isn't recorded. */
function diskChange(box: Box, toGb: number): string {
  return box.diskGiB ? `from ${box.diskGiB} GB to ${toGb} GB` : `to ${toGb} GB`;
}

/**
 * POST /boxes/:id/disk (backend services/boxDisk.ts): grows the box's root
 * disk with the box up. The orchestrator refuses a shrink, more than 300 GB,
 * a box that isn't running and EBS's second change inside six hours, each
 * with a reason that is printed as it is.
 */
async function growDisk(api: Api, box: Box, sizeGb: number): Promise<{ box: Box; grow: unknown; alreadyGb?: number }> {
  // 200 with `alreadyGb`: the disk already has that size, and nothing was done.
  return api.request<{ box: Box; grow: unknown; alreadyGb?: number }>('POST', `/boxes/${encodeURIComponent(box.id)}/disk`, { sizeGb });
}

async function cmdBoxResize(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = arg(args, 0, 'the box', 'box resize');
  const diskGb = diskOption(args);
  const given = args.args[1];
  if (given === undefined && diskGb === undefined) {
    throw usage(`Give the size, --disk <GB>, or both. Usage: ${LIFECYCLE_COMMANDS['box resize'].usage}`);
  }
  const raw = given === undefined ? null : given.trim().toLowerCase();
  if (raw !== null && !SIZES.includes(raw)) throw usage(`The size is one of ${SIZES.join(', ')}, not "${raw}" (sizes only, never an instance type)`);
  const timeoutS = timeoutSeconds(args, RESIZE_WAIT_S);
  const api = await lifecycleApi(ctx, args);
  const found = await resolveBox(api, ref);
  // Only the disk: the box stays up, so there is nothing to wait for or force.
  if (raw === null || (found.size === raw && diskGb !== undefined)) {
    await confirmOrRefuse(ctx, args,
      `Grow ${found.name}'s disk ${diskChange(found, diskGb!)}? It stays up; a disk never shrinks, and EBS allows one change to it every six hours.`);
    const grown = await growDisk(api, found, diskGb!);
    if (grown.alreadyGb !== undefined) {
      return emitBox(ctx, args, grown.box ?? found, { grow: null, alreadyGb: grown.alreadyGb }, `${found.name}'s disk is already ${grown.alreadyGb} GB; nothing to grow.`);
    }
    return emitBox(ctx, args, grown.box ?? found, { grow: grown.grow },
      `Growing ${found.name}'s disk ${diskChange(found, diskGb!)}; it stays up, and \`termag box list\` shows the new size once it has grown.`);
  }
  if (found.size === raw) return emitBox(ctx, args, found, { resized: false }, `${found.name} is already ${raw}.`);
  const down = found.state === 'stopped' || found.state === 'hibernated';
  const diskFirst = diskGb === undefined ? '' : ` Its disk grows ${diskChange(found, diskGb)} first (never smaller again, and once every six hours).`;
  await confirmOrRefuse(ctx, args, down
    ? `Resize ${found.name} to ${raw}? It is ${found.state}, and stays stopped.${diskFirst}`
    : `Resize ${found.name} to ${raw}? It stops for two to three minutes, and anything running on it stops.${diskFirst}`);
  // The disk first, with the box up: a refusal (EBS's six hours, say) stops here, before anything stops.
  // The resize waits for the grow before it stops the box (backend boxResize.ts, phase `disk`).
  let grow: unknown;
  let diskGrows = diskGb !== undefined;
  if (diskGb !== undefined) {
    const grown = await growDisk(api, found, diskGb);
    grow = grown.grow;
    // Already that size: nothing grew, so the messages below speak of the resize alone.
    if (grown.alreadyGb !== undefined) diskGrows = false;
  }
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
  const extra = diskGb === undefined ? {} : { grow };
  if (!args.options.wait) {
    const what = !diskGrows || diskGb === undefined ? `Resizing ${box.name} to ${raw}` : `Growing ${found.name}'s disk ${diskChange(found, diskGb)}, then resizing it to ${raw}`;
    return emitBox(ctx, args, box, { resize: res.resize, ...extra },
      `${what}; \`termag box list\` shows when it is done, or run with --wait.`);
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
  return emitBox(ctx, args, box, { resize: r, ...extra }, text);
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
 * with none, the default window can still stop it.
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
  // Every project the remove archives, a space orchestrator's named as one.
  const projects = box.projects.map(p => (p.label ? `${p.name} (${p.label})` : p.name));
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
  /** What of an environment's definition the orchestrator left out, and why; never an error. */
  warnings?: string[];
}

/** What a project is made from: `from` (one source, or several for a multi-repo project) or an `environment`'s repositories. */
/** An environment's checkout as GET /environments/:ref/resolved lists it: a repository at its branch (absent: the default). */
export interface EnvironmentCheckout { repo: string; branch?: string }

export interface ProjectInput {
  name: string; agent: string; from?: string | string[]; environment?: string; forAsk?: boolean;
  /** --model: the Claude tier the project's main workstream starts on (its pane and its chat); Claude Code's agents only. */
  model?: string;
  /**
   * The environment's checkouts, which the create is held to: read by
   * ensureProject (pinEnvironment) only when it makes the project, once, and
   * kept here for a retry of the same create.
   */
  environmentRepos?: EnvironmentCheckout[];
}

/**
 * An environment's checkouts now, said on stderr (with --json too, which
 * leaves stderr to the caller): what any ask of a project made from it runs
 * without asking, so they are said before it is made. Anyone can edit a shared
 * environment, so the create also names them and the orchestrator refuses (409
 * environment_repos_changed) when it resolves to anything else by then
 * (backend services/environments.ts withEnvironmentRepos): a guard against an
 * edit in between, not a sign anyone looked.
 */
export async function pinEnvironment(ctx: Ctx | null, api: Api, name: string): Promise<EnvironmentCheckout[]> {
  const resolved = await api.request<{ repos: Array<{ repo: string; branch?: string | null }> }>('GET', `/environments/${encodeURIComponent(name)}/resolved`)
    .catch((err: unknown) => {
      if (err instanceof CliError && err.code === 'not_found') throw new CliError('not_found', `There is no environment named "${name}"`);
      throw err;
    });
  const checkouts = resolved.repos.map(r => (r.branch ? { repo: r.repo, branch: r.branch } : { repo: r.repo }));
  if (ctx && checkouts.length) ctx.err(`termag: ${name} runs ${checkouts.map(c => (c.branch ? `${c.repo} at ${c.branch}` : c.repo)).join(', ')}`);
  return checkouts;
}

/**
 * POST /projects, or with --if-not-exists the project of that name on the box
 * when there is one. A project from an environment is pinned to its checkouts
 * (pinEnvironment) here, after that lookup, since any ask of it runs them
 * without asking: one already there is used as it is, without reading the
 * environment. `say`: where the checkouts are said (stderr).
 */
export async function ensureProject(
  api: Api, box: Box, input: ProjectInput, ifNotExists: boolean, say?: Ctx,
): Promise<ProjectCreated> {
  const existing = async () => projectIn(await listProjects(api), box, input.name);
  const found = ifNotExists ? await existing() : null;
  if (found) return { project: found, created: false, repoUrl: null, restored: false };
  if (input.environment && !input.environmentRepos) {
    input.environmentRepos = await pinEnvironment(say ?? null, api, input.environment);
  }
  const body: Record<string, unknown> = { boxId: box.id, name: input.name, agent: input.agent };
  if (input.from?.length) body.from = input.from;
  if (input.environment) body.environment = input.environment;
  if (input.environment && input.environmentRepos) body.environmentRepos = input.environmentRepos;
  if (input.forAsk) body.createdFor = 'ask';
  if (input.model) body.model = input.model;
  try {
    const res = await api.request<{ project: Project; repoUrl?: string | null; restored?: boolean; repos?: Array<{ name: string; url: string }>; warnings?: string[]; model?: string | null; modelIgnored?: string }>('POST', '/projects', body);
    // An orchestrator from before `model` makes the project all the same, on its default.
    // A restore first: it keeps its own model whatever else the orchestrator says (an older one sends no `restored` model).
    const unmodelled = !input.model || res.model === input.model ? []
      : res.restored === true && res.model !== undefined ? [`${res.project.ref} was restored from the archive and keeps its model (${res.model ?? 'the default'}); --model ${input.model} applies only to a new project`]
      : res.modelIgnored ? [`--model ${input.model} was ignored: ${res.modelIgnored}; ${res.project.ref} starts on its default model`]
      : res.model === undefined ? [`the orchestrator ignored --model ${input.model} (it predates it); ${res.project.ref} starts on its default model`]
      : [`${res.project.ref} was restored from the archive and keeps its model (${res.model ?? 'the default'}); --model ${input.model} applies only to a new project`];
    const warnings = [...(res.warnings ?? []), ...unmodelled];
    return {
      project: res.project, created: true, repoUrl: res.repoUrl ?? null, restored: res.restored === true,
      ...(res.repos ? { repos: res.repos } : {}), ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && ifNotExists)) throw err;
    const raced = await existing();
    if (!raced) throw err;
    return { project: raced, created: false, repoUrl: null, restored: false };
  }
}

/**
 * The create's warnings (an environment's definition), and a `--from` the new
 * project did not take: an un-archived project, or an orchestrator from before
 * `from`. `printed`: warnings already said, as the new box's create (which
 * resolves the same environment) says them first, so none is said twice.
 */
function warnUnusedFrom(ctx: Ctx, from: string | string[] | undefined, result: ProjectCreated, printed: readonly string[] = []): void {
  for (const w of result.warnings ?? []) if (!printed.includes(w)) ctx.err(`termag: warning: ${w}`);
  if (!from?.length || !result.created || result.repoUrl) return;
  ctx.err(result.restored
    ? `termag: ${result.project.ref} was restored from the archive with its old directory; --from applies only to a new project.`
    : `termag: the orchestrator ignored --from (it predates it); ${result.project.ref} starts empty.`);
}

function createdText(result: ProjectCreated, agent: string): string {
  const { project } = result;
  if (!result.created) return `${project.ref} already exists (${project.provider ?? '-'}).`;
  const cloning = result.repos && result.repos.length > 1 ? `; it clones ${result.repos.map(r => r.name).join(', ')} first`
    : result.repoUrl ? `; its agent pane clones ${result.repoUrl} first` : '';
  return `Created ${project.ref} (${project.provider ?? agent})${cloning}.`;
}

/** Claude Code's agents, the ones --model applies to (backend services/modelChoices.ts isClaudeCode). */
const CLAUDE_AGENTS = ['claude', 'claude-chat'];

/** `--model`'s values: Claude's tiers, as the orchestrator takes them (backend services/claudeChatModel.ts CLAUDE_CHAT_TIERS). */
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];

/** --model, checked (`termag ask`, `project create`): a tier, or null without it. */
export function claudeModelOption(args: ParsedArgs): string | null {
  const raw = args.options.model;
  if (raw === undefined) return null;
  const model = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!CLAUDE_MODELS.includes(model)) throw usage(`--model takes ${CLAUDE_MODELS.join(', ')}`);
  return model;
}

/** `project create --model`: a Claude tier, for a Claude Code agent only; null without it. */
export function projectModelOption(args: ParsedArgs, agent: string): string | null {
  const model = claudeModelOption(args);
  if (model && !CLAUDE_AGENTS.includes(agent)) throw usage(`--model picks a Claude model, and ${agent} is not Claude Code; leave it out, or use --agent claude`);
  return model;
}

async function cmdProjectCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseProjectRef(arg(args, 0, '<box>/<name>', 'project create'));
  checkName(ref.project, 'project');
  const agent = args.options.agent;
  if (typeof agent !== 'string' || !agent) throw usage(`--agent is required. Usage: ${LIFECYCLE_COMMANDS['project create'].usage}`);
  const from = typeof args.options.from === 'string' ? args.options.from.trim() || undefined : undefined;
  if (args.options.from !== undefined && !from) throw usage('--from takes a template name or a GitHub repository URL');
  const environment = environmentOption(args);
  if (environment && from) throw usage('--environment names the repositories itself; leave out --from');
  const newBox = args.options['new-box'] === true;
  if (!newBox && args.options.timeout !== undefined) throw usage('--timeout goes with --new-box, which waits for the box');
  if (!newBox && args.options.size !== undefined) throw usage('--size goes with --new-box; an existing box keeps its size');
  for (const o of ['setup', 'no-setup']) {
    if (!newBox && args.options[o] !== undefined) throw usage(`--${o} goes with --new-box; an existing box keeps the termag setup it was launched with`);
  }
  if (!newBox && args.options.disk !== undefined) throw usage('--disk goes with --new-box; an existing box keeps its disk');
  const size = sizeOption(args);
  const diskGiB = diskOption(args);
  const setupEnabled = setupOption(args);
  if (newBox) checkName(ref.box, 'box');
  const timeoutS = timeoutSeconds(args, CREATE_WAIT_S);
  const ifNotExists = args.options['if-not-exists'] === true;
  const api = await lifecycleApi(ctx, args);
  const model = projectModelOption(args, agent);
  const input: ProjectInput = { name: ref.project, agent, from, ...(environment ? { environment } : {}), forAsk: args.options['for-ask'] === true, ...(model ? { model } : {}) };
  if (input.forAsk) ctx.err(FOR_ASK_DEPRECATED);

  if (!newBox) {
    const box = await resolveBox(api, ref.box);
    const result = await ensureProject(api, box, input, ifNotExists, ctx);
    warnUnusedFrom(ctx, from, result);
    return emitProject(ctx, args, result.project, { created: result.created, repoUrl: result.repoUrl }, createdText(result, agent));
  }

  const made = await projectOnNewBox(ctx, api, ref, input, { size, diskGiB, setupEnabled, ifNotExists, timeoutS, quiet: args.json });
  const boxText = made.boxCreated ? `Created box ${made.box.name}${made.box.setupEnabled === false ? ' (termag setup off)' : ''}. ` : '';
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
  input: ProjectInput,
  opts: { size?: string; diskGiB?: number; setupEnabled?: boolean; setupOverride?: string; ifNotExists: boolean; timeoutS: number; quiet: boolean; startParked?: boolean; retry?: string },
): Promise<NewBoxProject> {
  const { agent, from, environment } = input;
  const ifNotExists = opts.ifNotExists;
  let made = await ensureBox(api, ref.box, ifNotExists, { size: opts.size, diskGiB: opts.diskGiB, from: from?.length ? from : undefined, environment, forAsk: input.forAsk, setupEnabled: opts.setupEnabled });
  warnSizing(ctx, made);
  stateSetup(ctx, made, opts.setupEnabled, opts.setupOverride);
  if (made.box.state === 'failed' && ifNotExists) made = await relaunchFailed(ctx, api, made, ref, input.name, opts.quiet, opts.setupEnabled);
  if (!opts.quiet) {
    const sizeText = boxSpecText(made.box);
    const sized = sizeText ? ` (${sizeText})` : '';
    const off = made.box.setupEnabled === false ? ' with termag setup off' : '';
    ctx.err(made.created
      ? `Created box ${made.box.name}${sized}${off}${made.claimed ? (made.pool === 'environment' ? ` (from ${environment}'s pool: its setup already ran, starting now)` : ' (a warm box, ready now)') : ''}; ${ref.box}/${ref.project} is set up on it once it is running.`
      : `Using the existing box ${made.box.name} (${made.box.state}).`);
  }
  const refused = (err: CliError, boxName: string, state: string) => {
    const retry = opts.retry ?? `termag project create ${boxName}/${ref.project} --agent ${agent}${from ? ` --from ${[from].flat().join(' --from ')}` : ''}${environment ? ` --environment ${environment}` : ''}`;
    return new CliError(err.code, `Box ${boxName} is ${state}, but the project was not created: ${err.message.replace(/\.$/, '')}. Retry with \`${retry}\``);
  };
  const done = (box: Box, result: ProjectCreated): NewBoxProject => ({ box, boxCreated: made.created, claimed: made.claimed, result });
  let result: ProjectCreated | null = null;
  if (made.box.state === 'provisioning') {
    try {
      result = await ensureProject(api, made.box, input, ifNotExists, ctx);
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
  stateDisk(ctx, made, box, opts.diskGiB, true);
  if (!result) {
    try {
      result = await ensureProject(api, box, input, ifNotExists, ctx);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      throw refused(err, box.name, 'running');
    }
  }
  warnUnusedFrom(ctx, from, result, made.warnings);
  return done(box, result);
}

/**
 * The box of that name failed to launch and its project waits on it, so the
 * orchestrator would not replace it on a create: the project's Retry
 * (POST /projects/:id/clone/retry) launches a new box of the same name and
 * size and moves the project onto it. Without that project the box is left
 * as it is, for waitForRunning to report. `setupEnabled`: the launch's own
 * --setup / --no-setup (an ask's is always on), which the Retry takes over the
 * failed box's; absent, the new box has the failed one's.
 */
async function relaunchFailed(
  ctx: Ctx, api: Api, made: MadeBox, ref: { box: string; project: string }, project: string, quiet: boolean,
  setupEnabled?: boolean,
): Promise<MadeBox> {
  const waiting = projectIn(await listProjects(api), made.box, project);
  if (!waiting) return made;
  if (!quiet) ctx.err(`Box ${made.box.name} failed to launch; relaunching it with ${ref.box}/${ref.project}.`);
  const res = await api.request<{ project: Project }>('POST', `/projects/${encodeURIComponent(waiting.id)}/clone/retry`, setupEnabled !== undefined ? { setupEnabled } : {});
  const fresh = (await listBoxes(api)).find(b => b.id === res.project.box.id);
  if (!fresh) throw new CliError('not_found', `Box ${made.box.name} was relaunched, but the new box is not listed yet; run the command again`);
  return { box: fresh, created: true, claimed: false, warnings: [], repoSetup: null };
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
