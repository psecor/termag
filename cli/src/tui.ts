import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedArgs } from './args.js';
import { resolveTarget } from './config.js';
import type { Ctx } from './context.js';
import { freshAccess } from './access.js';
import { credentialsPath, loadLogin } from './credentials.js';
import { CliError, EXIT, type ExitCode } from './errors.js';

/** The TUI's engines floor (tui/package.json). */
export const TUI_MIN_NODE_MAJOR = 22;

export interface TuiProgram {
  /** Run with this Node (`process.execPath`) rather than as an executable. */
  node: boolean;
  path: string;
}

type Exists = (path: string) => boolean;

/**
 * Where the TUI lives: $TERMAG_TUI, then the checkout or tarball this CLI came
 * from (`<root>/tui/bin/termag-tui.js` beside `<root>/cli/`), then
 * `termag-tui` on PATH.
 */
export function findTui(env: NodeJS.ProcessEnv, cliRoot: string, exists: Exists = existsSync): TuiProgram | null {
  const explicit = env.TERMAG_TUI;
  if (explicit) {
    if (!isAbsolute(explicit) || !exists(explicit)) return null;
    return { node: /\.[cm]?js$/.test(explicit), path: explicit };
  }
  const sibling = join(cliRoot, '..', 'tui', 'bin', 'termag-tui.js');
  if (exists(sibling) && exists(join(cliRoot, '..', 'tui', 'dist', 'index.js'))) return { node: true, path: sibling };
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'termag-tui');
    if (exists(candidate)) return { node: false, path: candidate };
  }
  return null;
}

/** The clone the launcher points at, else the one this CLI runs from. */
export function checkoutOf(env: NodeJS.ProcessEnv, cliRoot: string): string {
  return env.TERMAG_CLI_CHECKOUT || resolve(cliRoot, '..');
}

export function shellQuote(s: string): string {
  return /^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The one command that builds the TUI where `termag tui` will look for it. */
export function installTuiCommand(env: NodeJS.ProcessEnv, cliRoot: string): string {
  return `make -C ${shellQuote(checkoutOf(env, cliRoot))} install-tui`;
}

/** What to do when the CLI's Node is too old for the TUI. */
export function tuiNodeHint(nodeVersion: string, checkout: string): string {
  return `\`termag tui\` needs Node.js ${TUI_MIN_NODE_MAJOR} or newer; this CLI runs on ${nodeVersion}. With Node ${TUI_MIN_NODE_MAJOR} on PATH, run: make -C ${shellQuote(checkout)} install-cli`;
}

export function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
}

export type TuiCredential =
  | { kind: 'device'; accessToken: string; accessTokenExpiresAt: string; refreshToken: string }
  | { kind: 'box'; token: string };

/**
 * The environment the TUI starts with: this CLI's choice of orchestrator and
 * credential. A device sign-in hands over its access token and, so the TUI can
 * outlive that token's hour, the device token to refresh it with.
 */
export function tuiEnv(base: NodeJS.ProcessEnv, host: string, credential: TuiCredential): NodeJS.ProcessEnv {
  const { TERMAG_REFRESH_TOKEN: _refresh, TERMAG_TOKEN_EXPIRES_AT: _expires, ...rest } = base;
  if (credential.kind === 'box') {
    return { ...rest, TERMAG_URL: host, TERMAG_TOKEN: credential.token, TERMAG_CREDENTIAL: "this box's credentials" };
  }
  return {
    ...rest,
    TERMAG_URL: host,
    TERMAG_TOKEN: credential.accessToken,
    TERMAG_TOKEN_EXPIRES_AT: credential.accessTokenExpiresAt,
    TERMAG_REFRESH_TOKEN: credential.refreshToken,
    TERMAG_CREDENTIAL: 'termag login',
  };
}

function cliRoot(): string {
  // dist/tui.js (or src/tui.ts under vitest) → the cli/ directory.
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function runForeground(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  // The TUI owns the terminal; Ctrl-C and friends are its to handle.
  const ignore = () => {};
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTSTP'];
  for (const s of signals) process.on(s, ignore);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }).finally(() => {
    for (const s of signals) process.off(s, ignore);
  });
}

export interface TuiDeps {
  cliRoot: string;
  nodeVersion: string;
  runForeground: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function runTui(ctx: Ctx, args: ParsedArgs, deps: TuiDeps): Promise<ExitCode> {
  const target = resolveTarget(args.host, ctx.env, ctx.home, ctx.readFile);
  // Same choice as authedApi in commands.ts: a device login wins over the box's credential.
  const credsPath = credentialsPath(ctx.env, ctx.home);
  const login = loadLogin(credsPath, target.host);
  if (!login && !target.box) throw new CliError('auth_required', `Not signed in to ${target.host}; run \`termag login\``);

  const program = findTui(ctx.env, deps.cliRoot);
  if (!program) {
    if (ctx.env.TERMAG_TUI) throw new CliError('failed', `TERMAG_TUI=${ctx.env.TERMAG_TUI} does not exist (it must be an absolute path)`);
    throw new CliError('failed', `The TUI is not built yet; run: ${installTuiCommand(ctx.env, deps.cliRoot)}`);
  }
  const node = deps.nodeVersion;
  if (program.node && nodeMajor(node) < TUI_MIN_NODE_MAJOR) {
    throw new CliError('failed', tuiNodeHint(node, checkoutOf(ctx.env, deps.cliRoot)));
  }

  const credential: TuiCredential = login
    ? { kind: 'device', refreshToken: login.token, ...await freshAccess({ host: target.host, credsPath, fetch: ctx.fetch }, login) }
    : { kind: 'box', token: target.box!.token };
  const env = tuiEnv(ctx.env, target.host, credential);
  const [cmd, argv] = program.node ? [process.execPath, [program.path, ...args.args]] : [program.path, args.args];
  const code = await deps.runForeground(cmd, argv, env);
  if (code === 0) return EXIT.OK;
  return code === EXIT.USAGE ? EXIT.USAGE : EXIT.FAILED;
}

export function cmdTui(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  return runTui(ctx, args, { cliRoot: cliRoot(), nodeVersion: process.versions.node, runForeground });
}
