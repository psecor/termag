import { cliWsUrl } from './api.js';
import type { Role } from './types.js';

/**
 * Pure helpers for the remote-attach transport: the CLI's terminal WebSocket
 * (`/api/cli/v1/ws/terminal`, backend/src/routes/cliWs.ts), the same stream
 * the browser's xterm gets on `/ws/terminal`, behind the CLI's bearer check.
 *
 *   ws(s)://host/termag/api/cli/v1/ws/terminal?session=&projectId=&workstream=&cols=&rows=
 *   Authorization: Bearer <access token>        (header only; never in the URL)
 *
 * Frames are JSON text both ways:
 *   server → client  {type:'output', data}  {type:'exit'}
 *   client → server  {type:'input', data}  {type:'resize', cols, rows}
 *                    {type:'mouse', enabled}  {type:'paste-image', data}
 *
 * Always send projectId + workstream: without them the server falls back to
 * parsing the session name, which breaks on hyphenated project names.
 */
export interface TerminalTarget {
  session: string;
  projectId: string;
  projectName: string;
  workstream: string;
  role: Role;
  /** The project's box (null for the orchestrator host), for heartbeat attribution. */
  instanceId: string | null;
}

export function terminalWsUrl(base: string, t: TerminalTarget, cols: number, rows: number): string {
  return cliWsUrl(base, 'terminal', new URLSearchParams({
    session: t.session, projectId: t.projectId, workstream: t.workstream,
    cols: String(Math.max(1, cols)), rows: String(Math.max(1, rows)),
  }));
}

export type ServerFrame = { type: 'output'; data: string } | { type: 'exit' };

export function parseServerFrame(raw: unknown): ServerFrame | null {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (text === null) return null;
  try {
    const f = JSON.parse(text) as { type?: string; data?: unknown };
    if (f.type === 'output' && typeof f.data === 'string') return { type: 'output', data: f.data };
    if (f.type === 'exit') return { type: 'exit' };
    return null;
  } catch { return null; }
}

export const inputFrame = (data: string) => JSON.stringify({ type: 'input', data });
export const resizeFrame = (cols: number, rows: number) => JSON.stringify({ type: 'resize', cols, rows });

// ── prefix chord ────────────────────────────────────────────────────────────

/** Default prefix: Ctrl-\ (0x1c). Deliberately not tmux's C-b, which belongs to the inner tmux. */
export const DEFAULT_PREFIX = '\x1c';

export type ChordAction = 'detach' | 'flip' | 'next' | 'prev' | 'help';

const CHORDS: Record<string, ChordAction> = {
  d: 'detach',
  '\t': 'flip',
  n: 'next',
  p: 'prev',
  '?': 'help',
};

export type InputEvent = { send: string } | { action: ChordAction } | { unknown: true };

/**
 * Splits raw keyboard input into bytes to forward and chord actions, in the
 * order they were typed: a paste of `text` then a detach chord in one read
 * delivers `text` first. After the prefix, one key is consumed: a known chord
 * becomes an action, the prefix itself is sent literally, anything else is
 * dropped (and reported as unknown, so the caller can ring the bell). Pending
 * state survives across chunks.
 */
export class PrefixHandler {
  private pending = false;
  constructor(private prefix: string = DEFAULT_PREFIX) {}

  feed(data: string): InputEvent[] {
    const out: InputEvent[] = [];
    let send = '';
    const flush = () => { if (send) { out.push({ send }); send = ''; } };
    for (const ch of data) {
      if (this.pending) {
        this.pending = false;
        if (ch === this.prefix) send += ch;
        else if (CHORDS[ch]) { flush(); out.push({ action: CHORDS[ch] }); }
        else { flush(); out.push({ unknown: true }); }
        continue;
      }
      if (ch === this.prefix) { this.pending = true; continue; }
      send += ch;
    }
    flush();
    return out;
  }

  get isPending(): boolean { return this.pending; }
}

export function describePrefix(prefix: string): string {
  if (prefix.length === 1) {
    const code = prefix.charCodeAt(0);
    if (code === 0x1c) return 'C-\\';
    if (code === 0x1d) return 'C-]';
    if (code === 0x1e) return 'C-^';
    if (code === 0x1f) return 'C-_';
    if (code < 0x20) return `C-${String.fromCharCode(code + 0x60)}`;
  }
  return JSON.stringify(prefix);
}

// ── reconnect policy ────────────────────────────────────────────────────────

/** Same schedule as the browser client: retried forever, capped at 30s. */
export const BACKOFF_MS = [0, 500, 1000, 2000, 4000, 8000, 15000, 30000] as const;

export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)];
}

/**
 * 1008 is the server's "policy violation" code for everything from a missing
 * login to a box agent being offline. Only the reasons that cannot change by
 * waiting are fatal; "Agent not connected" and the like are retried.
 */
const FATAL_REASONS = [
  'login required', 'unknown user', 'session forbidden', 'session/project mismatch', 'session param required', 'unknown path',
  // The CLI socket closing on a credential that stopped being valid (backend routes/cliWs.ts).
  'termag login', 'credential revoked',
];

/**
 * The CLI socket's "your access token lapsed" close (CLI_WS_REAUTH_CLOSE_CODE in
 * backend/src/routes/cliWs.ts): dial again at once; the API client renews the
 * token on the way. Not fatal, and not worth a notice.
 */
export const REAUTH_CLOSE_CODE = 4401;

/** Mirrors TERMINAL_BOX_PARKED_CLOSE_CODE in backend/src/services/boxPowerPolicy.ts. */
export const BOX_PARKED_CLOSE_CODE = 4409;

export function isFatalClose(code: number, reason: string): boolean {
  if (code === BOX_PARKED_CLOSE_CODE) return parkedEnds(reason);
  if (code !== 1008) return false;
  const r = reason.toLowerCase();
  return FATAL_REASONS.some(f => r.includes(f));
}

/**
 * A parked box closes with 4409 and reason `box <status>`. As in the browser
 * (frontend/src/utils/terminalReconnect.ts), a box that is starting is worth
 * waiting for; one that is stopped, stopping or hibernat(ed|ing) is not.
 */
function parkedEnds(reason: string): boolean {
  return !/\bstarting\b/i.test(reason);
}

/**
 * A refused handshake: the orchestrator (or its ALB) answered the upgrade with
 * HTTP instead of 101. The `ws` client reports it as an error whose message
 * names the status; 401/403 mean our credential, which no retry fixes.
 */
export function handshakeRefusal(errorMessage: string | undefined): { status: number; fatal: boolean } | null {
  const m = /Unexpected server response: (\d{3})/.exec(errorMessage ?? '');
  if (!m) return null;
  const status = Number(m[1]);
  return { status, fatal: status === 401 || status === 403 };
}

// ── human-activity heartbeat ────────────────────────────────────────────────

/**
 * The web posts /api/status/heartbeat as soon as the user types and then every
 * 30s while they keep typing. Same contract: ask `shouldSend(now)` on every
 * keystroke; it says yes at most once per interval.
 */
export class HeartbeatGate {
  private lastSentAt = -Infinity;
  constructor(private intervalMs = 30_000) {}
  shouldSend(now: number): boolean {
    if (now - this.lastSentAt < this.intervalMs) return false;
    this.lastSentAt = now;
    return true;
  }
}
