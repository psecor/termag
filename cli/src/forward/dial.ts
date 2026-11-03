import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { API_PREFIX } from '../api.js';
import { VERSION } from '../version.js';

export const SUBPROTOCOL = 'termag-forward.v1';
/** The access token renewed in band (renew.ts); an orchestrator that predates it picks v1. */
export const SUBPROTOCOL_V2 = 'termag-forward.v2';
const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_BODY = 16 * 1024;

export type DialOutcome =
  | { kind: 'open'; ws: WebSocket }
  /** An HTTP answer instead of the upgrade: the contract's refusals, or the edge's own. */
  | { kind: 'refused'; status: number; code: string; error?: string }
  /** No answer at all: unreachable, timed out, or aborted. */
  | { kind: 'failed'; reason: string };

/** `wss://<host>/api/cli/v1/boxes/<id>/forward/<port>`: no credential in it, ever. */
export function forwardUrl(host: string, boxId: string, port: number): string {
  const url = new URL(`${host}${API_PREFIX}/boxes/${encodeURIComponent(boxId)}/forward/${port}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { if (text.length < MAX_BODY) text += chunk; });
    res.on('end', () => resolve(text));
    res.on('error', () => resolve(text));
  });
}

function refusalFrom(res: IncomingMessage, text: string): Extract<DialOutcome, { kind: 'refused' }> {
  const status = res.statusCode ?? 0;
  let body: { error?: unknown; code?: unknown } | null = null;
  try { body = JSON.parse(text); } catch { /* the edge's HTML */ }
  if (status >= 300 && status < 400) return { status, code: 'edge_auth', kind: 'refused', error: 'the orchestrator\'s edge redirected the CLI to a browser sign-in' };
  if (!body || typeof body !== 'object') {
    return { kind: 'refused', status, code: status === 401 ? 'auth_required' : `http_${status}` };
  }
  const code = typeof body.code === 'string' ? body.code : status === 401 ? 'auth_required' : `http_${status}`;
  return { kind: 'refused', status, code, error: typeof body.error === 'string' ? body.error : undefined };
}

/**
 * Open one forward socket, with the bearer in the Authorization header (the
 * server refuses `?token=`), offering v2 then v1: the open socket's
 * `protocol` says which the orchestrator picked. Resolves once it is open
 * (and paused) or refused; `abort` gives up on a dial still in flight.
 */
export function dialForward(url: string, token: string): { outcome: Promise<DialOutcome>; abort: () => void } {
  const ws = new WebSocket(url, [SUBPROTOCOL_V2, SUBPROTOCOL], {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': `termag-cli/${VERSION}` },
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: 1024 * 1024,
    followRedirects: false,
  });
  let settled = false;
  let resolveOutcome!: (o: DialOutcome) => void;
  const outcome = new Promise<DialOutcome>(resolve => { resolveOutcome = resolve; });
  const settle = (o: DialOutcome) => {
    if (settled) return;
    settled = true;
    ws.off('open', onOpen).off('unexpected-response', onResponse);
    resolveOutcome(o);
  };
  // Frames can follow the upgrade at once (a server-first protocol's banner):
  // hold them until the pipe is listening.
  const onOpen = () => { ws.pause(); settle({ kind: 'open', ws }); };
  const onResponse = (_req: unknown, res: IncomingMessage) => {
    void readBody(res).then((text) => {
      settle(refusalFrom(res, text));
      ws.terminate();
    });
  };
  ws.on('open', onOpen);
  ws.on('unexpected-response', onResponse);
  ws.on('error', (err: NodeJS.ErrnoException) => settle({ kind: 'failed', reason: err.code ?? err.message }));
  ws.on('close', () => settle({ kind: 'failed', reason: 'closed' }));
  return {
    outcome,
    abort: () => { settle({ kind: 'failed', reason: 'aborted' }); ws.terminate(); },
  };
}
