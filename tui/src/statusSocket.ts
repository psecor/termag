import WebSocket from 'ws';
import type { SessionMap } from './model.js';
import { handshakeRefusal } from './terminalSocket.js';
import type { AgentStatusValue, SessionRow } from './types.js';

/**
 * The backend's status push, on the CLI's socket: /api/cli/v1/ws/status
 * (backend/src/routes/cliWs.ts). On connect the server replays every current
 * status, then pushes `{type:'status', session, …}` on change and
 * `{type:'heartbeat'}` every 25s. The bearer goes in the Authorization header
 * on each connect, fetched fresh so a renewed access token is the one sent.
 *
 * Polling /api/cli/v1/sessions stays on as the source of truth for
 * alive/connected; this socket only makes status transitions immediate.
 */
export interface StatusFrame {
  type: 'status';
  session: string;
  /** Present on backends that key status per box; absent on older ones. */
  instanceId?: string | null;
  status: AgentStatusValue;
  updatedAt?: string;
  source?: string;
  waitingReason?: 'approval' | 'user_input' | 'unknown' | null;
  contextTokens?: number | null;
  rateLimited?: string | null;
  /** The review sweep's record on an agent session: only its state is read. */
  review?: { state: SessionRow['reviewState'] } | null;
}
export interface HeartbeatFrame { type: 'heartbeat'; ts: number }
export type Frame = StatusFrame | HeartbeatFrame;

export function parseFrame(data: unknown): Frame | null {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
  if (text === null) return null;
  try {
    const f = JSON.parse(text) as Partial<Frame> & { type?: string };
    if (f.type === 'heartbeat') return { type: 'heartbeat', ts: Number((f as HeartbeatFrame).ts) || Date.now() };
    if (f.type === 'status' && typeof (f as StatusFrame).session === 'string' && typeof (f as StatusFrame).status === 'string') return f as StatusFrame;
    return null;
  } catch { return null; }
}

/**
 * Merge a status frame into the session map. The map is keyed by
 * project/workstream/role, so match rows by tmux session name — and by box when
 * the frame says which one, since the same name can exist on two boxes. Unknown
 * sessions are ignored (the next poll adds them).
 */
export function applyStatusFrame(map: SessionMap, f: StatusFrame): SessionMap {
  let next: SessionMap | null = null;
  for (const [key, row] of Object.entries(map)) {
    if (row.session !== f.session) continue;
    if (f.instanceId !== undefined && (row.instanceId ?? null) !== (f.instanceId ?? null)) continue;
    next ??= { ...map };
    next[key] = {
      ...row,
      status: f.status,
      updatedAt: f.updatedAt ?? row.updatedAt,
      waitingReason: f.waitingReason === undefined ? row.waitingReason : f.waitingReason,
      contextTokens: f.contextTokens === undefined ? row.contextTokens : f.contextTokens,
      rateLimited: f.rateLimited === undefined ? row.rateLimited : f.rateLimited,
      reviewState: f.review === undefined ? row.reviewState : f.review?.state ?? null,
    };
  }
  return next ?? map;
}

export type SocketState = 'connecting' | 'open' | 'closed' | 'rejected';

export interface StatusSocketHandlers {
  onFrame: (f: Frame) => void;
  onState: (s: SocketState, detail?: string) => void;
}

const RECONNECT_MS = 3_000;
const STALE_MS = 60_000; // two missed heartbeats + slack, as the web client does

export class StatusSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  lastFrameAt = 0;

  /** `token` is asked on every connect; the API client renews it first when it is about to lapse. */
  constructor(private url: string, private token: () => Promise<string>, private handlers: StatusSocketHandlers) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onState('connecting');
    this.token().then((token) => {
      if (this.stopped) return;
      this.open(token);
    }, (e: unknown) => {
      // The refresh itself failed: a 401 there is the sign-in, not the network.
      const msg = e instanceof Error ? e.message : String(e);
      if (/401|termag login/.test(msg)) { this.handlers.onState('rejected', msg); return; }
      this.handlers.onState('closed', msg);
      this.schedule();
    });
  }

  private open(token: string): void {
    let ws: WebSocket;
    try { ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${token}` } }); } catch (e) {
      this.handlers.onState('closed', e instanceof Error ? e.message : String(e));
      this.schedule();
      return;
    }
    this.ws = ws;
    let lastError: string | undefined;
    ws.on('open', () => { this.lastFrameAt = Date.now(); this.handlers.onState('open'); this.armWatchdog(); });
    ws.on('message', (data) => {
      const f = parseFrame(data as Buffer | string);
      if (!f) return;
      this.lastFrameAt = Date.now();
      this.handlers.onFrame(f);
    });
    ws.on('error', (e) => { lastError = e.message; /* 'close' follows */ });
    ws.on('close', (code, reasonBuf) => {
      if (this.watchdog) clearInterval(this.watchdog);
      if (this.stopped || this.ws !== ws) return;
      const reason = reasonBuf.toString();
      // An HTTP 401/403 at the handshake, or 1008 (policy violation) once
      // upgraded: the server refused our credential. Retrying will not help.
      const refused = handshakeRefusal(lastError);
      if (refused?.fatal) { this.handlers.onState('rejected', `HTTP ${refused.status}`); return; }
      if (code === 1008) { this.handlers.onState('rejected', reason || 'rejected'); return; }
      this.handlers.onState('closed', reason || lastError || `code ${code}`);
      this.schedule();
    });
  }

  private armWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > STALE_MS) {
        try { this.ws?.close(4000, 'stale'); } catch { /* ignore */ }
      }
    }, 5_000);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RECONNECT_MS);
  }
}
