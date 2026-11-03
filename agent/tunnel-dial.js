'use strict';
/**
 * The agent's side of an orchestrator tunnel (and
 * the port forward): having connected a local socket, the agent dials the
 * orchestrator back on /ws/agent-tunnel?id=<tunnelId> with its own token and
 * pipes bytes both ways. The orchestrator relays the dial-back to the client
 * that asked for the tunnel.
 *
 *   tunnelDialUrl  the dial-back URL, from the agent's own /ws/agent URL
 *   dialBack       the dial-back WebSocket, and a promise of its opening
 *   pipe           t3's framing: binary frames both ways, until either side ends
 */

const TUNNEL_ID_RE = /^[0-9a-f]{64}$/;
// A tunnel whose local side has finished closes once the bytes it still queues
// for the orchestrator have gone out. It is given up only when they make no
// progress for this long: a reader that slow is gone, not slow.
const TUNNEL_STALL_MS = 60_000;
const TUNNEL_DRAIN_POLL_MS = 100;
// Once those bytes are out, the dial-back's close handshake waits for the
// orchestrator to read everything ahead of the close frame, which takes as
// long as the client reading it. ws destroys the socket when this runs out
// (its closeTimeout, 30 s by default): a destroyed socket that then receives
// a frame answers with a reset, and a proxy in between may drop what it
// still holds. Ten minutes bounds a dead orchestrator without cutting a slow
// reader.
const TUNNEL_CLOSE_TIMEOUT_MS = 10 * 60_000;
// A port dial-back pings the orchestrator this often, so it can tell this end
// is alive when its own ping can't get an answer: this end stops reading while
// a slow local socket drains, pongs included, and the orchestrator's heartbeat
// (agentTunnels.ts tunnelHeartbeat) ticks every 25 s.
const TUNNEL_PING_MS = 10_000;

/** The orchestrator URL a tunnel dials back on, from the agent's own /ws/agent URL. */
function tunnelDialUrl(termagUrl, tunnelId) {
  const url = new URL(termagUrl);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/ws\/agent\/?$/, '') + '/ws/agent-tunnel';
  url.searchParams.set('id', tunnelId);
  return url.toString();
}

/**
 * The dial-back for `tunnelId`: the box token as bearer, no deflate, a 10 s
 * handshake. `{ ws, opened }`: `opened` resolves on open and rejects when
 * the orchestrator refuses it or it fails. `maxPayload` (bytes) where the
 * tunnel's frames have a bound.
 */
function dialBack({ WebSocket, termagUrl, token, tunnelId, closeTimeoutMs = TUNNEL_CLOSE_TIMEOUT_MS, maxPayload }) {
  const ws = new WebSocket(tunnelDialUrl(termagUrl, tunnelId), {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
    closeTimeout: closeTimeoutMs,
    ...(maxPayload ? { maxPayload } : {}),
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`orchestrator refused the tunnel (${res.statusCode})`)));
    ws.once('error', reject);
  });
  return { ws, opened };
}

/**
 * Bytes both ways until either side ends; a socket that can't keep up pauses
 * the other. When the local side ends first (t3 answered, with Connection:
 * close), the WebSocket closes only once what it still buffers for the
 * orchestrator has been sent: that is the tail of the answer, and a slow
 * client may take many seconds to read it. A fixed 2 s here used to
 * terminate it with the tail unsent.
 *
 * opts: WebSocket (for its OPEN), tunnels (a Set the pipe is in while open),
 * now, log, label (its log lines' tag), stallMs, drainPollMs. Answers `end`,
 * which closes it from this side.
 */
function pipe(ws, sock, { WebSocket, tunnels, now = () => Date.now(), log = () => {}, label = 'T3', stallMs = TUNNEL_STALL_MS, drainPollMs = TUNNEL_DRAIN_POLL_MS }) {
  const entry = { ws, sock };
  tunnels.add(entry);
  let done = false;
  // The WebSocket paused because the local socket's write buffer was full;
  // resumed on its drain, or when the socket is destroyed, which never drains.
  let wsPaused = false;
  const resumeWs = () => {
    if (!wsPaused) return;
    wsPaused = false;
    ws.resume?.();
  };
  const stop = () => {
    if (done) return false;
    done = true;
    tunnels.delete(entry);
    sock.destroy();
    // Keep reading the dial-back, so the orchestrator's close frame is seen.
    resumeWs();
    return true;
  };
  // The orchestrator's side ended, or the dial-back never opened: nothing to keep.
  const end = () => {
    if (!stop()) return;
    try { ws.close(1000); } catch { /* closing */ }
    setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 2000).unref?.();
  };
  // The local side ended: send what is queued, then close.
  const finish = () => {
    if (ws.readyState !== WebSocket.OPEN) { end(); return; }
    if (!stop()) return;
    let left = ws.bufferedAmount;
    let progressAt = now();
    const check = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const queued = ws.bufferedAmount;
      if (queued === 0) { ws.close(1000); return; }
      if (queued < left) { left = queued; progressAt = now(); }
      if (now() - progressAt >= stallMs) {
        log(`[${label}] tunnel gave up: ${queued} bytes unsent for ${Math.round(stallMs / 1000)}s`);
        ws.terminate();
        return;
      }
      setTimeout(check, drainPollMs).unref?.();
    };
    check();
  };
  sock.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > 1024 * 1024) {
      sock.pause();
      const resume = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(resume); return; }
        if (ws.bufferedAmount < 256 * 1024) { clearInterval(resume); sock.resume(); }
      }, 20);
    }
  });
  ws.on('message', (data) => {
    // The local side is gone (t3 answered before the request's body was all
    // in, say): drop the rest. Writing to the destroyed socket would return
    // false and pause the WebSocket for a drain that never comes, and the
    // close handshake would then wait out closeTimeout.
    if (done) return;
    const ok = sock.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (!ok && !wsPaused) { wsPaused = true; ws.pause?.(); sock.once('drain', resumeWs); }
  });
  sock.on('end', finish);
  sock.on('close', finish);
  sock.on('error', finish);
  ws.on('close', end);
  ws.on('error', end);
  return end;
}

// The port forward's framing (native-forward contract, section 4).
const FRAME_MAX = 64 * 1024;
// A burst's first frames grow from FRAME_FIRST, doubling up to FRAME_MAX. The
// receiver's ws hands over only whole frames, and a fresh TCP
// connection's first round trip carries about 14 KB (an initial window of 10
// segments). A 64 KiB first frame then waits an extra round trip on the
// laptop's link before its first byte is seen: 110 ms from a home link. A
// pause of FRAME_RAMP_IDLE_MS (Linux's minimum RTO, past which an idle
// connection's window shrinks again) starts a new burst.
const FRAME_FIRST = 4 * 1024;
const FRAME_RAMP_IDLE_MS = 200;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const FIN = JSON.stringify({ t: 'fin' });

function isFin(text) {
  try {
    const m = JSON.parse(text);
    return !!m && typeof m === 'object' && m.t === 'fin' && Object.keys(m).length === 1;
  } catch { return false; }
}

/**
 * The port forward's framing, end to end with the CLI: TCP bytes as binary
 * frames of at most 64 KiB (from 4 KiB, doubling, at a burst's start), and
 * the text frame {"t":"fin"} for "my peer half-closed its write side", whose
 * receiver ends its socket's. The
 * dial-back closes 1000 once both directions have finished (whichever side
 * closes first: the CLI does, and a 1000 from it then is a normal end), and
 * 1011 on a local reset or error or any other text frame.
 *
 * Backpressure both ways: the local socket is paused while the dial-back
 * buffers more than 1 MiB, and resumed from a send callback once it is down
 * to 256 KiB; the dial-back is paused while the local socket's write()
 * returns false, and resumed on its drain or once the socket is gone (its
 * bytes are then dropped, so the close frame behind them is still read). The
 * local socket is held paused until the dial-back opens, so a server that
 * speaks first (an SSH or database greeting) loses nothing.
 *
 * Once this side's fin is queued, a fin whose bytes ahead of it make no
 * progress for `stallMs` gives the tunnel up. So does a dial-back paused for a
 * local socket that still holds bytes and takes none of them for `stallMs`: a
 * slow reader that moves is never cut, however slow, nor one that has taken
 * everything and is working on its answer. An idle open tunnel (a dev server's HMR socket) is
 * never timed out.
 *
 * The dial-back pings the orchestrator every `pingMs` while it is open, which
 * is how the orchestrator knows this end lives while it reads nothing.
 *
 * opts: WebSocket (for its OPEN), tunnels (a Set the pipe is in while open),
 * now, log, stallMs, pingMs, closeTimeoutMs (how long a finished local socket may
 * take to flush), onClose({ code, bytesIn, bytesOut, durationMs }): bytesIn
 * is what the orchestrator sent, bytesOut what the local socket did. Answers
 * `end`, for a dial-back that never opened.
 */
function pipeStream(ws, sock, { WebSocket, tunnels, now = () => Date.now(), log = () => {}, stallMs = TUNNEL_STALL_MS, pingMs = TUNNEL_PING_MS, closeTimeoutMs = TUNNEL_CLOSE_TIMEOUT_MS, onClose = () => {} }) {
  const entry = { ws, sock };
  tunnels.add(entry);
  const startedAt = now();
  let bytesIn = 0;
  let bytesOut = 0;
  let localDone = false; // the local socket ended: our fin goes once the dial-back is open
  let finSent = false; // ... and written out, with every byte before it
  let remoteDone = false; // a fin came: the local socket's write side is ended
  let sockGone = false;
  let closing = false;
  let closeCode = null;
  let sockPaused = false;
  let wsPaused = false;
  let stallTimer = null;
  // While the dial-back is paused for the local socket: what that socket had
  // taken (bytesIn less what it still buffers), and when that last grew.
  let takenAtPause = 0;
  let takenAt = 0;
  const taken = () => bytesIn - sock.writableLength;
  let pinger = null;
  // After a normal end: destroys a local socket still flushing once
  // closeTimeoutMs runs out. Cleared as soon as the socket closes or is
  // destroyed, so a finished tunnel holds nothing.
  let flushTimer = null;
  const clearFlush = () => { clearTimeout(flushTimer); flushTimer = null; };
  const open = () => ws.readyState === WebSocket.OPEN;

  // A local EOF before the dial-back opens (a server that answers and closes
  // at once) is held, and its fin sent on open; one from before the pipe was
  // attached has had its 'end' already.
  if (sock.readableEnded) localDone = true;
  sock.pause();
  ws.once('open', () => {
    if (localDone) sendFin();
    else if (!sockPaused) sock.resume();
    pinger = setInterval(tick, pingMs);
    pinger.unref?.();
  });
  function tick() {
    if (!open()) return;
    try { ws.ping(); } catch { /* closing */ }
    // Nothing left to write is no stall, however long the service then takes to answer.
    if (!wsPaused || sockGone || sock.writableLength === 0) { takenAtPause = taken(); takenAt = now(); return; }
    const t = taken();
    if (t > takenAtPause) { takenAtPause = t; takenAt = now(); return; }
    if (now() - takenAt >= stallMs) fail(`tunnel gave up: the local socket took nothing for ${Math.round(stallMs / 1000)}s`);
  }

  const resumeWs = () => {
    if (!wsPaused) return;
    wsPaused = false;
    ws.resume?.();
  };
  const destroySock = (reset) => {
    clearFlush();
    if (sockGone) return;
    sockGone = true;
    if (reset && typeof sock.resetAndDestroy === 'function') {
      try { sock.resetAndDestroy(); } catch { sock.destroy(); }
    } else sock.destroy();
    // Keep reading the dial-back, so the orchestrator's close frame is seen.
    resumeWs();
  };
  const close = (code, why) => {
    if (closing) return;
    closing = true;
    closeCode = code;
    clearTimeout(stallTimer);
    clearInterval(pinger);
    if (why) log(`[FORWARD] ${why}`);
    try { ws.close(code); } catch { /* closing */ }
  };
  const fail = (why) => { close(1011, why); destroySock(true); };
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (finSent || closing) return;
      log(`[FORWARD] tunnel gave up: ${ws.bufferedAmount} bytes unsent for ${Math.round(stallMs / 1000)}s`);
      closing = true;
      ws.terminate();
    }, stallMs);
    stallTimer.unref?.();
  };
  // Every frame's send callback: what resumes a paused local socket.
  const sent = (err) => {
    if (err) return; // the dial-back is failing; its close follows
    if (sockPaused && ws.bufferedAmount <= LOW_WATER) {
      sockPaused = false;
      if (!sockGone) sock.resume();
    }
    if (localDone && !finSent) armStall();
  };

  let frameNext = FRAME_FIRST;
  let lastDataAt = -Infinity;
  sock.on('data', (chunk) => {
    if (!open()) return;
    const t = now();
    if (t - lastDataAt >= FRAME_RAMP_IDLE_MS) frameNext = FRAME_FIRST;
    lastDataAt = t;
    for (let i = 0; i < chunk.length; i += frameNext, frameNext = Math.min(frameNext * 2, FRAME_MAX)) {
      const part = chunk.subarray(i, i + frameNext);
      bytesOut += part.length;
      ws.send(part, { binary: true }, sent);
    }
    if (!sockPaused && ws.bufferedAmount > HIGH_WATER) {
      sockPaused = true;
      sock.pause();
    }
  });
  let finQueued = false;
  function sendFin() {
    if (finQueued || !open()) return;
    finQueued = true;
    ws.send(FIN, { binary: false }, (err) => {
      if (err) return;
      finSent = true;
      clearTimeout(stallTimer);
      if (remoteDone) close(1000);
    });
    armStall();
  }
  sock.on('end', () => { localDone = true; sendFin(); });
  sock.on('error', (err) => fail(`local socket error (${err && err.code ? err.code : 'unknown'})`));
  sock.on('close', () => {
    clearFlush();
    const finished = localDone && remoteDone;
    sockGone = true;
    resumeWs();
    if (!finished) fail('local socket closed before both directions finished');
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (remoteDone) { fail('protocol error: bytes after fin'); return; }
      // The local socket is gone: drop the rest, as t3's pipe does.
      if (sockGone) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytesIn += buf.length;
      const ok = sock.write(buf);
      if (!ok && !wsPaused) {
        wsPaused = true;
        takenAtPause = taken();
        takenAt = now();
        ws.pause?.();
        sock.once('drain', resumeWs);
      }
      return;
    }
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    if (remoteDone || !isFin(String(data))) { fail(`protocol error: unexpected text frame (${size} bytes)`); return; }
    remoteDone = true;
    if (!sockGone) sock.end();
    // An ending socket never emits 'drain', and no byte may follow a fin: read on, so the
    // orchestrator's close and pings are heard while the socket flushes.
    resumeWs();
    if (finSent) close(1000);
  });
  ws.on('close', (code) => {
    tunnels.delete(entry);
    clearTimeout(stallTimer);
    clearInterval(pinger);
    const normal = localDone && remoteDone && code === 1000;
    if (closeCode === null) closeCode = code;
    closing = true;
    if (normal) {
      // Both fins passed: the local socket flushes what it holds and closes
      // by itself. Only while it still has bytes (or its FIN) to flush, bound
      // how long a peer that never reads may take.
      if (!sockGone && !sock.writableFinished) {
        flushTimer = setTimeout(() => destroySock(false), closeTimeoutMs);
        flushTimer.unref?.();
      }
    } else {
      destroySock(code !== 1000);
    }
    onClose({ code: closeCode, bytesIn, bytesOut, durationMs: now() - startedAt });
  });
  ws.on('error', () => { /* its close follows */ });

  return () => {
    tunnels.delete(entry);
    destroySock(false);
    try { ws.terminate(); } catch { /* gone */ }
  };
}

module.exports = {
  FRAME_MAX,
  FRAME_FIRST,
  FRAME_RAMP_IDLE_MS,
  HIGH_WATER,
  LOW_WATER,
  pipeStream,
  TUNNEL_ID_RE,
  TUNNEL_STALL_MS,
  TUNNEL_DRAIN_POLL_MS,
  TUNNEL_CLOSE_TIMEOUT_MS,
  TUNNEL_PING_MS,
  tunnelDialUrl,
  dialBack,
  pipe,
};
