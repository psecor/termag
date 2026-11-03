/**
 * The native port forward's orchestrator side: each TCP
 * connection `termag forward` accepts on a laptop becomes one WebSocket here,
 *
 *   GET /api/cli/v1/boxes/:id/forward/:port   Sec-WebSocket-Protocol: termag-forward.v2, termag-forward.v1
 *
 * relayed message for message to a dial-back from the box's agent, which
 * pipes it to 127.0.0.1:<port> on the box. `GET /api/cli/v1/boxes/:id/forward`
 * is the JSON probe the CLI asks once before it binds anything.
 *
 * Every check runs before the upgrade, in the contract's order (auth, device
 * sign-in, port, access, draining, caps, the tunnel-open RPC, the dial-back),
 * so a refusal is always a plain HTTP answer `{ error, code }` and an upgraded
 * socket always has a live box end. The relay passes every message untouched,
 * binary flag included (relayMessages: 1 MiB high, 256 KiB low water), so the
 * frames ({"t":"fin"} for a half-close included) are end to end between the
 * CLI and the agent, with one exception on v2 (below).
 *
 * Two subprotocols, v2 picked when offered. A forwarded stream can't redial,
 * so neither may end with its access token's hour the way the other CLI
 * sockets do:
 *
 * - v2 renews the token in band: the CLI sends `{"t":"token","token":"<JWT>"}`
 *   before the current one expires, and this process takes it (keepTokenFresh)
 *   instead of relaying it, so the agent never sees one. A token that expires
 *   with no valid replacement closes the forward with FORWARD_TOKEN_CLOSE_CODE
 *   (4402); a replacement for another user or device sign-in, or control
 *   frames past their budget, with FORWARD_RENEWAL_REFUSED_CLOSE_CODE (4406).
 * - v1, the CLI from before v2, sends none: its recheck skips the access
 *   token's `exp`, and FORWARD_V1_MAX_LIFETIME_MS (2 h) bounds it. From
 *   FORWARD_V1_REFUSE_AFTER a v1-only upgrade is refused.
 *
 * Close codes the client sees: 1000 and 1011 as the box end sent them, 4409
 * when the box end dropped because the box parked, 1011 for any other drop,
 * 1012 while this process drains, 4408 once the forward reached its
 * lifetime (12 h on v2, 2 h on v1), 4406 for a refused renewal, 1002 for a
 * text frame v2 doesn't know, and from watchCliSocket 1008 once the device
 * sign-in is revoked or expires, and on v1 4401 once the access token fails
 * verification for anything but its `exp` (a retired signing key); on v2
 * that and an expired token close with 4402.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { Router } from 'express';
import WebSocket, { type WebSocketServer } from 'ws';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import { TunnelError, type AgentTunnels } from '../services/agentTunnels';
import { recordForwardClose, recordForwardOpen, recordForwardRefusal } from '../services/forwardMetrics';
import { isJwtShaped } from '../services/cliJwt';
import { PORT_FORWARD_CAPABILITY } from '../services/portForwardFlag';
import { cliBearer, type CliAuth, type CliBearerDeps } from './cliApi';
import { Hangup, closeSafely, endUpgrade, rawRefusal, relayMessages, RELAY_HIGH_WATER_BYTES, RELAY_LOW_WATER_BYTES } from './cliT3';
import { authenticateCliUpgrade, CLI_WS_RECHECK_MS, refusalResponse, watchCliSocket } from './cliWs';

/** The first subprotocol: no in-band token, the recheck skips `exp`. Kept until no CLI offers v2 alone. */
export const FORWARD_SUBPROTOCOL = 'termag-forward.v1';
/** In-band token renewal ({"t":"token"}), and the access token's `exp` enforced. Picked over v1 when both are offered. */
export const FORWARD_SUBPROTOCOL_V2 = 'termag-forward.v2';
/**
 * From this instant a v1-only upgrade is refused (FORWARD_V1_REFUSED), however
 * many v1 forwards the telemetry still shows: v1 skips the token's `exp`, so a
 * stolen token could otherwise keep choosing it.
 */
export const FORWARD_V1_REFUSE_AFTER = Date.parse('2026-11-19T00:00:00Z');
/**
 * A v1 forward's lifetime cap, in place of FORWARD_MAX_LIFETIME_MS, until v1
 * is refused: what a stolen token that picks v1 is worth short of a revoke.
 */
export const FORWARD_V1_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
/**
 * v2's close code for an access token that expired with no valid replacement,
 * a replacement that was refused, or one whose signing key was retired.
 * Mirrored in cli/src/forward/refusals.ts.
 */
export const FORWARD_TOKEN_CLOSE_CODE = 4402;
/**
 * v2's close code for a renewal it refused, as against one that never came
 * (4402): a token for another user or device sign-in (a later `termag login`),
 * one that doesn't verify, or token frames past the budget below. Mirrored in
 * cli/src/forward/refusals.ts.
 */
export const FORWARD_RENEWAL_REFUSED_CLOSE_CODE = 4406;
/**
 * What one v2 socket may send of control frames. A token frame is verified
 * (RSA) at most once per FORWARD_RENEWAL_MIN_INTERVAL_MS, and one carrying the
 * token it already holds is ignored unverified; past
 * FORWARD_CONTROL_FRAMES_PER_WINDOW in FORWARD_CONTROL_WINDOW_MS, or a second
 * verify too soon, the socket is closed with 4406 and nothing more is
 * verified. The CLI sends one frame per renewal, about every 45 minutes.
 */
export const FORWARD_RENEWAL_MIN_INTERVAL_MS = 30_000;
export const FORWARD_CONTROL_FRAMES_PER_WINDOW = 20;
export const FORWARD_CONTROL_WINDOW_MS = 10 * 60_000;
/** The half-close frame, the one text frame v2 relays to the box. */
const FIN = '{"t":"fin"}';
/** A JWT is about 700 bytes; a token frame past this is not the CLI's. */
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
/**
 * A v2 client leg the relay has paused at its token's `exp` (the box end is
 * slow to take what it sends) can't read the renewal queued behind its data:
 * it is judged once it reads again. It is closed when, past `exp`, it has
 * been reading with no frame for FORWARD_OVERDUE_IDLE_MS (whatever was queued
 * ahead of a renewal has been read), has spent FORWARD_OVERDUE_READ_MS
 * reading in all, or has read FORWARD_OVERDUE_MAX_BYTES (more than could have
 * been in flight ahead of a renewal sent 10 min early: the CLI's 1 MiB of
 * unsent data, and the kernel and proxy buffers between). While paused it
 * carries nothing up, and only the recheck and FORWARD_MAX_LIFETIME_MS bound it.
 */
export const FORWARD_OVERDUE_IDLE_MS = 2_000;
export const FORWARD_OVERDUE_READ_MS = 10_000;
export const FORWARD_OVERDUE_MAX_BYTES = 32 * 1024 * 1024;
const OVERDUE_POLL_MS = 250;
/** The CLI and the agent send at most 64 KiB a frame. */
export const FORWARD_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const FORWARD_DRAIN_CLOSE_CODE = 1012;
export const FORWARD_PARKED_CLOSE_CODE = 4409;
/**
 * How long one forwarded connection may last from its upgrade. A v1 forward
 * outlives its access token's hour (watchCliSocket's ignoreAccessTokenExpiry),
 * so this bounds what a stolen one is worth short of a revoke; a v2 forward
 * keeps it as a backstop. At the cap both legs close, the client with
 * FORWARD_LIFETIME_CLOSE_CODE.
 */
export const FORWARD_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** The client's close code at FORWARD_MAX_LIFETIME_MS; the CLI reads it as "reconnect". */
export const FORWARD_LIFETIME_CLOSE_CODE = 4408;
export const FORWARD_LIFETIME_CLOSE_REASON = 'This forward reached its 12 h limit; reconnect';
export const FORWARD_V1_LIFETIME_CLOSE_REASON = 'This forward reached its 2 h limit; reconnect';
/** How long a client waits on a box end that failed or dropped, for its 'close' and the parked check, before it is terminated. */
export const FORWARD_BOX_DROP_GRACE_MS = 5_000;
/**
 * Forwards one process carries at once, all users together (FORWARD_MAX_CONCURRENT).
 * Each holds at most about 2 MiB of relay buffers (1 MiB high water each way)
 * plus kernel buffers, so 1000 bounds them near 2 GiB on a 64 GiB host.
 */
export const DEFAULT_FORWARD_MAX_CONCURRENT = 1000;

export type ForwardAccess = { ok: true } | { ok: false; status: number; error: string; code: string };

export interface ForwardBoxes {
  /** The owner, the flag, a box neither parked nor coming up, its agent's hello and capability. */
  access(user: CliUser, boxId: string): Promise<ForwardAccess>;
  /** Whether the box is parked or parking: a box end that dropped then closes the client with 4409. */
  parked(boxId: string): Promise<boolean>;
}

export interface CliForwardDeps {
  bearer: CliBearerDeps;
  boxes: ForwardBoxes;
  tunnels: Pick<AgentTunnels, 'openSocket' | 'count' | 'cap'>;
  /** A noServer WebSocketServer built with forwardServerOptions(). */
  wss: WebSocketServer;
  isServing: () => boolean;
  /** Default DEFAULT_FORWARD_MAX_CONCURRENT. */
  maxConcurrent?: number;
  /** Liveness for the client leg; tunnelHeartbeat, which never judges a leg the relay has paused. */
  heartbeat?: (ws: WebSocket) => void;
  /** How often an open forward re-judges its bearer; default CLI_WS_RECHECK_MS. */
  recheckMs?: number;
  /** Default FORWARD_BOX_DROP_GRACE_MS. */
  boxDropGraceMs?: number;
  /** v2's; default FORWARD_MAX_LIFETIME_MS. */
  maxLifetimeMs?: number;
  /** Default FORWARD_V1_MAX_LIFETIME_MS. */
  v1MaxLifetimeMs?: number;
  /** Default FORWARD_V1_REFUSE_AFTER, in ms since the epoch. */
  v1RefuseAfter?: number;
  now?: () => number;
}

export interface CliForward {
  /** Answer an upgrade on the forward path (forwardTarget). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: { boxId: string; port: string }): Promise<void>;
  /** The probe, mounted at /api/cli/v1/boxes/:id/forward. */
  router(): Router;
  /** Forwards this process carries or is opening. */
  active(): number;
  /**
   * Shutdown: record every relayed forward's close now, with `code`, then
   * close both its legs. The process exits before their close handshakes end,
   * so the 'close' handlers that would log them never run.
   */
  closeAll(code: number, reason: string): void;
}

const FORWARD_PATH_RE = /^\/api\/cli\/v1\/boxes\/([^/]+)\/forward\/([^/]*)$/;

/** The box and the raw port of a forward upgrade, or null for every other path. */
export function forwardTarget(url: URL, basePath: string): { boxId: string; port: string } | null {
  if (!url.pathname.startsWith(`${basePath}/`)) return null;
  const m = FORWARD_PATH_RE.exec(url.pathname.slice(basePath.length));
  if (!m) return null;
  try {
    return { boxId: decodeURIComponent(m[1]), port: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/** An integer port from 1 to 65535, written plainly; null for anything else. */
export function parseForwardPort(raw: string): number | null {
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

/** FORWARD_MAX_CONCURRENT, an integer from 1 to 100000, else the default. */
export function forwardMaxConcurrent(env: NodeJS.ProcessEnv): number {
  const raw = env.FORWARD_MAX_CONCURRENT?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n >= 1 && n <= 100_000 ? n : DEFAULT_FORWARD_MAX_CONCURRENT;
}

export function forwardServerOptions(): WebSocket.ServerOptions {
  return {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: FORWARD_MAX_PAYLOAD_BYTES,
    // Only ever reached once the offer was checked (upgrade, below).
    handleProtocols: (offered) => (offered.has(FORWARD_SUBPROTOCOL_V2) ? FORWARD_SUBPROTOCOL_V2 : offered.has(FORWARD_SUBPROTOCOL) ? FORWARD_SUBPROTOCOL : false),
  };
}

const DRAINING = { status: 503, code: 'draining', error: 'This orchestrator is restarting; try again' };
/** A box's own token (a CLI run on a box): forwards are for a laptop's device sign-in. */
export const FORWARD_BOX_ONLY = {
  status: 403, code: 'forbidden',
  error: "A box's own credentials can't open a port forward; run `termag forward` on your laptop, signed in with `termag login`",
};
/**
 * A CLI that offers only v1, after FORWARD_V1_REFUSE_AFTER. A CLI from before
 * v2 prints the code and this text for the port, so the text says what to do.
 */
export const FORWARD_V1_REFUSED = {
  status: 426, code: 'cli_outdated',
  error: 'This termag is too old for the forward: run `termag update`',
};
const NO_PROTOCOL = { status: 400, code: 'invalid_request', error: `Offer the subprotocol ${FORWARD_SUBPROTOCOL_V2}` };
const BAD_PORT = { status: 400, code: 'bad_port', error: 'The port must be an integer from 1 to 65535' };

/** The refusal for a failed tunnel: the agent's port verdicts as they are, everything else tunnel_failed. */
function tunnelRefusal(err: unknown): { status: number; code: string; error: string } {
  if (err instanceof TunnelError && ['port_refused', 'port_closed', 'too_many_tunnels'].includes(err.code)) {
    return { status: err.status, code: err.code, error: err.message };
  }
  const why = err instanceof TunnelError && err.code === 'tunnel_timeout' ? 'the box did not dial back in time' : ((err as Error)?.message ?? String(err));
  return { status: 502, code: 'tunnel_failed', error: `The box did not open the forward: ${why}` };
}

function offersV2(req: IncomingMessage): boolean {
  return String(req.headers['sec-websocket-protocol'] ?? '').split(',').some(p => p.trim() === FORWARD_SUBPROTOCOL_V2);
}

function offersForward(req: IncomingMessage): boolean {
  return String(req.headers['sec-websocket-protocol'] ?? '').split(',').some(p => [FORWARD_SUBPROTOCOL, FORWARD_SUBPROTOCOL_V2].includes(p.trim()));
}

function frameText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * A v2 forward's in-band token renewal. `control` takes each text frame from
 * the client but a fin: a valid `{"t":"token","token":…}` becomes the
 * credential watchCliSocket rechecks (`opened.raw`, swapped in place), and the
 * deadline moves to its `exp`. The replacement is verified whole, `exp`
 * included, and must carry the same user (`sub`) and device sign-in (`jti`)
 * as the token the forward was opened with; anything else closes the forward,
 * with no falling back on the old token. So does reaching the current token's
 * `exp` with no replacement, judged here alone (watchCliSocket skips `exp` on
 * v2), at least every `recheckMs` so a clock that jumps is caught too. A leg
 * the relay holds paused at `exp` is judged once it reads again
 * (FORWARD_OVERDUE_IDLE_MS, FORWARD_OVERDUE_MAX_BYTES); one that never does
 * carries nothing up, and the recheck (revocation, idle and maximum age, a
 * retired key) and FORWARD_MAX_LIFETIME_MS bound it.
 *
 * Both clocks are the orchestrator's (it signed `exp`), so a laptop's skew
 * plays no part here; the CLI renews by durations on its own clock.
 */
function keepTokenFresh(
  client: WebSocket, bearer: CliBearerDeps, opened: { auth: CliAuth; raw: string }, recheckMs: number,
): { control(data: WebSocket.RawData): void } {
  const clock = () => (bearer.now ?? (() => new Date()))().getTime();
  const { user, credential } = opened.auth;
  const sessionId = credential.kind === 'device' ? credential.sessionId : null;
  let deadline: NodeJS.Timeout | null = null;
  /** Past `exp` while paused: the poll, the bytes read since, when the last frame came, and the time spent reading. */
  let overdue: { poll: NodeJS.Timeout; bytes: number; lastFrameAt: number; readingMs: number } | null = null;
  let done = false;
  // Frames are judged in order: a verify is async (the keys load once).
  let queue: Promise<void> = Promise.resolve();
  const stopTimers = () => {
    if (deadline) clearTimeout(deadline);
    deadline = null;
    if (overdue) clearInterval(overdue.poll);
    overdue = null;
  };
  const end = (code: number, reason: string) => {
    if (done) return;
    done = true;
    stopTimers();
    closeSafely(client, code, reason);
  };
  const expired = () => end(FORWARD_TOKEN_CLOSE_CODE, 'Access token expired and was not renewed; reconnect');
  const verify = async (token: string, ignoreExpiry = false) => {
    if (!isJwtShaped(token)) return null;
    const claims = (await bearer.jwt).verify(token, clock(), { ignoreExpiry });
    return claims && claims.sub === user.id && claims.jti === sessionId ? claims : null;
  };
  // Every frame the leg reads, data or control, counts toward the overdue bound.
  client.on('message', (d) => {
    if (!overdue) return;
    overdue.bytes += messageBytes(d);
    overdue.lastFrameAt = Date.now();
    if (overdue.bytes > FORWARD_OVERDUE_MAX_BYTES) expired();
  });
  /** Past `exp` with the leg paused: wait for it to read what is queued, renewal included. */
  const awaitPausedLeg = () => {
    const poll = setInterval(() => {
      if (!overdue) return;
      // Idle counts from when it reads again.
      if (client.isPaused) { overdue.lastFrameAt = Date.now(); return; }
      overdue.readingMs += OVERDUE_POLL_MS;
      if (Date.now() - overdue.lastFrameAt >= FORWARD_OVERDUE_IDLE_MS || overdue.readingMs >= FORWARD_OVERDUE_READ_MS) expired();
    }, OVERDUE_POLL_MS);
    poll.unref?.();
    overdue = { poll, bytes: 0, lastFrameAt: Date.now(), readingMs: 0 };
  };
  // Until `exp` (or the next recheck, if sooner), then once more on the clock.
  // `known`: the claims of opened.raw, just verified, so they aren't verified again.
  const arm = async (known?: { exp: number }) => {
    stopTimers();
    // A device token itself (not a JWT) has no `exp`: its sign-in's own age bounds it.
    if (done || !isJwtShaped(opened.raw)) return;
    const claims = known ?? await verify(opened.raw, true);
    if (done) return;
    if (!claims) { end(FORWARD_TOKEN_CLOSE_CODE, 'Access token no longer valid; reconnect'); return; }
    const raw = opened.raw;
    deadline = setTimeout(() => {
      deadline = null;
      if (opened.raw !== raw) return;
      void verify(raw).then((live) => {
        if (opened.raw !== raw || done) return;
        if (live) void arm(live);
        else if (client.isPaused) awaitPausedLeg();
        else expired();
      }, () => { void arm(); /* the keys failed to load: try again at the next recheck */ });
    }, Math.min(recheckMs, Math.max(0, claims.exp * 1000 - clock())));
    deadline.unref?.();
  };
  void arm().catch(() => { /* the recheck judges */ });
  client.once('close', () => { done = true; stopTimers(); });

  const refused = (reason: string) => end(FORWARD_RENEWAL_REFUSED_CLOSE_CODE, reason);
  let windowStart = Date.now();
  let framesInWindow = 0;
  let lastVerifyAt = -Infinity;
  const renew = async (data: WebSocket.RawData) => {
    if (done) return;
    // The budget first: past it nothing is parsed, let alone verified.
    if (Date.now() - windowStart >= FORWARD_CONTROL_WINDOW_MS) { windowStart = Date.now(); framesInWindow = 0; }
    if (++framesInWindow > FORWARD_CONTROL_FRAMES_PER_WINDOW) { refused('Too many control frames'); return; }
    let msg: unknown = null;
    const text = frameText(data);
    if (text.length <= MAX_CONTROL_FRAME_BYTES) {
      try { msg = JSON.parse(text); } catch { /* not ours */ }
    }
    const m = msg as { t?: unknown; token?: unknown } | null;
    if (!m || typeof m !== 'object' || m.t !== 'token') { end(1002, 'Unknown control frame'); return; }
    const token = typeof m.token === 'string' ? m.token : '';
    // The token it holds already: nothing to judge.
    if (token === opened.raw) return;
    if (Date.now() - lastVerifyAt < FORWARD_RENEWAL_MIN_INTERVAL_MS) { refused('Renewals too frequent'); return; }
    lastVerifyAt = Date.now();
    const claims = await verify(token);
    if (done) return;
    // Another sign-in's token (a later `termag login`), or one that doesn't verify: never a fallback to the old one.
    if (!claims) { refused('Renewed access token refused (another sign-in, or not valid); reconnect'); return; }
    opened.raw = token;
    await arm(claims);
  };
  return {
    control: (data) => {
      queue = queue.then(() => renew(data)).catch(() => { /* the keys failed to load: keep the current token */ });
    },
  };
}

function messageBytes(data: WebSocket.RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data.byteLength;
}

export function createCliForward(deps: CliForwardDeps): CliForward {
  const now = deps.now ?? Date.now;
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_FORWARD_MAX_CONCURRENT;
  let active = 0;
  /** Each relayed forward's shutdown: record its close with this code, then close its legs. */
  const relayed = new Set<(code: number, reason: string) => void>();

  /** A slot under the process ceiling, given back once. */
  function reserve(): () => void {
    active++;
    let held = true;
    return () => { if (held) { held = false; active--; } };
  }

  /** Steps 3 to 5 of the contract's order, shared by the probe and the socket. */
  async function admit(user: CliUser, boxId: string): Promise<{ status: number; code: string; error: string } | null> {
    const access = await deps.boxes.access(user, boxId);
    if (!access.ok) return access;
    if (!deps.isServing()) return DRAINING;
    return null;
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: { boxId: string; port: string }): Promise<void> {
    const started = now();
    // Ahead of the first await (see Hangup): the socket's own close drops the
    // tunnel and the slot until the client is upgraded.
    const hangup = new Hangup();
    const onSocketError = () => { /* 'close' follows */ };
    socket.on('error', onSocketError);
    socket.once('close', () => hangup.fire());
    const { boxId } = target;
    let userId: string | null = null;
    let port: number | null = null;
    const refuse = (r: { status: number; code: string; error: string }) => {
      recordForwardRefusal({ userId, boxId, port, status: r.status, code: r.code });
      endUpgrade(socket, rawRefusal(r.status, r.code, r.error));
    };

    const url = new URL(req.url ?? '', 'http://localhost');
    const opened = await authenticateCliUpgrade(deps.bearer, req, url);
    if ('error' in opened) {
      recordForwardRefusal({ userId, boxId, port, status: opened.status, code: opened.status === 401 ? 'auth_required' : 'invalid_request' });
      endUpgrade(socket, refusalResponse(opened));
      return;
    }
    const { user } = opened.auth;
    userId = user.id;
    if (opened.auth.credential.kind !== 'device') { refuse(FORWARD_BOX_ONLY); return; }
    if (!offersForward(req)) { refuse(NO_PROTOCOL); return; }
    if (!offersV2(req) && now() >= (deps.v1RefuseAfter ?? FORWARD_V1_REFUSE_AFTER)) { refuse(FORWARD_V1_REFUSED); return; }
    port = parseForwardPort(target.port);
    if (port === null) { refuse(BAD_PORT); return; }
    const denied = await admit(user, boxId);
    if (denied) { refuse(denied); return; }
    const cap = deps.tunnels.cap('port');
    if (deps.tunnels.count(user.id, boxId, 'port') >= cap) {
      refuse({ status: 429, code: 'too_many_tunnels', error: `At most ${cap} forwarded connections to one box` });
      return;
    }
    if (active >= maxConcurrent) {
      refuse({ status: 429, code: 'too_many_tunnels', error: 'This orchestrator is carrying as many forwarded connections as it takes; try again shortly' });
      return;
    }
    const release = reserve();
    if (!hangup.hold(release)) return;

    let box: WebSocket;
    try {
      box = (await deps.tunnels.openSocket(boxId, user.id, { kind: 'port', port })).ws;
    } catch (err) {
      release();
      refuse(tunnelRefusal(err));
      return;
    }
    // The client left while the tunnel opened: nobody to relay for.
    if (!hangup.hold(() => box.terminate())) return;
    if (box.readyState !== WebSocket.OPEN) {
      release();
      refuse({ status: 502, code: 'tunnel_failed', error: 'The box end of the forward closed before it was relayed' });
      return;
    }
    // The client half-closed or failed while the tunnel opened: it can no
    // longer be upgraded. Drop what is held for it and end it now, rather
    // than leave a half-open laptop connection to TCP's timeouts.
    if (socket.destroyed || !socket.readable || !socket.writable) {
      hangup.fire();
      socket.destroy();
      return;
    }
    const forwardPort = port;
    deps.wss.handleUpgrade(req, socket, head, (client) => {
      hangup.disarm();
      socket.off('error', onSocketError);
      relay(client, box, opened, { userId: user.id, boxId, port: forwardPort, startedAt: started }, release);
    });
  }

  function relay(
    client: WebSocket,
    box: WebSocket,
    opened: { auth: CliAuth; raw: string },
    meta: { userId: string; boxId: string; port: number; startedAt: number },
    release: () => void,
  ): void {
    const openedAt = now();
    recordForwardOpen({ userId: meta.userId, boxId: meta.boxId, port: meta.port, setupMs: openedAt - meta.startedAt, protocol: client.protocol === FORWARD_SUBPROTOCOL_V2 ? 'v2' : 'v1' });
    let bytesIn = 0;
    let bytesOut = 0;
    // Laptop to box: on v2 only what the relay passes on (not the token frames it takes).
    if (client.protocol !== FORWARD_SUBPROTOCOL_V2) client.on('message', (d) => { bytesIn += messageBytes(d); });
    box.on('message', (d) => { bytesOut += messageBytes(d); });
    deps.heartbeat?.(client);
    const recheckMs = deps.recheckMs ?? CLI_WS_RECHECK_MS;
    if (client.protocol === FORWARD_SUBPROTOCOL_V2) {
      // The CLI sockets' recheck on whichever token was renewed last, less
      // `exp`, which keepTokenFresh judges so that a leg the relay holds
      // paused isn't cut with its renewal unread; a lapse (a retired key)
      // closes with 4402 too. Text frames other than a fin are this
      // process's, never the box's.
      const fresh = keepTokenFresh(client, deps.bearer, opened, recheckMs);
      watchCliSocket(client, deps.bearer, opened, recheckMs, { reauthCloseCode: FORWARD_TOKEN_CLOSE_CODE, ignoreAccessTokenExpiry: true });
      relayMessages(client, box, RELAY_HIGH_WATER_BYTES, RELAY_LOW_WATER_BYTES, (data, isBinary) => {
        if (isBinary || frameText(data) === FIN) { bytesIn += messageBytes(data); return true; }
        fresh.control(data);
        return false;
      });
    } else {
      // v1: the CLI sockets' recheck, less the access token's `exp`: a
      // forwarded TCP stream can't redial, so it would end within the token's
      // hour. A retired signing key (4401) or a revoked or expired sign-in
      // (1008) still closes it, and FORWARD_MAX_LIFETIME_MS bounds it (4408).
      watchCliSocket(client, deps.bearer, opened, recheckMs, { ignoreAccessTokenExpiry: true });
      relayMessages(client, box);
    }
    relayMessages(box, client);
    // Paused since its dial-back was accepted (AgentTunnels.accept), so a
    // server that speaks first loses nothing to a relay not yet listening.
    box.resume();

    // The lifetime cap: both legs close, and their 'close' frees the slots.
    // v1's is shorter: it skips the token's `exp`.
    const v1 = client.protocol !== FORWARD_SUBPROTOCOL_V2;
    const lifetime = setTimeout(() => {
      closeSafely(client, FORWARD_LIFETIME_CLOSE_CODE, v1 ? FORWARD_V1_LIFETIME_CLOSE_REASON : FORWARD_LIFETIME_CLOSE_REASON);
      closeSafely(box, 1011, 'forward lifetime reached');
    }, v1 ? deps.v1MaxLifetimeMs ?? FORWARD_V1_MAX_LIFETIME_MS : deps.maxLifetimeMs ?? FORWARD_MAX_LIFETIME_MS);
    lifetime.unref?.();

    let clientCode: number | null = null;
    let legsOpen = 2;
    let recorded = false;
    const record = (code: number) => {
      if (recorded) return;
      recorded = true;
      relayed.delete(shutdown);
      recordForwardClose({
        userId: meta.userId, boxId: meta.boxId, port: meta.port, setupMs: openedAt - meta.startedAt,
        protocol: client.protocol === FORWARD_SUBPROTOCOL_V2 ? 'v2' : 'v1', bytesIn, bytesOut, durationMs: now() - openedAt, code,
      });
    };
    const shutdown = (code: number, reason: string) => {
      // A client that already closed keeps its own code; only the box leg was still open.
      record(clientCode ?? code);
      closeSafely(client, code, reason);
      closeSafely(box, 1001, reason);
    };
    relayed.add(shutdown);
    const legClosed = () => {
      if (--legsOpen > 0) return;
      clearTimeout(lifetime);
      release();
      record(clientCode ?? 1006);
    };
    // A box end that failed or dropped leaves the client to the parked check
    // below, bounded: if nothing has closed the client in time ('close' never
    // came, or the check hangs), both legs are terminated.
    let dropTimer: NodeJS.Timeout | null = null;
    const boundDrop = () => {
      if (dropTimer) return;
      dropTimer = setTimeout(() => { client.terminate(); box.terminate(); }, deps.boxDropGraceMs ?? FORWARD_BOX_DROP_GRACE_MS);
      dropTimer.unref?.();
    };
    client.on('close', (code) => {
      if (dropTimer) clearTimeout(dropTimer);
      clientCode = code;
      // The CLI ends with 1000 once both fins have passed; anything else is a reset to the box.
      closeSafely(box, code === 1000 ? 1000 : 1011, '');
      legClosed();
    });
    box.on('close', (code) => {
      legClosed();
      if (code === 1000 || code === 1011) { closeSafely(client, code, ''); return; }
      // The box end dropped: a box that parked says so with 4409.
      boundDrop();
      deps.boxes.parked(meta.boxId).then(
        (parked) => closeSafely(client, parked ? FORWARD_PARKED_CLOSE_CODE : 1011, parked ? 'box parked' : 'the box end of the forward closed'),
        () => closeSafely(client, 1011, 'the box end of the forward closed'),
      );
    });
    client.on('error', () => box.terminate());
    // 'close' follows and classifies it: terminating the client here would
    // hand it 1006 before the parked check could say 4409 (Devin on #724).
    box.on('error', boundDrop);
  }

  function router(): Router {
    const r = Router({ mergeParams: true });
    const bearer = cliBearer(deps.bearer);
    r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.get('/', bearer, asyncHandler(async (req, res) => {
      const auth = res.locals.cliAuth as CliAuth;
      const boxId = (req.params as { id: string }).id;
      const answer = (x: { status: number; code: string; error: string }) => {
        recordForwardRefusal({ userId: auth.user.id, boxId, port: null, status: x.status, code: x.code, probe: true });
        res.status(x.status).json({ error: x.error, code: x.code });
      };
      if (auth.credential.kind !== 'device') { answer(FORWARD_BOX_ONLY); return; }
      const denied = await admit(auth.user, boxId);
      if (denied) { answer(denied); return; }
      res.json({ ok: true, capability: PORT_FORWARD_CAPABILITY, maxConnections: deps.tunnels.cap('port') });
    }));
    // A plain GET of the socket's path.
    r.get('/:port', (_req, res) => {
      res.status(426).set('Upgrade', 'websocket').json({ error: `This is a WebSocket; upgrade with Sec-WebSocket-Protocol ${FORWARD_SUBPROTOCOL_V2}`, code: 'upgrade_required' });
    });
    return r;
  }

  return {
    upgrade, router, active: () => active,
    closeAll: (code, reason) => { for (const shutdown of [...relayed]) shutdown(code, reason); },
  };
}
