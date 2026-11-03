import { spawn } from 'node:child_process';
import { postInBackground, type BackgroundRequest } from './backgroundPost.js';
import { exec, execInteractive, prompt, type Exec } from './system.js';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';

/** Everything a command touches outside its own logic, so tests can swap it. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  home: string;
  hostname: string;
  /** A person at a terminal. False for agents, pipes into stdin and CI: never prompt or open a browser then. */
  interactive: boolean;
  /** Run a program and capture its output (`termag doctor`). Unset means every program is missing. */
  exec?: Exec;
  /** Run a program on this terminal, e.g. `aws sso login`. Only called when `interactive`. */
  execInteractive?: (cmd: string, args: string[]) => Promise<number>;
  /** Ask one question on this terminal; null once stdin has ended. Only called when `interactive`. */
  prompt?: (question: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch: typeof fetch;
  /** Send a request from a detached process and return at once (backgroundPost.ts). Unset: the caller sends it itself. */
  postInBackground?: (request: BackgroundRequest) => void;
  openBrowser: (url: string) => void;
  readFile: (path: string) => string | null;
  loginTimeoutMs?: number;
  /**
   * Ask a yes/no question at the terminal. Only called when `interactive`. With `signal`, a
   * Ctrl-C at the prompt, or the signal aborting, answers null instead; without it, Ctrl-C ends
   * the command (130), as anywhere else.
   */
  confirm?: (question: string, opts?: { signal?: AbortSignal }) => Promise<boolean | null>;
  /** How often `--wait` polls the orchestrator. */
  pollIntervalMs?: number;
  /** How long `termag ask` keeps retrying an orchestrator that stopped answering (a deploy's overlap). */
  askRetryForMs?: number;
  /** The id `termag ask` gives a new message (tests pin it). */
  newMessageId?: () => string;
  /** A person can see stderr. Under ssh's ProxyCommand stdin and stdout carry the connection, so this decides. */
  stderrIsTTY?: boolean;
  /** All of stdin, for `termag ask <ref> -`. */
  readStdin?: () => Promise<string>;
  /** Resolves when the person asks a long-running command (`termag forward`) to stop. Unset: Ctrl-C, SIGTERM or SIGHUP. */
  untilInterrupted?: () => Promise<void>;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!cmd) return;
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed too */ }
}

async function confirm(question: string, opts: { signal?: AbortSignal } = {}): Promise<boolean | null> {
  const { signal } = opts;
  if (signal?.aborted) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // One outcome: the answer, or null for a Ctrl-C or the signal. Whether a closed readline
  // rejects its pending question (AbortError) or leaves it pending differs between Node
  // releases, so the question's own promise is never what decides an interruption.
  let interrupted!: () => void;
  const stopped = new Promise<null>((resolve) => { interrupted = () => resolve(null); });
  // A terminal in readline's raw mode turns Ctrl-C into this event, not a signal. With a
  // signal, the caller handles it; without, the command dies of SIGINT as it would anywhere.
  const onCtrlC = () => {
    if (signal) { interrupted(); return; }
    rl.close();
    process.kill(process.pid, 'SIGINT');
  };
  rl.on('SIGINT', onCtrlC);
  signal?.addEventListener('abort', interrupted, { once: true });
  const asked = rl.question(question).then(a => /^y(es)?$/i.test(a.trim()));
  asked.catch(() => { /* a question closed under it; the outcome is already decided */ });
  try {
    return await Promise.race([asked, stopped]);
  } finally {
    rl.off('SIGINT', onCtrlC);
    signal?.removeEventListener('abort', interrupted);
    rl.close();
  }
}

/**
 * Lines to `stream` (stdout or stderr) that survive its reader going away, as
 * `termag … | head -1` does. Node ignores SIGPIPE, so a write after that fails
 * with EPIPE, and the stream's `error` event, with no listener, crashed the CLI
 * with a stack trace and exit 1. Now an EPIPE stops this writer and the command
 * carries on to its own exit code (and usage report), as if the rest of its
 * output had been read. Any other stream error is thrown as before. The
 * listener is the stream's, so a direct `stream.write` is covered too, and
 * `termag events` still ends when its reader goes (events/command.ts).
 */
export function lineWriter(stream: Pick<NodeJS.WriteStream, 'write' | 'on'>): (text: string) => void {
  let gone = false;
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
    gone = true;
  });
  return (text) => {
    if (!gone) stream.write(text.endsWith('\n') ? text : text + '\n');
  };
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    home: homedir(),
    hostname: hostname(),
    interactive: Boolean(process.stdin.isTTY) && !process.env.CI,
    exec,
    execInteractive,
    prompt,
    platform: process.platform,
    out: lineWriter(process.stdout),
    err: lineWriter(process.stderr),
    fetch: globalThis.fetch,
    postInBackground: (request) => { postInBackground(request); },
    openBrowser,
    readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    confirm,
    stderrIsTTY: Boolean(process.stderr.isTTY) && !process.env.CI,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
