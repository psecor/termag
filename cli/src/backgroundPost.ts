import { spawn, type ChildProcess } from 'node:child_process';

/** An HTTP request another process sends: what Api would send (api.ts, cliRequest), with its timeout. */
export interface BackgroundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/**
 * What the child runs, as `node -e`. A constant: nothing of the request is code.
 * It reads the request as JSON from its stdin, sends it once, reads no more of
 * the answer than it must, and gives up at the timeout; it never retries.
 */
export const SENDER = [
  `let s = '';`,
  `process.stdin.setEncoding('utf8').on('data', (c) => { s += c; }).on('end', () => {`,
  `  let r; try { r = JSON.parse(s); } catch { return; }`,
  `  fetch(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: 'manual', signal: AbortSignal.timeout(r.timeoutMs) })`,
  `    .then((res) => res.body?.cancel()).catch(() => {});`,
  `});`,
].join('\n');

/**
 * Send `request` from a detached Node process and return at once, so the
 * caller can exit without waiting for it (usage.ts: the usage report of a run
 * that opened no connection of its own).
 *
 * The request, bearer included, goes down a pipe to the child's stdin: never
 * in its argv, which anyone can read with `ps`, or its environment, which
 * other processes of the user can read and which anything the child started
 * would inherit. The child gets this process's environment as it is, so a
 * proxy or CA setting applies to it too, and no stdout or stderr: a hook that
 * waits for its command's output never waits for it. Best effort, for
 * telemetry only: a spawn or a write that fails is ignored.
 */
export function postInBackground(request: BackgroundRequest, spawnFn: typeof spawn = spawn): ChildProcess | null {
  try {
    const child = spawnFn(process.execPath, ['-e', SENDER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request));
    child.unref();
    return child;
  } catch {
    return null;
  }
}
