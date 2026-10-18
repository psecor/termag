import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedArgs } from './args.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { nodeMajor, TUI_MIN_NODE_MAJOR, tuiNodeHint } from './tui.js';

export interface UpdateDeps {
  /** The checkout this CLI runs from, when the launcher did not say. */
  defaultCheckout: string;
  execPath: string;
  /** Runs a child with its output on stderr, so `--json` stdout stays one document. */
  run: (cmd: string, args: string[]) => Promise<number>;
  /** The checked-out branch, or null for a detached HEAD. */
  currentBranch: (checkout: string) => Promise<string | null>;
  /** `process.versions.node` of that Node (a path, or `node` for PATH's), or null if it did not run. */
  nodeVersion: (node: string) => Promise<string | null>;
  exists: (path: string) => boolean;
  writable: (path: string) => boolean;
}

export type TuiOutcome = 'rebuilt' | 'not-built' | 'node-too-old';

export const MAIN_BRANCH = 'main';

/** Is there a `node` on PATH for install.sh to find by itself? */
export function nodeOnPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): boolean {
  return (env.PATH ?? '').split(delimiter).some(dir => dir !== '' && exists(join(dir, 'node')));
}

/**
 * What `termag update` runs: a fast-forward pull of the checkout the launcher
 * came from, on whatever branch it is on, then that checkout's install.sh
 * writing the same launcher. It never switches branches.
 */
export function updatePlan(env: NodeJS.ProcessEnv, deps: Pick<UpdateDeps, 'defaultCheckout' | 'execPath' | 'exists'>, pull: boolean) {
  const checkout = env.TERMAG_CLI_CHECKOUT || deps.defaultCheckout;
  const installer = join(checkout, 'cli', 'install.sh');
  const steps: Array<{ cmd: string; args: string[] }> = [];
  if (pull) steps.push({ cmd: 'git', args: ['-C', checkout, 'pull', '--ff-only'] });
  const installArgs = [installer];
  if (env.TERMAG_CLI_BIN) installArgs.push('--bin-dir', dirname(env.TERMAG_CLI_BIN));
  // The launcher falls back to its pinned Node when PATH has none; keep that one.
  if (!nodeOnPath(env, deps.exists)) installArgs.push('--node', deps.execPath);
  steps.push({ cmd: 'sh', args: installArgs });
  return { checkout, installer, steps };
}

export async function runUpdate(ctx: Ctx, args: ParsedArgs, deps: UpdateDeps): Promise<ExitCode> {
  const pull = args.options['no-pull'] !== true;
  const plan = updatePlan(ctx.env, deps, pull);
  if (!deps.exists(plan.installer)) {
    throw new CliError('failed', `${plan.checkout} has no cli/install.sh; update it with \`git pull\` and run \`make install-cli\` there`);
  }
  if (!deps.writable(join(plan.checkout, 'cli'))) {
    throw new CliError('failed', `${plan.checkout} is not writable by you; on a box that means the image owns it and updates it`);
  }
  let branch: string | null = null;
  if (pull) {
    branch = await deps.currentBranch(plan.checkout);
    if (branch === null) {
      throw new CliError('failed', `${plan.checkout} is not on a branch (detached HEAD); check one out, or run \`termag update --no-pull\``);
    }
    if (branch !== MAIN_BRANCH) {
      ctx.err(`termag update: warning: ${plan.checkout} is on branch \`${branch}\`, not \`${MAIN_BRANCH}\`; pulling \`${branch}\``);
    }
  }
  for (const step of plan.steps) await runStep(deps, step);
  const tui = await rebuildTui(ctx, plan.checkout, deps);
  if (args.json) ctx.out(JSON.stringify({ updated: true, checkout: plan.checkout, pulled: pull, branch, tui }));
  return EXIT.OK;
}

async function runStep(deps: UpdateDeps, step: { cmd: string; args: string[] }): Promise<void> {
  const code = await deps.run(step.cmd, step.args);
  if (code !== 0) throw new CliError('failed', `\`${step.cmd} ${step.args.join(' ')}\` exited ${code}`);
}

/**
 * A TUI someone has built (`make install-tui`) is rebuilt with the Node the
 * reinstalled CLI runs on, which is the one `termag tui` starts it with. One
 * never built is left alone, and a Node too old for it gets the hint rather
 * than failing an update whose CLI half already succeeded.
 */
async function rebuildTui(ctx: Ctx, checkout: string, deps: UpdateDeps): Promise<TuiOutcome> {
  const installer = join(checkout, 'tui', 'install.sh');
  if (!deps.exists(installer) || !deps.exists(join(checkout, 'tui', 'dist', 'index.js'))) return 'not-built';
  const pathNode = nodeOnPath(ctx.env, deps.exists);
  const version = await deps.nodeVersion(pathNode ? 'node' : deps.execPath);
  if (!version || nodeMajor(version) < TUI_MIN_NODE_MAJOR) {
    ctx.err(`termag update: the TUI was not rebuilt. ${tuiNodeHint(version ?? 'an unknown Node', checkout)}`);
    return 'node-too-old';
  }
  await runStep(deps, { cmd: 'sh', args: [installer, '--quiet', ...(pathNode ? [] : ['--node', deps.execPath])] });
  return 'rebuilt';
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 2, 2] });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

function currentBranch(checkout: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD'], (err, stdout) => {
      resolvePromise(err ? null : stdout.trim() || null);
    });
  });
}

function nodeVersion(node: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(node, ['-p', 'process.versions.node'], (err, stdout) => {
      resolvePromise(err ? null : stdout.trim() || null);
    });
  });
}

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export function cmdUpdate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  // dist/update.js (or src/update.ts under vitest) → the checkout holding cli/.
  const defaultCheckout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return runUpdate(ctx, args, { defaultCheckout, execPath: process.execPath, run, currentBranch, nodeVersion, exists: existsSync, writable });
}
