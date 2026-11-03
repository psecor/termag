import WebSocket from 'ws';
import { API_PREFIX, type BearerSource } from '../api.js';
import { CliError } from '../errors.js';
import { VERSION } from '../version.js';

/**
 * The status push on the CLI's socket, /api/cli/v1/ws/status
 * (backend/src/routes/cliWs.ts), held open for as long as `termag events`
 * runs. It behaves as the TUI's sockets do (tui/src/statusSocket.ts and
 * terminalSocket.ts), which this package can't import: the bearer is asked
 * for on every dial, so a renewed access token is the one sent; a close is
 * retried on the browser's schedule; a socket quiet for longer than two
 * heartbeats is dropped and dialed again; and 4401 (the access token lapsed)
 * dials again at once with a renewed one. Only a refused credential is final.
 */

/** The browser's schedule, capped at 30 s, as in tui/src/terminalSocket.ts. */
export const BACKOFF_MS: readonly number[] = [0, 500, 1000, 2000, 4000, 8000, 15000, 30000];
/** The server sends a heartbeat every 25 s (index.ts); two missed, plus slack. */
export const STALE_MS = 60_000;
/** CLI_WS_REAUTH_CLOSE_CODE in backend/src/routes/cliWs.ts. */
export const REAUTH_CLOSE_CODE = 4401;

/** 1008 reasons no wait can change: the credential, or an orchestrator without this socket. */
const FINAL_1008 = ['termag login', 'credential revoked', 'login required', 'unknown user', 'unknown path'];

export function statusSocketUrl(host: string): string {
  const url = new URL(`${host}${API_PREFIX}/ws/status`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export interface StatusSocketOptions {
  url: string;
  token: BearerSource;
  /** Each frame's text. */
  onText: (text: string) => void;
  /** Upgraded; the server's replay of every current status follows. */
  onOpen: () => void;
  /** Closed for a reason worth retrying; the next dial is in `retryInMs`. */
  onDown: (reason: string, retryInMs: number) => void;
  /** Closed for good. Nothing is dialed after this. */
  onFatal: (err: CliError) => void;
  staleMs?: number;
  backoffMs?: readonly number[];
}

type Next =
  | { kind: 'retry'; reason: string }
  /** Dial again at once, asking for a renewed token. */
  | { kind: 'renew' }
  | { kind: 'fatal'; error: CliError };

/** What a close means. `renewed`: this dial's token was already a renewal of a refused one. */
export function nextAfterClose(code: number, reason: string, lastError: string | undefined, renewed: boolean): Next {
  const http = /Unexpected server response: (\d{3})/.exec(lastError ?? '');
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) {
      return renewed
        ? { kind: 'fatal', error: new CliError('auth_required', `The orchestrator refused the CLI's credential on its status socket (HTTP ${status}); run \`termag login\``, status) }
        : { kind: 'renew' };
    }
    if (status >= 300 && status < 400) {
      return { kind: 'fatal', error: new CliError('edge_auth', 'The orchestrator\'s edge redirected the status socket to a browser sign-in: it does not let the CLI through yet', status) };
    }
    if (status === 404) {
      return { kind: 'fatal', error: new CliError('not_cli_enabled', 'This orchestrator has no CLI status socket; it may predate it', status) };
    }
    return { kind: 'retry', reason: `HTTP ${status}` };
  }
  if (code === REAUTH_CLOSE_CODE) return { kind: 'renew' };
  if (code === 1008 && FINAL_1008.some(f => reason.toLowerCase().includes(f))) {
    return { kind: 'fatal', error: new CliError(reason.includes('unknown path') ? 'not_cli_enabled' : 'auth_required', reason) };
  }
  return { kind: 'retry', reason: reason || lastError || `closed (${code})` };
}

export function openStatusSocket(o: StatusSocketOptions): { stop: () => void } {
  const backoff = o.backoffMs ?? BACKOFF_MS;
  const staleMs = o.staleMs ?? STALE_MS;
  let stopped = false;
  let attempt = 0;
  let refused: string | undefined;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (ms: number) => { timer = setTimeout(() => { timer = null; void dial(); }, ms); };
  const retry = (reason: string) => {
    const ms = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    o.onDown(reason, ms);
    schedule(ms);
  };
  const fatal = (err: CliError) => { stopped = true; o.onFatal(err); };

  async function dial(): Promise<void> {
    if (stopped) return;
    const renewed = refused !== undefined;
    let token: string;
    try {
      token = await o.token(renewed ? { rejected: refused } : undefined);
    } catch (err) {
      if (stopped) return;
      if (err instanceof CliError && err.code === 'auth_required') { fatal(err); return; }
      retry(err instanceof Error ? err.message : String(err));
      return;
    }
    refused = undefined;
    if (stopped) return;
    const ws = new WebSocket(o.url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': `termag-cli/${VERSION}` },
      handshakeTimeout: 30_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    socket = ws;
    let lastFrameAt = Date.now();
    let lastError: string | undefined;
    let stale = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt <= staleMs) return;
      stale = true;
      ws.terminate();
    }, Math.min(5_000, staleMs));
    ws.on('open', () => { lastFrameAt = Date.now(); o.onOpen(); });
    ws.on('message', (data) => {
      lastFrameAt = Date.now();
      attempt = 0;
      o.onText(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    ws.on('error', (e) => { lastError = e.message; });
    ws.on('close', (code, reasonBuf) => {
      clearInterval(watchdog);
      if (stopped || socket !== ws) return;
      socket = null;
      if (stale) { retry(`no word from the orchestrator in ${Math.round(staleMs / 1000)} s`); return; }
      const next = nextAfterClose(code, reasonBuf.toString(), lastError, renewed);
      switch (next.kind) {
        case 'fatal': fatal(next.error); return;
        case 'renew': refused = token; schedule(0); return;
        case 'retry': retry(next.reason); return;
        default: { const exhaustive: never = next; return exhaustive; }
      }
    });
  }

  void dial();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { socket?.terminate(); } catch { /* already gone */ }
      socket = null;
    },
  };
}
