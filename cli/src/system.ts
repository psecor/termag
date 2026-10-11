/**
 * Running programs and asking questions on this terminal, for `termag doctor`.
 * Wired into Ctx by defaultCtx(); tests hand in stand-ins instead.
 */
import { execFile, spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface ExecResult {
  /** 127 when the program is not installed. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 20_000;

export const exec: Exec = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
    const code = !e ? 0 : e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export function execInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ENOENT' ? 127 : 1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// One reader for the whole run, so answers typed (or pasted) ahead are kept,
// paused between questions so a child run on this terminal gets its input.
let reader: Interface | null = null;
const pendingLines: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let stdinClosed = false;

/** One line from the terminal; null once stdin has ended. */
export function prompt(question: string): Promise<string | null> {
  process.stderr.write(question);
  if (pendingLines.length) return Promise.resolve(pendingLines.shift()!);
  if (stdinClosed) return Promise.resolve(null);
  if (!reader) {
    reader = createInterface({ input: process.stdin });
    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next) next(line); else pendingLines.push(line);
      if (!waiting.length) reader?.pause();
    });
    reader.on('close', () => { stdinClosed = true; for (const w of waiting.splice(0)) w(null); });
  }
  return new Promise((resolve) => { waiting.push(resolve); reader!.resume(); });
}
