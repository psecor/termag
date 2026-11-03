import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { CLOSE } from './refusals.js';

/** Contract section 4: pause the local socket above this much unsent, resume at LOW_WATER or less. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;
/** The largest binary frame either end sends. */
export const MAX_FRAME = 64 * 1024;
/**
 * A burst's first frames grow from FIRST_FRAME, doubling up to MAX_FRAME. The
 * far end's ws hands over only whole frames, and a fresh TCP
 * connection's first round trip carries about 14 KB: a 64 KiB first frame
 * would wait an extra round trip of the laptop's link. A pause of
 * FRAME_RAMP_IDLE_MS (Linux's minimum RTO, past which an idle connection's
 * window shrinks again) starts a new burst. The agent does the same (tunnel-dial.js).
 */
export const FIRST_FRAME = 4 * 1024;
export const FRAME_RAMP_IDLE_MS = 200;
/** "My TCP peer half-closed its write side." */
export const FIN = '{"t":"fin"}';
/**
 * How often an open connection pings the orchestrator. The orchestrator's
 * heartbeat (agentTunnels.ts tunnelHeartbeat, every 25 s) needs to hear from
 * this end, and can't count on our pong: we stop reading while a slow local
 * reader catches up, and on a slow link its ping waits behind megabytes of
 * download. A ping of ours travels the other way, so it isn't held up.
 */
export const PING_MS = 10_000;

export interface PipeResult {
  /** The WebSocket's close code (1006 when it dropped without one). */
  code: number;
  bytesUp: number;
  bytesDown: number;
  /** Which end went first: the local peer (a reset, say) or the box and orchestrator. */
  closedBy: 'local' | 'remote';
  /**
   * Closed before a byte moved either way, and `keepIfUntouched` said so: the
   * local socket is left open and paused for another dial.
   */
  untouched: boolean;
}

export interface Pipe {
  done: Promise<PipeResult>;
  /** Ctrl-C: close with 1000, and drop whatever is left after `graceMs`. */
  stop: (graceMs: number) => void;
}

/**
 * Relays one accepted TCP connection over an open forward socket, both ways,
 * until both are closed. Both must be paused, and the local socket created
 * with `allowHalfOpen: true`; the pipe resumes them.
 *
 * - Socket to WebSocket: binary frames of at most 64 KiB (from 4 KiB, doubling,
 *   after a pause of FRAME_RAMP_IDLE_MS); the socket pauses
 *   while `bufferedAmount` is over 1 MiB and resumes from a send callback once
 *   it is 256 KiB or less.
 * - WebSocket to socket: `ws.pause()` while `write()` returns false, resumed
 *   on `drain`.
 * - Half-close: the local peer's FIN goes over as `{"t":"fin"}`, and the box's
 *   `{"t":"fin"}` ends the local socket's write side. Once both have passed
 *   and the socket has flushed, this end closes with 1000.
 * - Any other close resets the local socket; a local error closes with 1011.
 * - A ping to the orchestrator every `pingMs` (PING_MS) while it is open.
 */
export function pipe(
  socket: Socket,
  ws: WebSocket,
  opts: { keepIfUntouched?: (code: number) => boolean; onBytes?: (up: number, down: number) => void; pingMs?: number; now?: () => number } = {},
): Pipe {
  const now = opts.now ?? Date.now;
  let bytesUp = 0;
  let bytesDown = 0;
  let sentFin = false;
  let gotFin = false;
  let upPaused = false;
  let wsClosed: number | null = null;
  let socketClosed = socket.destroyed;
  let untouched = false;
  let closedBy: 'local' | 'remote' | null = null;
  let frameNext = FIRST_FRAME;
  let lastDataAt = -Infinity;
  let resolveDone!: (r: PipeResult) => void;
  const done = new Promise<PipeResult>(resolve => { resolveDone = resolve; });

  const settle = () => {
    if (wsClosed === null || (!socketClosed && !untouched)) return;
    detach();
    resolveDone({ code: wsClosed, bytesUp, bytesDown, untouched, closedBy: closedBy ?? 'remote' });
  };

  const closeWs = (code: number) => {
    // A WebSocket paused for a slow local reader would never read the other end's close frame,
    // and both ends would wait out ws's 30 s close timeout.
    if (ws.readyState === WebSocket.OPEN) { ws.resume(); ws.close(code); }
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };

  const finishIfDone = () => {
    if (sentFin && gotFin && socket.writableFinished) closeWs(CLOSE.NORMAL);
  };

  const afterSend = (err?: Error) => {
    if (err || !upPaused || ws.bufferedAmount > LOW_WATER) return;
    upPaused = false;
    socket.resume();
  };

  const onData = (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) {
      // Closing before a byte went over: hand the chunk back, for a redial to send.
      if (bytesUp === 0) { socket.pause(); socket.unshift(chunk); }
      return;
    }
    const t = now();
    if (t - lastDataAt >= FRAME_RAMP_IDLE_MS) frameNext = FIRST_FRAME;
    lastDataAt = t;
    for (let i = 0; i < chunk.length; i += frameNext, frameNext = Math.min(frameNext * 2, MAX_FRAME)) {
      ws.send(chunk.subarray(i, i + frameNext), { binary: true }, afterSend);
    }
    bytesUp += chunk.length;
    opts.onBytes?.(chunk.length, 0);
    if (!upPaused && ws.bufferedAmount > HIGH_WATER) {
      upPaused = true;
      socket.pause();
    }
  };
  const onEnd = () => {
    sentFin = true;
    if (ws.readyState === WebSocket.OPEN) ws.send(FIN);
    finishIfDone();
  };
  const onDrain = () => ws.resume();
  const onSocketError = () => { /* 'close' follows */ };
  const onSocketClose = () => {
    socketClosed = true;
    closedBy ??= wsClosed === null ? 'local' : 'remote';
    closeWs(sentFin && gotFin ? CLOSE.NORMAL : CLOSE.ERROR);
    settle();
  };

  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      if (data.toString() === FIN && !gotFin) {
        gotFin = true;
        socket.end();
      }
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    // Gone or done locally: drop it, and never pause again for a socket that won't drain.
    if (socket.writableEnded || socket.destroyed) return;
    bytesDown += buf.length;
    opts.onBytes?.(0, buf.length);
    if (!socket.write(buf)) ws.pause();
  };
  const onWsError = () => { /* 'close' follows */ };
  const onWsClose = (code: number) => {
    wsClosed = code;
    closedBy ??= 'remote';
    if (bytesUp === 0 && bytesDown === 0 && !sentFin && !gotFin && !socketClosed && opts.keepIfUntouched?.(code)) {
      untouched = true;
      socket.pause();
    } else if (!socketClosed) {
      if (code === CLOSE.NORMAL) {
        // Both directions are done (or this end stopped): flush what is left, then let go.
        socket.end();
        if (socket.writableFinished) socket.destroy(); else socket.once('finish', () => socket.destroy());
      } else if (typeof socket.resetAndDestroy === 'function') {
        socket.resetAndDestroy();
      } else {
        socket.destroy();
      }
    }
    settle();
  };

  // Sends go out while reading is paused, so this is heard however far behind the download is.
  const pinger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, opts.pingMs ?? PING_MS);
  pinger.unref?.();

  function detach() {
    clearInterval(pinger);
    socket.off('data', onData).off('end', onEnd).off('drain', onDrain).off('finish', finishIfDone).off('close', onSocketClose);
    ws.off('message', onMessage).off('close', onWsClose);
    // Late errors from either side have nowhere to go.
    socket.on('error', onSocketError);
    ws.on('error', onWsError);
  }

  socket.on('data', onData).on('end', onEnd).on('drain', onDrain).on('finish', finishIfDone)
    .on('error', onSocketError).on('close', onSocketClose);
  ws.on('message', onMessage).on('error', onWsError).on('close', onWsClose);
  ws.resume();
  if (socketClosed) onSocketClose();
  // Unless the close came first and the socket is already handed back, paused, for a redial.
  else if (!untouched && wsClosed === null) socket.resume();

  const stop = (graceMs: number) => {
    closeWs(CLOSE.NORMAL);
    const timer = setTimeout(() => {
      if (wsClosed === null) ws.terminate();
      if (!socket.destroyed) socket.destroy();
    }, graceMs);
    void done.then(() => clearTimeout(timer));
  };
  return { done, stop };
}
