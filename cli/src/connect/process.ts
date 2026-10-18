import { spawn, type StdioOptions } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Remote-SSH in a GUI editor runs the ssh-config ProxyCommand with the GUI's
// PATH, which on macOS usually lacks Homebrew's bin directories.
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function fallbackDirs(env: NodeJS.ProcessEnv): string[] {
  const override = env.TERMAG_TOOL_FALLBACK_DIRS;
  if (override === undefined) return FALLBACK_DIRS;
  return override.split(delimiter).filter(Boolean);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of `name` on PATH, then in the usual install directories. */
export function findTool(name: string, env: NodeJS.ProcessEnv, opts: { fallback?: boolean } = {}): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  if (opts.fallback !== false) dirs.push(...fallbackDirs(env));
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion, capturing its output; never throws for a non-zero exit. */
export function capture(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr || err.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal === 'SIGTERM' ? 124 : 1), stdout, stderr });
    });
  });
}

const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

/**
 * Runs a command on this terminal and resolves with its exit status. While it
 * runs, termag ignores Ctrl-C and friends and leaves them to the child (ssh),
 * so the child decides when the session ends.
 */
export function runAttached(cmd: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions = 'inherit'): Promise<number> {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];
  const ignore = () => {};
  for (const s of signals) process.on(s, ignore);
  const release = () => { for (const s of signals) process.off(s, ignore); };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio });
    } catch (err) {
      release();
      process.stderr.write(`termag: could not run ${cmd}: ${(err as Error).message}\n`);
      resolve(127);
      return;
    }
    child.on('error', (err) => {
      release();
      process.stderr.write(`termag: could not run ${cmd}: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      release();
      resolve(code ?? (signal ? SIGNAL_EXIT[signal] ?? 1 : 1));
    });
  });
}
