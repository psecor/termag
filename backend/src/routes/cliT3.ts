/**
 * The desktop app's box bridge under /api/cli/v1:
 * a termag box as a t3code environment the desktop connects to through the
 * orchestrator.
 *
 *   POST /boxes/:id/t3/ensure     start the box's t3 server if it isn't running
 *   POST /boxes/:id/t3/update     move the box's t3 server to the desktop's release
 *                                 when it is newer, restarting it onto it
 *   POST /boxes/:id/t3/pair       a one-time t3 pairing credential, minted on the box;
 *                                 with a label, what an earlier pair of it left is revoked
 *   POST /boxes/:id/t3/revoke     revoke the box's t3 sessions and pairing credentials of a label
 *   GET  /boxes/:id/t3/projects   the box's termag projects, as the box sees them
 *   POST /boxes/:id/spaces/sync   the box copies the spaces it reaches to ~/termag/spaces (`termag space sync`)
 *   ALL  /boxes/:id/t3/relay/*    reverse proxy to the box's t3 server, HTTP and
 *                                 WebSocket, over a tunnel the box's agent opens
 *
 * Each is a device sign-in's (a box's own token gets 403: anything on the box
 * can read it), for the box's owner only (404 otherwise, as for no such box).
 * The JSON routes sit in the
 * CLI router; the relay is mounted ahead of the cors and body-parser
 * middleware (index.ts), because it forwards bodies and preflights untouched.
 *
 * The relay terminates the client's WebSocket and opens its own to the box,
 * so it can keep judging the credential (routes/cliWs.ts), keep the socket
 * alive through the ALB, and close with codes t3's client reads right: 1012
 * to redial (an access token lapsed, or draining; RELAY_REDIAL_CLOSE_CODE),
 * 1008 for a sign-in revoked or expired, 4409 parked box, 1011 tunnel failed.
 * It reads each side no faster than the other writes (relayMessages).
 *
 * Whatever a relayed connection holds (its tunnel, its socket to the box) is
 * tied to the client's connection from before the first await (Hangup), so a
 * client that leaves while the box is being reached never leaves them open.
 */
import http, { type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { Router, type RequestHandler, type Response } from 'express';
import WebSocket, { type WebSocketServer } from 'ws';
import { asyncHandler } from '../middleware/errors';
import { bearerToken } from '../auth/agentWsToken';
import type { CliUser } from '../services/cliStore';
import type { OpenedTunnel, AgentTunnels } from '../services/agentTunnels';
import { TunnelError } from '../services/agentTunnels';
import { requestHeadersToBox, responseHeadersFromBox } from '../services/t3RelayHeaders';
import type { CliAuth, CliBearerDeps } from './cliApi';
import { authenticateCliUpgrade, CLI_WS_RECHECK_MS, refusalResponse, watchCliSocket } from './cliWs';
import type { RouteResult } from './routeResult';
import { acceptsScope } from '../services/agentTokenScopes';

export type T3Access =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string; parked?: string };

export interface CliT3 {
  /** The owner, the flag, and a box whose agent is up and speaks t3-v1. */
  access(user: CliUser, boxId: string): Promise<T3Access>;
  ensure(user: CliUser, boxId: string): Promise<RouteResult>;
  /** The box's t3 server moved to fork release `version` when it is newer (agent/t3-bridge.js `update`). */
  update(user: CliUser, boxId: string, version: string): Promise<RouteResult>;
  pair(user: CliUser, boxId: string, label: string | undefined): Promise<RouteResult>;
  /** Revoke the box's t3 sessions and unredeemed pairing credentials carrying `label`. */
  revoke(user: CliUser, boxId: string, label: string): Promise<RouteResult>;
  projects(user: CliUser, boxId: string): Promise<RouteResult>;
  /** Have the box copy the spaces it reaches (or `space`) to disk, read-only; what it copied. */
  spaceSync(user: CliUser, boxId: string, space: string | undefined): Promise<RouteResult>;
  /** A tunnel to the box's t3 server, starting the server once if it isn't running. Rejects with a TunnelError. */
  openTunnel(user: CliUser, boxId: string): Promise<OpenedTunnel>;
}

const LABEL_MAX = 80;
// What the box's agent takes as a t3 label (agent/t3-bridge.js LABEL_RE).
const LABEL_RE = /^[\w .:@()-]{1,80}$/;
const LABEL_ERROR = { error: `label must be 1-${LABEL_MAX} letters, digits, spaces or . : @ ( ) - _`, code: 'invalid_request' };

/** The body's label, trimmed; undefined when there is none, null when it isn't one the box takes. */
function bodyLabel(body: unknown): string | undefined | null {
  const raw = (body as { label?: unknown } | undefined)?.label;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return LABEL_RE.test(label) ? label : null;
}
// A space's name (the CLI's SPACE_NAME_RE), and never one the box's CLI would read as an option.
const SPACE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

// A fork release's version, as the box's agent takes it (agent/t3-bridge.js RELEASE_VERSION_RE).
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const VERSION_ERROR = { error: 'version must be a release version, x.y.z', code: 'invalid_request' };
const BOX_ONLY = {
  error: "A box's own credentials can't reach the desktop bridge; sign in with `termag login`",
  code: 'forbidden',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function send(res: Response, result: RouteResult): void {
  res.status(result.status).json(result.body);
}

/** After the bearer: a device sign-in goes on, a box's own token gets 403 `forbidden`. The bridge's routes take it, and the desktop's preview shares (routes/cliPreviewShares.ts). */
export const deviceOnly: RequestHandler = (_req, res, next) => {
  if (cliAuth(res).credential.kind !== 'device') { res.status(403).json(BOX_ONLY); return; }
  next();
};

/** The JSON routes, mounted in the CLI router (routes/cliApi.ts). */
export function mountCliT3Routes(router: Router, t3: CliT3, bearer: RequestHandler): void {
  router.post('/boxes/:id/t3/ensure', bearer, deviceOnly, asyncHandler(async (req, res) => {
    send(res, await t3.ensure(cliAuth(res).user, req.params.id));
  }));

  // The desktop's own version, when the box's server reports an older one.
  router.post('/boxes/:id/t3/update', bearer, deviceOnly, asyncHandler(async (req, res) => {
    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) { res.status(400).json(VERSION_ERROR); return; }
    send(res, await t3.update(cliAuth(res).user, req.params.id, version));
  }));

  router.post('/boxes/:id/t3/pair', bearer, deviceOnly, asyncHandler(async (req, res) => {
    const label = bodyLabel(req.body);
    if (label === null) { res.status(400).json(LABEL_ERROR); return; }
    send(res, await t3.pair(cliAuth(res).user, req.params.id, label));
  }));

  // The desktop's Forget and sign-out. A t3 session can't revoke itself, so
  // the box's own t3 CLI does it, by the label the desktop paired with.
  router.post('/boxes/:id/t3/revoke', bearer, deviceOnly, asyncHandler(async (req, res) => {
    const label = bodyLabel(req.body);
    if (!label) { res.status(400).json(LABEL_ERROR); return; }
    send(res, await t3.revoke(cliAuth(res).user, req.params.id, label));
  }));

  router.get('/boxes/:id/t3/projects', bearer, deviceOnly, asyncHandler(async (req, res) => {
    send(res, await t3.projects(cliAuth(res).user, req.params.id));
  }));

  // The desktop's Space in a box thread: the box copies its spaces on its own
  // token (`termag space sync`), so the bytes never pass through here.
  router.post('/boxes/:id/spaces/sync', bearer, deviceOnly, asyncHandler(async (req, res) => {
    const space = (req.body as { space?: unknown } | undefined)?.space;
    if (space !== undefined && (typeof space !== 'string' || !SPACE_RE.test(space))) {
      res.status(400).json({ error: 'space must be a space name', code: 'invalid_request' });
      return;
    }
    send(res, await t3.spaceSync(cliAuth(res).user, req.params.id, space));
  }));
}

function tunnelFailure(err: unknown): { status: number; error: string; code: string } {
  if (err instanceof TunnelError) return { status: err.status, error: err.message, code: err.code };
  return { status: 502, error: (err as Error)?.message ?? 'tunnel failed', code: 'tunnel_failed' };
}

/**
 * What a relayed connection holds, dropped when its client hangs up. Armed
 * before the first await: a client that leaves while the bearer, the box check
 * or the tunnel are still awaited has already fired it, so whatever is opened
 * for it afterwards is dropped at once instead of staying open with nobody on
 * the other end.
 */
export class Hangup {
  private drops: Array<() => void> = [];
  private armed = true;
  gone = false;

  /** The client left: drop everything held, newest first. */
  fire(): void {
    if (this.gone || !this.armed) return;
    this.gone = true;
    for (const drop of this.drops.splice(0).reverse()) {
      try { drop(); } catch { /* already gone */ }
    }
  }

  /** Drop `drop` when the client leaves; at once, answering false, when it already has. */
  hold(drop: () => void): boolean {
    if (this.gone) {
      try { drop(); } catch { /* already gone */ }
      return false;
    }
    if (this.armed) this.drops.push(drop);
    return true;
  }

  /** The connection was handed on (upgraded); its own close handlers take over. */
  disarm(): void {
    this.armed = false;
    this.drops = [];
  }
}

/**
 * The HTTP relay, mounted at /api/cli/v1/boxes/:id/t3/relay ahead of cors and
 * the body parsers. One tunnel per request; the box sees `Connection: close`.
 */
export function cliT3RelayRouter(deps: { bearer: RequestHandler; t3: CliT3 }): Router {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Ahead of the bearer, the first await (see Hangup).
    const hangup = new Hangup();
    res.once('close', () => hangup.fire());
    res.locals.t3Hangup = hangup;
    next();
  });
  router.use(deps.bearer, asyncHandler(async (req, res) => {
    const hangup = res.locals.t3Hangup as Hangup;
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(BOX_ONLY); return; }
    const boxId = (req.params as { id: string }).id;
    const access = await deps.t3.access(user, boxId);
    if (!access.ok) { res.status(access.status).json({ error: access.error, code: access.code }); return; }
    let tunnel: OpenedTunnel;
    try {
      tunnel = await deps.t3.openTunnel(user, boxId);
    } catch (err) {
      const f = tunnelFailure(err);
      res.status(f.status).json({ error: f.error, code: f.code });
      return;
    }
    // The client left while the tunnel opened: nobody to relay for.
    if (!hangup.hold(() => tunnel.stream.destroy())) return;
    const headers = requestHeadersToBox(req.headers, tunnel.port);
    headers.connection = 'close';
    const upstream = http.request({
      // No `agent`: with one (even `false`) http ignores createConnection.
      createConnection: () => tunnel.stream as unknown as import('net').Socket,
      method: req.method,
      path: req.url || '/',
      headers,
    });
    // One log line per relayed request that fails on the box's side; none when
    // the client left first (Hangup), as that is the client's doing.
    let failed = false;
    const fail = (reason: string) => {
      if (failed || hangup.gone) return;
      failed = true;
      console.warn(`[T3-RELAY] box=${boxId} user=${user.id} ${reason}`);
    };
    upstream.on('response', (up) => {
      // Like every /api/cli/v1 answer: a relayed one is one person's data.
      res.writeHead(up.statusCode ?? 502, { ...responseHeadersFromBox(up.headers), 'cache-control': 'no-store' });
      up.pipe(res);
      // The box's answer cut short (the tunnel closed before its end, say):
      // pipe never ends `res` then, and the client would wait for the rest
      // until a proxy timed out. Cut the client's answer short too, so it sees
      // the truncation at once. `up` errors only with a listener.
      up.on('error', () => {});
      up.on('close', () => {
        if (up.complete) return;
        fail(`response from the box cut short after headers (status ${up.statusCode ?? 0})`);
        res.destroy();
        tunnel.stream.destroy();
      });
    });
    upstream.on('error', (err) => {
      fail(`box request failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
      if (!res.headersSent) res.status(502).json({ error: `The box's t3 server did not answer: ${err.message}`, code: 't3_failed' });
      else res.destroy(err);
      tunnel.stream.destroy();
    });
    // The response's close (answered, or the client gone) ends both.
    hangup.hold(() => upstream.destroy());
    req.pipe(upstream);
  }));
  return router;
}

// ── WebSockets ──────────────────────────────────────────────────────────────

const RELAY_PATH_RE = /^\/api\/cli\/v1\/boxes\/([^/]+)\/t3\/relay(\/.*)?$/;

/** The box and the path to send it for a relay upgrade, or null for every other path. */
export function t3RelayTarget(url: URL, basePath: string): { boxId: string; path: string } | null {
  if (!url.pathname.startsWith(`${basePath}/`)) return null;
  const m = RELAY_PATH_RE.exec(url.pathname.slice(basePath.length));
  if (!m) return null;
  let boxId: string;
  try { boxId = decodeURIComponent(m[1]); } catch { return null; }
  return { boxId, path: `${m[2] || '/'}${url.search}` };
}

export function isAgentTunnelPath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/ws/agent-tunnel`;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  429: 'Too Many Requests', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** A refused upgrade in the CLI API's JSON shape. */
export function rawRefusal(status: number, code: string, error: string): string {
  const body = JSON.stringify({ error, code });
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n\r\n'
    + body;
}

/** A close code a server may send: the box's own, or 1011 for the reserved ones. */
export function relayCloseCode(code: number): number | undefined {
  if (code === 1005) return undefined;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

export function closeSafely(ws: WebSocket, code: number, reason: Buffer | string): void {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  const c = relayCloseCode(code);
  const r = Buffer.from(reason ?? '').subarray(0, 123);
  try { if (c === undefined) ws.close(); else ws.close(c, r); } catch { /* closing */ }
  const kill = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 5_000);
  kill.unref?.();
  ws.once('close', () => clearTimeout(kill));
}

export interface T3RelayUpgradeDeps {
  bearer: CliBearerDeps;
  t3: CliT3;
  /** A noServer WebSocketServer for relay clients, built with relayServerOptions(). */
  wss: WebSocketServer;
  isServing: () => boolean;
  /** How often an open relay socket re-judges its bearer; default CLI_WS_RECHECK_MS. */
  recheckMs?: number;
  /** Keep the client socket alive through the ALB (ping every 25 s). */
  heartbeat?: (ws: WebSocket) => void;
  /** Default RELAY_REDIAL_CLOSE_CODE. */
  drainCloseCode?: number;
  parkedCloseCode?: number;
}

/** The subprotocol the box chose, for the relay server to agree to. */
const chosenProtocol = new WeakMap<IncomingMessage, string>();

/**
 * The largest WebSocket message the relay takes from either side, instead of
 * ws's 100 MiB default; a bigger one closes that side with 1009. t3's largest
 * frames are a turn diff (10 MB before JSON escaping), a composer context (16M
 * characters) and, only when a queued message is edited, its images inlined as
 * data URLs (at most 14 MB each); everything else is capped at 1 MiB or less.
 * Normal sends upload images over HTTP.
 */
export const RELAY_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** Above this much buffered on one side, the relay stops reading the other... */
export const RELAY_HIGH_WATER_BYTES = 1024 * 1024;
/** ...until a send completes with no more than this left buffered. */
export const RELAY_LOW_WATER_BYTES = 256 * 1024;
/**
 * The close code for a relay socket that should simply be dialed again: its
 * access token lapsed while its sign-in is still good, or this process is
 * draining. 1012 (service restart), which every t3 stream retries. Not the
 * CLI's 4401, which t3's preview and device streams take, like 1008, as a
 * final "unauthorized", nor the drain's 4503, which its preview stream reads as
 * its own host-setup code. The desktop proxy passes the code through and adds a
 * fresh token to the redial. A revoked or expired sign-in still closes with 1008.
 */
export const RELAY_REDIAL_CLOSE_CODE = 1012;

export function relayServerOptions(): WebSocket.ServerOptions {
  return {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: RELAY_MAX_PAYLOAD_BYTES,
    handleProtocols: (_offered, req) => chosenProtocol.get(req) ?? false,
  };
}

type RelaySocket = Pick<WebSocket, 'on' | 'send' | 'pause' | 'resume' | 'readyState' | 'bufferedAmount'>;

/**
 * Send every message `from` receives on to `to`, reading `from` no faster than
 * `to` writes: once more than `high` bytes wait on `to`, `from` is paused (its
 * socket stops reading, so TCP pushes back on whoever is sending) until a send
 * completes with at most `low` left. Without it a fast sender and a slow
 * receiver buffer without bound in this process. A message `accept` turns
 * down is not sent on: it was for this process (the forward's in-band token).
 */
export function relayMessages(
  from: RelaySocket, to: RelaySocket, high = RELAY_HIGH_WATER_BYTES, low = RELAY_LOW_WATER_BYTES,
  accept?: (data: WebSocket.RawData, isBinary: boolean) => boolean,
): void {
  let paused = false;
  // Called once each send is handed to the socket (or fails as it closes).
  const sent = () => {
    if (paused && to.bufferedAmount <= low) { paused = false; from.resume(); }
  };
  from.on('message', (data, isBinary) => {
    if (accept && !accept(data, isBinary)) return;
    if (to.readyState !== WebSocket.OPEN) return;
    to.send(data, { binary: isBinary }, sent);
    if (!paused && to.bufferedAmount > high) { paused = true; from.pause(); }
  });
}

/**
 * Answer an upgrade on the raw socket and destroy it once written, as ws's
 * own refusals do: after an upgrade the socket is half-open and nothing reads
 * it, so an end() alone may never let it close.
 */
export function endUpgrade(socket: Duplex, raw: string | Buffer): void {
  if (socket.destroyed) return;
  if (!socket.writable) { socket.destroy(); return; }
  socket.once('finish', () => socket.destroy());
  socket.end(raw);
}

/**
 * Upgrade, then close at once with a code: how a WebSocket client learns why.
 * A client that offered subprotocols aborts a handshake that picks none, and
 * would never see the code, so this one agrees to the first it offered:
 * nothing is relayed on it.
 */
function upgradeAndClose(deps: T3RelayUpgradeDeps, req: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void {
  const first = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).find(Boolean);
  if (first) chosenProtocol.set(req, first);
  deps.wss.handleUpgrade(req, socket, head, (ws) => closeSafely(ws, code, reason));
}

export async function handleT3RelayUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: { boxId: string; path: string },
  deps: T3RelayUpgradeDeps,
): Promise<void> {
  // Ahead of the first await (see Hangup). ws never calls back for a socket
  // that is already gone (nor for a handshake it refuses itself), so the
  // socket's own close is what drops the tunnel and the box socket until the
  // client is upgraded.
  const hangup = new Hangup();
  const onSocketError = () => { /* 'close' follows */ };
  socket.on('error', onSocketError);
  socket.once('close', () => hangup.fire());

  const url = new URL(req.url ?? '', 'http://localhost');
  const opened = await authenticateCliUpgrade(deps.bearer, req, url);
  if ('error' in opened) { endUpgrade(socket, refusalResponse(opened)); return; }
  if (opened.auth.credential.kind !== 'device') { endUpgrade(socket, rawRefusal(403, BOX_ONLY.code, BOX_ONLY.error)); return; }
  const { user } = opened.auth;
  const access = await deps.t3.access(user, target.boxId);
  if (!access.ok && !access.parked) { endUpgrade(socket, rawRefusal(access.status, access.code, access.error)); return; }
  if (!deps.isServing()) { upgradeAndClose(deps, req, socket, head, deps.drainCloseCode ?? RELAY_REDIAL_CLOSE_CODE, 'server draining; reconnect'); return; }
  if (!access.ok) { upgradeAndClose(deps, req, socket, head, deps.parkedCloseCode ?? 4409, `box ${access.parked}`); return; }

  let tunnel: OpenedTunnel;
  try {
    tunnel = await deps.t3.openTunnel(user, target.boxId);
  } catch (err) {
    const f = tunnelFailure(err);
    if (f.status === 429) endUpgrade(socket, rawRefusal(f.status, f.code, f.error));
    else upgradeAndClose(deps, req, socket, head, 1011, f.error);
    return;
  }
  // The client left while the tunnel opened: nobody to relay for.
  if (!hangup.hold(() => tunnel.stream.destroy())) return;

  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let box: WebSocket;
  try {
    box = new WebSocket(`ws://127.0.0.1${target.path}`, offered, {
      createConnection: () => tunnel.stream as unknown as import('net').Socket,
      headers: requestHeadersToBox(req.headers, tunnel.port, { websocket: true }) as Record<string, string>,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      maxPayload: RELAY_MAX_PAYLOAD_BYTES,
    });
  } catch (err) {
    // ws throws at once on a duplicated or malformed subprotocol list.
    tunnel.stream.destroy();
    endUpgrade(socket, rawRefusal(400, 'invalid_request', `Invalid Sec-WebSocket-Protocol header: ${(err as Error).message}`));
    return;
  }
  hangup.hold(() => box.terminate());
  let upgraded = false;
  // The client is answered once: by the box's refusal, an error, or the upgrade.
  let answered = false;
  const answer = (raw: string | Buffer) => {
    if (answered) return;
    answered = true;
    endUpgrade(socket, raw);
  };
  box.on('error', () => { /* answered below; never an unhandled 'error' */ });
  box.once('unexpected-response', (_q, res) => {
    // The box refused the handshake (a bad wsTicket, say): hand its answer on.
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => { if (chunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) chunks.push(c); });
    res.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = responseHeadersFromBox(res.headers);
      delete headers['content-length'];
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`));
      answer(Buffer.concat([
        Buffer.from(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage || STATUS_TEXT[res.statusCode ?? 502] || ''}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`),
        body,
      ]));
      box.terminate();
    });
  });
  box.once('error', (err) => {
    if (!upgraded) answer(rawRefusal(502, 't3_failed', `The box's t3 server did not answer: ${err.message}`));
  });
  box.once('open', () => {
    if (answered) { box.terminate(); return; }
    upgraded = true;
    answered = true;
    // ws would destroy a socket that can no longer be upgraded without calling
    // back; say so here instead, and drop the box with it.
    if (hangup.gone || socket.destroyed || !socket.readable || !socket.writable) {
      box.terminate();
      socket.destroy();
      return;
    }
    if (box.protocol) chosenProtocol.set(req, box.protocol);
    deps.wss.handleUpgrade(req, socket, head, (client) => {
      // From here each side's close ends the other (below), with its code.
      hangup.disarm();
      socket.off('error', onSocketError);
      deps.heartbeat?.(client);
      // A lapsed access token closes 1012, not 4401, which t3 takes as final.
      watchCliSocket(client, deps.bearer, opened, deps.recheckMs ?? CLI_WS_RECHECK_MS, { reauthCloseCode: RELAY_REDIAL_CLOSE_CODE });
      relayMessages(client, box);
      relayMessages(box, client);
      client.on('close', (code, reason) => closeSafely(box, code, reason));
      box.on('close', (code, reason) => closeSafely(client, code, reason));
      client.on('error', () => box.terminate());
      box.on('error', () => client.terminate());
    });
  });
}

export interface AgentTunnelUpgradeDeps {
  tunnels: AgentTunnels;
  validateAgentToken: (raw: string) => Promise<{ token: { scope: string }; instance: { id: string } | null } | null>;
  /** A noServer WebSocketServer for tunnel dial-backs. */
  wss: WebSocketServer;
  heartbeat?: (ws: WebSocket) => void;
}

/**
 * A box agent dialing back for a tunnel: its own agent-scoped token, the box
 * the id was made for, an id this process made in the last 15 s, once.
 */
export async function handleAgentTunnelUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: AgentTunnelUpgradeDeps,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const id = url.searchParams.get('id') ?? '';
  const boxId = deps.tunnels.pendingBox(id);
  if (!boxId) { endUpgrade(socket, rawRefusal(404, 'not_found', 'No such tunnel')); return; }
  const raw = bearerToken(req.headers.authorization);
  if (!raw) { endUpgrade(socket, rawRefusal(401, 'auth_required', 'authorization required')); return; }
  const token = await deps.validateAgentToken(raw);
  if (!token || !acceptsScope('agentTunnel', token.token.scope) || token.instance?.id !== boxId) {
    endUpgrade(socket, rawRefusal(403, 'forbidden', 'This token is not the box the tunnel was opened for'));
    return;
  }
  deps.wss.handleUpgrade(req, socket, head, (ws) => {
    if (!deps.tunnels.accept(id, token.instance!.id, ws)) { ws.close(1008, 'unknown tunnel'); return; }
    deps.heartbeat?.(ws);
  });
}
