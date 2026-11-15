import { connect } from 'node:net';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CommandSpec, ParsedArgs } from '../args.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { untilSignal } from '../forward/command.js';
import { exec as realExec } from '../system.js';

/**
 * `termag preview run -- <command>`
 * : this box's agent starts the
 * command confined to a copy of the checkout (agent/preview-runs.js), so a
 * preview link of its port can be shared with named people or anyone on
 * termag with the link. The CLI starts nothing itself: only the agent's own
 * starts count. It asks over the agent's local socket, follows the run's log,
 * stops the run on Ctrl-C, and says what the sandbox refused when it ends.
 */

export const RUN_COMMANDS: Record<string, CommandSpec> = {
  'preview run': {
    summary: 'Run a dev server confined to this checkout, so a preview link of it can be shared beyond you',
    usage: 'termag preview run [--allow <port>,…] [--repo <dir>] [--port <port>] -- <command> [args]…',
    details: 'The box\'s agent starts <command> in a copy of the checkout you are in, under Landlock and seccomp:\n'
      + 'it can\'t read the rest of your home directory, write the checkout, reach your tmux, Docker or the\n'
      + 'agent, or connect to port 80 (instance metadata). Edits to the checkout reach it, so HMR works.\n'
      + 'Its TCP connects reach only port 443 and the ports you --allow, on this box or anywhere: name the\n'
      + 'app\'s own API or database (--allow 3001,5432), never a debugger\'s port. Port 80 can\'t be allowed.\n'
      + 'Links for named people or for anyone on termag with the link need their port started this way.\n'
      + '--port sets PORT for the app. --repo names the repository in a multi-repository workstream.\n'
      + 'Ctrl-C stops it.\n'
      + '  termag preview run -- npm run dev\n'
      + '  termag preview run --port 5173 -- npx vite --port 5173\n'
      + '  termag preview run --allow 3001,5432 -- npm run dev',
    options: {
      allow: { type: 'string' },
      repo: { type: 'string' },
      port: { type: 'string' },
    },
    maxArgs: 256,
  },
};

export interface Diagnosis { code: string; targets: string[]; message: string }
interface RunStarted { id: string; pid: number; checkout: string; logPath: string; allowed?: number[] }
interface RunStatus { id: string; state: 'running' | 'ended'; exit?: number | string | null; diagnosis: Diagnosis[] }

export function agentSocketPath(env: NodeJS.ProcessEnv): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'termag', 'agent.sock');
}

/** What a box without termag-preview says, whatever the agent's own wording. */
export const LAUNCHER_MISSING_MESSAGE = "This box's image predates the preview launcher. Update or recreate the box, then try again.";

/**
 * The agent's refusal as the CLI says it: plainly for a box without the launcher (its image predates it), and named
 * either way, so it isn't read as a generic failure.
 */
export function refusalError(error: string, code?: string): CliError {
  const named = typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : null;
  if (named === 'launcher_missing') return new CliError('failed', `${LAUNCHER_MISSING_MESSAGE}\n(termag preview run refused: launcher_missing)`, undefined, { refusal: named });
  return new CliError('failed', named ? `${error}\n(termag preview run refused: ${named})` : error, undefined, named ? { refusal: named } : undefined);
}

/** One request to the agent's local socket: one JSON line each way. */
export function askAgent<T>(at: string, body: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
  return new Promise((done, fail) => {
    const c = connect(at);
    let out = '';
    const timer = setTimeout(() => { c.destroy(); fail(new CliError('timeout', 'The agent didn\'t answer')); }, timeoutMs);
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`));
    c.on('data', (b) => { out += b; });
    c.on('end', () => {
      clearTimeout(timer);
      let r: { error?: string; code?: string } & T;
      try { r = JSON.parse(out); } catch { fail(new CliError('failed', 'The agent sent an answer this CLI does not understand')); return; }
      if (r.error) fail(refusalError(r.error, r.code)); else done(r);
    });
    c.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') {
        // `gone`: nothing listens there (no socket, or one a dead agent left), as opposed to an agent that answered with an error.
        fail(new CliError('failed', `No termag agent answers at ${at}: run this on a termag box, whose agent is new enough for termag preview run (update the box)`, undefined, { gone: true }));
      } else fail(new CliError('failed', `The agent's socket: ${e.message}`));
    });
  });
}

/** The repositories of a multi-repository workstream root: its subdirectories that are git work trees. */
function reposUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, '.git')))
      .map(e => e.name).sort();
  } catch { return []; }
}

/**
 * The checkout to run: the git work tree holding the working directory, or
 * with --repo, that repository of the workstream root the CLI runs from.
 */
export async function checkoutToRun(ctx: Ctx, repo: string | undefined): Promise<string> {
  const cwd = (ctx.cwd ?? (() => process.cwd()))();
  const exec = ctx.exec ?? realExec;
  if (repo !== undefined) {
    const dir = resolve(cwd, repo);
    const rel = relative(cwd, dir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw usage(`--repo names a repository inside ${cwd}`);
    if (!existsSync(join(dir, '.git'))) throw usage(`${dir} isn't a git checkout`);
    return dir;
  }
  const top = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();
  const repos = reposUnder(cwd);
  if (repos.length) {
    throw usage(`This workstream holds several repositories; name one with --repo: ${repos.join(', ')}`);
  }
  throw usage('Run this in a checkout (a git work tree) on the box');
}

/** Everything left in the log from `from`, in bounded reads (Devin, #1520). */
function drain(path: string, from: number): { text: string; at: number } {
  let text = '';
  let at = from;
  for (;;) {
    const r = readFrom(path, at);
    if (!r.text) return { text, at };
    text += r.text;
    at = r.at;
  }
}

/** Follow a log file from `from`: what's new since, as text. */
function readFrom(path: string, from: number): { text: string; at: number } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { text: '', at: from }; }
  try {
    const size = statSync(path).size;
    if (size <= from) return { text: '', at: from };
    const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
    const n = readSync(fd, buf, 0, buf.length, from);
    return { text: buf.subarray(0, n).toString('utf8'), at: from + n };
  } finally { closeSync(fd); }
}

const POLL_MS = 250;

/** --allow 3001,5432: the ports, as numbers; the agent checks what they may be (never 80, nor a debugger's). */
function parseAllow(raw: string | boolean | undefined): number[] {
  if (raw === undefined) return [];
  const parts = String(raw).split(',').map(p => p.trim());
  const ports = parts.map(Number);
  if (parts.some(p => !/^\d+$/.test(p)) || ports.some(p => p < 1 || p > 65535)) throw usage(`--allow takes ports separated by commas, e.g. --allow 3001,5432`);
  return ports;
}

async function cmdRun(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const command = args.args;
  if (command.length === 0) throw usage(`Name the command to run after --. Usage: ${RUN_COMMANDS['preview run'].usage}`);
  let port: number | undefined;
  if (args.options.port !== undefined) {
    port = Number(args.options.port);
    if (!/^\d+$/.test(String(args.options.port)) || port < 1 || port > 65535) throw usage(`"${args.options.port}" is not a port (1 to 65535)`);
  }
  const allow = parseAllow(args.options.allow);
  const checkout = await checkoutToRun(ctx, typeof args.options.repo === 'string' ? args.options.repo : undefined);
  const at = agentSocketPath(ctx.env);
  // Armed before the start: a Ctrl-C during the copy stops the run once it's
  // up. (A CLI killed outright closes the socket, and the agent stops it.)
  let stopping = false;
  let stopRun: () => Promise<void> = async () => {};
  const interrupted = (ctx.untilInterrupted ?? untilSignal)();
  void interrupted.then(async () => { stopping = true; await stopRun(); });
  const run = await askAgent<RunStarted>(at, { op: 'preview-run', checkout, command, ...(port ? { port } : {}), ...(allow.length ? { allow } : {}) });
  if (args.json) ctx.out(JSON.stringify({ run }));
  else {
    ctx.err(`termag preview run: ${run.id} started, confined to a copy of ${run.checkout} (log ${run.logPath}). Ctrl-C stops it.`);
    if (run.allowed) ctx.err(`termag preview run: TCP connects reach only port${run.allowed.length > 1 ? 's' : ''} ${run.allowed.join(', ')}.`);
  }

  stopRun = async () => {
    try { await askAgent(at, { op: 'preview-stop', id: run.id }, 10_000); } catch { /* it ended already */ }
  };
  if (stopping) await stopRun();
  let offset = 0;
  let failures = 0;
  let status: RunStatus | null = null;
  for (;;) {
    const r = readFrom(run.logPath, offset);
    offset = r.at;
    if (r.text && !args.json) ctx.out(r.text.replace(/\n$/, ''));
    try {
      ({ run: status } = await askAgent<{ run: RunStatus | null }>(at, { op: 'preview-status', id: run.id }, 10_000));
    } catch (e) {
      if (stopping) break;
      const rest = drain(run.logPath, offset);
      // Printed once: the next read starts after it (Devin, #1520).
      offset = rest.at;
      if (rest.text && !args.json) ctx.out(rest.text.replace(/\n$/, ''));
      // The agent went away (a box update, a restart): by the connection's own error, since a dead agent can leave
      // its socket file behind (Devin, #1520). Its runs end with it.
      if ((e as CliError).body?.gone) {
        throw new CliError('failed', `${run.id} ended: the box's agent stopped (${(e as Error).message}). Its runs end with it; start it again with termag preview run`);
      }
      // A live agent that couldn't answer: a few more tries, then stop the run rather than leave it
      // running with nobody in front of it (Bugbot, #1520), and say so only once it is (Devin, #1520).
      if (++failures < 3) { await new Promise(res => setTimeout(res, ctx.pollIntervalMs ?? POLL_MS)); continue; }
      const stopped = await askAgent<{ stopped: boolean }>(at, { op: 'preview-stop', id: run.id }, 10_000).then(r => r.stopped, () => false);
      if (stopped) throw new CliError('failed', `Stopped ${run.id}: the agent stopped answering about it (${(e as Error).message})`);
      throw new CliError('failed', `${run.id} may still be running: the agent didn't answer about it or stop it (${(e as Error).message}). Restarting the box's agent ends every run (systemctl --user restart termag-agent)`);
    }
    failures = 0;
    if (!status || status.state === 'ended') {
      const rest = drain(run.logPath, offset);
      if (rest.text && !args.json) ctx.out(rest.text.replace(/\n$/, ''));
      break;
    }
    await new Promise(res => setTimeout(res, ctx.pollIntervalMs ?? POLL_MS));
  }
  const diagnosis = status?.diagnosis ?? [];
  if (args.json) {
    ctx.out(JSON.stringify({ ended: { id: run.id, exit: status?.exit ?? null, diagnosis } }));
  } else {
    // What the sandbox refused, named: a bare EACCES in the app's own output says nothing about why.
    for (const d of diagnosis) ctx.err(`termag preview run: ${d.message}`);
    ctx.err(`termag preview run: ${run.id} ended${status?.exit !== undefined && status?.exit !== null ? ` (${status.exit})` : ''}.`);
  }
  if (stopping || status?.exit === 0) return EXIT.OK;
  return EXIT.FAILED;
}

export const RUN_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'preview run': cmdRun,
};
