import { spawn } from 'node:child_process';
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
  openBrowser: (url: string) => void;
  readFile: (path: string) => string | null;
  loginTimeoutMs?: number;
  /** Ask a yes/no question at the terminal. Only called when `interactive`. */
  confirm?: (question: string) => Promise<boolean>;
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

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
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
    out: (text) => { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); },
    err: (text) => { process.stderr.write(text.endsWith('\n') ? text : text + '\n'); },
    fetch: globalThis.fetch,
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
