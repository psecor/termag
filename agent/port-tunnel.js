'use strict';
/**
 * The port forward's box side (`termag forward <box> <port>`; the
 * native-forward contract, sections 3 to 5): `tunnel-open` with
 * `{ tunnelId, target: { kind: 'port', port } }` checks the port
 * (port-guard.js), connects to it on loopback, then dials the orchestrator
 * back (tunnel-dial.js) and carries the CLI's TCP stream, half-close
 * included.
 *
 * The answer, as t3's: `{ ok: true, port, dialHost }` once the dial-back is
 * open, or `{ ok: false, code, reason }` with code
 *   port_refused   the guard refused the port (reason says why)
 *   port_closed    nothing listens, or the connect was refused
 *   tunnel_failed  the connect failed some other way (timed out, say)
 * and nothing dialed back. A malformed request, or a dial-back the
 * orchestrator refuses, is an RPC error.
 *
 * Inert until the orchestrator sends a `port` target, which it does only for
 * a box advertising `port-forward-v1`, behind its box-port-forward-enabled flag.
 */
const net = require('net');
const portGuard = require('./port-guard');
const { TUNNEL_ID_RE, TUNNEL_STALL_MS, TUNNEL_PING_MS, TUNNEL_CLOSE_TIMEOUT_MS, dialBack, pipeStream } = require('./tunnel-dial');

const CAPABILITIES = ['port-forward-v1'];

/**
 * What hello advertises for the forward: port-forward-v1 only where the guard
 * can work (portGuard.canCheckPorts). Elsewhere the orchestrator answers
 * box_outdated, and the CLI suggests `termag ssh -L`.
 */
function capabilities({ canCheckPorts = portGuard.canCheckPorts } = {}) {
  return canCheckPorts() ? CAPABILITIES : [];
}
const CONNECT_TIMEOUT_MS = 10_000;
// Frames are at most 64 KiB; a fin is a few bytes. Anything bigger is not the CLI.
const MAX_PAYLOAD = 1024 * 1024;

/**
 * A tunnel-open target: `{ kind: 't3' }` for the desktop bridge's `'t3'`,
 * `{ kind: 'port', port }` for a forward, null for any other shape.
 */
function tunnelTarget(target) {
  if (target === 't3') return { kind: 't3' };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (target.kind !== 'port') return null;
  const { port } = target;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: 'port', port };
}

/** Connect to host:port, half-open allowed: the socket, or the error (with `.code`, `ETIMEDOUT` for our own timeout). */
function connectLocal(host, port, { netImpl = net, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = netImpl.connect({ host, port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    // The error listener stays until the pipe adds its own: an error in
    // between rejects nothing, and isn't left unhandled.
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * deps:
 *   termagUrl, token, WebSocket   as t3's bridge: the agent's /ws/agent URL,
 *                                 its bearer, the ws library's WebSocket
 *   checkPort, clearPortCache     port-guard.js's, injectable for tests
 *   netImpl, now, log, connectTimeoutMs, stallMs, pingMs, closeTimeoutMs
 */
function createPortTunnels(deps) {
  const {
    termagUrl, token, WebSocket,
    checkPort = portGuard.checkPort, clearPortCache = portGuard.clearPortCache,
    netImpl = net, now = () => Date.now(), log = () => {},
    connectTimeoutMs = CONNECT_TIMEOUT_MS, stallMs = TUNNEL_STALL_MS, pingMs = TUNNEL_PING_MS, closeTimeoutMs = TUNNEL_CLOSE_TIMEOUT_MS,
  } = deps;
  const tunnels = new Set();

  const refused = (port, code, reason) => {
    log(`[FORWARD] refused port=${port} code=${code} reason=${reason}`);
    return { ok: false, code, reason };
  };

  async function openTunnel({ tunnelId, port } = {}) {
    if (typeof tunnelId !== 'string' || !TUNNEL_ID_RE.test(tunnelId)) throw new Error('bad tunnel id');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
    const verdict = await checkPort(port);
    if (!verdict.ok) return refused(port, verdict.code, verdict.reason);
    let sock;
    try {
      sock = await connectLocal(verdict.dialHost, port, { netImpl, timeoutMs: connectTimeoutMs });
    } catch (err) {
      // What the guard saw is gone (the server stopped, or changed hands):
      // the next tunnel looks again.
      clearPortCache(port);
      const code = err && err.code;
      if (code === 'ECONNREFUSED') return refused(port, 'port_closed', `nothing accepts connections on port ${port}`);
      return refused(port, 'tunnel_failed', `connecting to port ${port} failed (${code || 'error'})`);
    }
    const { ws, opened } = dialBack({ WebSocket, termagUrl, token, tunnelId, closeTimeoutMs, maxPayload: MAX_PAYLOAD });
    let isOpen = false;
    const end = pipeStream(ws, sock, {
      WebSocket, tunnels, now, log, stallMs, pingMs, closeTimeoutMs,
      onClose: ({ code, bytesIn, bytesOut, durationMs }) => {
        if (isOpen) log(`[FORWARD] close port=${port} bytesIn=${bytesIn} bytesOut=${bytesOut} durationMs=${durationMs} code=${code}`);
      },
    });
    try {
      await opened;
    } catch (err) {
      end();
      log(`[FORWARD] dial-back failed port=${port}: ${err.message}`);
      throw err;
    }
    isOpen = true;
    log(`[FORWARD] open port=${port} dialHost=${verdict.dialHost}`);
    return { ok: true, port, dialHost: verdict.dialHost };
  }

  return { openTunnel, openTunnels: () => tunnels.size };
}

/**
 * The `tunnel-open` RPC, routed by target: t3's form goes to the desktop
 * bridge exactly as before (an error where the box has no t3 command), a
 * `port` target to the forward, which needs no t3 at all. Any other shape
 * is an error, thrown for the RPC to answer.
 */
async function openTunnelRpc(msg, { t3, portTunnels }) {
  const target = tunnelTarget(msg && msg.target);
  if (!target) throw new Error('unknown tunnel target');
  if (target.kind === 't3') {
    if (!t3) throw new Error('No t3 command on this box');
    return t3.openTunnel({ tunnelId: msg.tunnelId, target: msg.target });
  }
  return portTunnels.openTunnel({ tunnelId: msg.tunnelId, port: target.port });
}

module.exports = { CAPABILITIES, capabilities, MAX_PAYLOAD, tunnelTarget, connectLocal, createPortTunnels, openTunnelRpc };
