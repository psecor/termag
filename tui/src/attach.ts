import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import type { TermagApi } from './api.js';
import {
  BOX_PARKED_CLOSE_CODE, REAUTH_CLOSE_CODE, HeartbeatGate, PrefixHandler, backoffDelay, describePrefix, handshakeRefusal, inputFrame, isFatalClose, parseServerFrame, resizeFrame,
  terminalWsUrl, type ChordAction, type TerminalTarget,
} from './terminalSocket.js';

/**
 * Remote attach: hand the real terminal to a tmux session on a box, through
 * the CLI's terminal WebSocket, the way `ssh` or `tmux attach` feels.
 *
 * No terminal emulation happens here — the remote tmux renders everything, so
 * bytes go stdin → `input` frames and `output` frames → stdout. The local tty
 * is put in raw mode and the alternate screen so the lobby comes back clean.
 *
 * Reconnects forever on the browser's backoff schedule, except for refusals
 * that cannot change by waiting (the credential, access to the session).
 * Because the server never closes this socket when the box agent drops (its
 * stream table is not cleaned up on agent close), the loop also polls the
 * session list and forces a reconnect cycle when the owning agent goes offline.
 */
export interface AttachOptions {
  api: TermagApi;
  target: TerminalTarget;
  prefix?: string;
  /** Whether n / p has somewhere to go; when not, the bell rings and the attach stays up. */
  canHop?: (dir: 'next' | 'prev') => boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Poll interval for the agent-connectivity check (ms). */
  agentCheckMs?: number;
}

export type AttachOutcome =
  | { kind: 'detach' | 'flip' | 'next' | 'prev' }
  | { kind: 'ended'; message: string }
  | { kind: 'error'; message: string };

const ALT_ON = '\x1b[?1049h\x1b[H\x1b[2J';
/**
 * Handing the terminal back to Ink. The remote tmux client sends its own
 * alternate-screen enter on attach and is killed before it can send the exit,
 * and it may leave mouse / bracketed-paste / keypad modes on. Alternate screen
 * is a boolean in every terminal we care about, so: leave it (whatever nesting
 * the remote implied), soft-reset (tmux leaves a scroll region behind, which
 * makes Ink's next full frame scroll inside it), re-enter it clean, home the
 * cursor, reset the modes.
 * Ink then re-enters (a no-op) and draws from the top onto a cleared screen;
 * its final exit still restores the user's primary screen.
 */
const RESTORE = '\x1b[?1049l'          // leave the alternate screen, however many times the remote entered it
  + '\x1b[!p\x1b[r\x1b[?6l'              // DECSTR soft reset; scroll region and origin mode explicitly, for terminals without it
  + '\x1b[?1049h\x1b[2J\x1b[H'          // back into a clean alternate screen for Ink
  + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b>\x1b[0m\x1b[?25h';
const AGENT_CHECK_MS = 15_000;
const STABLE_MS = 1_000;

/** Human-activity attribution for a remote attach, credited to the project's own box like the browser does. */
export function sendHeartbeat(api: Pick<TermagApi, 'heartbeat'>, target: TerminalTarget): Promise<unknown> {
  return api.heartbeat(target.projectName, target.instanceId ?? null);
}

function notice(out: NodeJS.WriteStream, text: string): void {
  out.write(`\r\n\x1b[7m termag \x1b[0m ${text}\r\n`);
}

export function runRemoteAttach(opts: AttachOptions): Promise<AttachOutcome> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const prefix = opts.prefix ?? '\x1c';
  const chords = new PrefixHandler(prefix);
  const heartbeat = new HeartbeatGate();
  const decoder = new StringDecoder('utf8');

  return new Promise<AttachOutcome>((resolve) => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let finished = false;
    let retryTimer: NodeJS.Timeout | null = null;
    let agentTimer: NodeJS.Timeout | null = null;
    let stableTimer: NodeJS.Timeout | null = null;
    let everConnected = false;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;

    const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });

    const finish = (outcome: AttachOutcome) => {
      if (finished) return;
      finished = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (agentTimer) clearInterval(agentTimer);
      if (stableTimer) clearTimeout(stableTimer);
      stdin.off('data', onKeys);
      process.off('SIGWINCH', onResize);
      try { ws?.close(1000, 'client detached'); } catch { /* ignore */ }
      ws = null;
      if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch { /* ignore */ } }
      stdout.write(RESTORE);
      resolve(outcome);
    };

    const onResize = () => {
      const { cols, rows } = size();
      if (ws?.readyState === WebSocket.OPEN) ws.send(resizeFrame(cols, rows));
    };

    const onKeys = (chunk: Buffer) => {
      // In typing order: bytes before a chord are delivered before it acts.
      for (const ev of chords.feed(decoder.write(chunk))) {
        if ('unknown' in ev) { stdout.write('\x07'); continue; }
        if ('send' in ev) {
          if (ws?.readyState === WebSocket.OPEN) ws.send(inputFrame(ev.send));
          if (heartbeat.shouldSend(Date.now())) sendHeartbeat(opts.api, opts.target).catch(() => { /* attribution only */ });
          continue;
        }
        const a = ev.action;
        if (a === 'help') { notice(stdout, `${describePrefix(prefix)} then: d detach · tab agent/ctrl · n/p next/prev project · ${describePrefix(prefix)} send it literally`); continue; }
        if ((a === 'next' || a === 'prev') && opts.canHop && !opts.canHop(a)) { stdout.write('\x07'); continue; }
        finish({ kind: a as Exclude<ChordAction, 'help'> });
        return;
      }
    };

    const scheduleRetry = (why: string) => {
      if (finished) return;
      const delay = backoffDelay(attempt++);
      notice(stdout, `${why} — reconnecting in ${Math.round(delay / 1000)}s (${describePrefix(prefix)} d to detach)`);
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (finished) return;
      const { cols, rows } = size();
      let sock: WebSocket;
      try {
        // Fetched per connect: a renewed access token is the one that goes out.
        const token = await opts.api.accessToken();
        if (finished) return;
        sock = new WebSocket(terminalWsUrl(opts.api.base, opts.target, cols, rows), { headers: { Authorization: `Bearer ${token}` } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/401|termag login/.test(msg)) { finish({ kind: 'error', message: `${opts.target.session}: ${msg}` }); return; }
        scheduleRetry(msg);
        return;
      }
      ws = sock;
      let lastOutput = '';
      let lastError: string | undefined;
      sock.on('open', () => {
        sock.send(resizeFrame(cols, rows));
        // The server accepts the socket before it learns the box agent is
        // down, then sends "Agent not connected" and closes. Only a connection
        // that survives a moment counts as established: that is when the
        // backoff resets and a "reconnected" notice is honest.
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
          attempt = 0;
          if (everConnected) notice(stdout, 'reconnected');
          everConnected = true;
        }, STABLE_MS);
      });
      sock.on('message', (raw) => {
        const f = parseServerFrame(raw as Buffer | string);
        if (!f) return;
        if (f.type === 'exit') { finish({ kind: 'ended', message: `${opts.target.session}: session ended` }); return; }
        lastOutput = f.data.slice(-200);
        stdout.write(f.data);
      });
      sock.on('error', (e) => { lastError = e.message; /* 'close' follows */ });
      sock.on('close', (code, reasonBuf) => {
        if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
        if (finished || ws !== sock) return;
        if (code === REAUTH_CLOSE_CODE) {
          // The access token's hour ran out under an open attach: re-dial now.
          // accessToken() renews it; the remote tmux redraws on attach.
          retryTimer = setTimeout(() => void connect(), 0);
          return;
        }
        const refused = handshakeRefusal(lastError);
        if (refused?.fatal) {
          finish({ kind: 'error', message: `${opts.target.session}: the orchestrator refused the TUI's credential (HTTP ${refused.status}); run \`termag login\`` });
          return;
        }
        const lastLine = lastOutput.trim().split('\n').pop();
        // A parked box sends a readable message as output before its 4409 close.
        const reason = (code === BOX_PARKED_CLOSE_CODE && lastLine) || reasonBuf.toString() || lastLine || lastError || `code ${code}`;
        if (isFatalClose(code, reason)) {
          finish({ kind: 'error', message: `${opts.target.session}: ${reason}` });
          return;
        }
        scheduleRetry(reason);
      });
    };

    // The agent-drop case: the socket stays open but nothing will ever arrive.
    const checkAgent = async () => {
      if (finished) return;
      try {
        const rows = await opts.api.listSessions();
        const row = rows.find(r => r.projectId === opts.target.projectId && r.workstream === opts.target.workstream && r.role === opts.target.role);
        if (row && !row.connected && ws?.readyState === WebSocket.OPEN) {
          const dead = ws; ws = null;
          try { dead.close(4001, 'agent offline'); } catch { /* ignore */ }
          scheduleRetry('box agent offline');
        }
      } catch { /* a failed poll is not evidence either way */ }
    };

    stdout.write(ALT_ON);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKeys);
    process.on('SIGWINCH', onResize);
    agentTimer = setInterval(() => void checkAgent(), opts.agentCheckMs ?? AGENT_CHECK_MS);
    void connect();
  });
}
