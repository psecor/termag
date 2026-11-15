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
 * a box advertising `port-forward-v1`.
 *
 * A preview link's relay sends
 * `{ kind: 'preview', port, confine }`, only to a box advertising
 * `preview-link-v1`: the same path through port-guard's checkPreviewPort,
 * which also refuses a debugger, shell or notebook (SR6), then a plain byte
 * pipe in t3's framing, since the orchestrator speaks HTTP and WebSocket over
 * it as a stream. With `confine` set (a `people` or `link` audience) every
 * process holding the port's listening sockets must descend from a
 * `termag preview run` of that checkout (agent/preview-runs.js,
 * listenerConfined), checked before the guard on every tunnel-open; an agent
 * without the launcher refuses every confined target, the safe direction.
 */
const fs = require('fs');
const net = require('net');
const portGuard = require('./port-guard');
const { dockerBindings: defaultDockerBindings } = require('./local-listeners');
const DOCKER_SOCKET = '/var/run/docker.sock';
// A Docker publish bound to one of these takes a dial to the port on loopback: the wildcards, and loopback itself.
const LOOPBACK_TAKERS = ['', '0.0.0.0', '::', '127.0.0.1', '::1'];
const { TUNNEL_ID_RE, TUNNEL_STALL_MS, TUNNEL_PING_MS, TUNNEL_CLOSE_TIMEOUT_MS, dialBack, pipe, pipeStream } = require('./tunnel-dial');

const CAPABILITIES = ['port-forward-v1'];
/** The `preview` target and the `preview-listeners` RPC. */
const PREVIEW_CAPABILITY = 'preview-link-v1';
/** A confined target's refusal when no `termag preview run` of the checkout vouches for the listener. */
const CONFINE_REASON = 'Start this app with `termag preview run` to share it more widely';

/**
 * What hello advertises for the forward and preview links: port-forward-v1
 * and preview-link-v1 only where the guard can work (portGuard.canCheckPorts).
 * Elsewhere the orchestrator answers box_outdated, and the CLI suggests
 * `termag ssh -L`.
 */
function capabilities({ canCheckPorts = portGuard.canCheckPorts } = {}) {
  return canCheckPorts() ? [...CAPABILITIES, PREVIEW_CAPABILITY] : [];
}
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * How long a confined open may take, from the request to the end of the post-connect check, waiting for a slow app
 * to accept included: the orchestrator holds the tunnel's id for TUNNEL_TTL_MS, 15 s (backend
 * services/agentTunnels.ts), and the dial back must reach it in that time, so this leaves it 5 s (Bugbot, #1667).
 */
const ACCEPT_BUDGET_MS = 10_000;
// Frames are at most 64 KiB; a fin is a few bytes. Anything bigger is not the CLI.
const MAX_PAYLOAD = 1024 * 1024;

/**
 * A tunnel-open target: `{ kind: 't3' }` for the desktop bridge's `'t3'`,
 * `{ kind: 'port', port }` for a forward, `{ kind: 'preview', port, confine }`
 * for a preview link (confine null, or `{ checkout }` an absolute path), null
 * for any other shape.
 */
function tunnelTarget(target) {
  if (target === 't3') return { kind: 't3' };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (target.kind !== 'port' && target.kind !== 'preview') return null;
  const { port } = target;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (target.kind === 'port') return { kind: 'port', port };
  const { confine } = target;
  if (confine === null || confine === undefined) return { kind: 'preview', port, confine: null };
  if (typeof confine !== 'object' || Array.isArray(confine) || typeof confine.checkout !== 'string' || !confine.checkout.startsWith('/')) return null;
  return { kind: 'preview', port, confine: { checkout: confine.checkout } };
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
 *   checkPreviewPort              port-guard.js's, for preview targets
 *   netImpl, now, log, connectTimeoutMs, stallMs, pingMs, closeTimeoutMs
 */
function createPortTunnels(deps) {
  const {
    termagUrl, token, WebSocket,
    checkPort = portGuard.checkPort, clearPortCache = portGuard.clearPortCache, checkPreviewPort = portGuard.checkPreviewPort,
    netImpl = net, now = () => Date.now(), log = () => {},
    // (port, checkout) -> { ok } | { ok: false, reason }: PreviewRuns#listenerConfined. Absent: nothing is confined.
    listenerConfined = () => ({ ok: false, reason: 'this box has no termag preview run' }),
    // ({ host, port, peerHost, peerPort }, checkout, { waitMs }) -> { ok } | { ok: false, slow?, reason }:
    // PreviewRuns#acceptedConfined, after the dial: the relay's own connection, as the accepting side sees it.
    acceptedConfined = async () => ({ ok: false, reason: 'this box has no termag preview run' }),
    // port -> Docker's publishes of it ([] for none, as on a box without Docker), or null when a Docker that's
    // there can't be asked.
    dockerBindings = (p) => (fs.existsSync(DOCKER_SOCKET) ? defaultDockerBindings(p).catch(() => null) : Promise.resolve([])),
    connectTimeoutMs = CONNECT_TIMEOUT_MS, stallMs = TUNNEL_STALL_MS, pingMs = TUNNEL_PING_MS, closeTimeoutMs = TUNNEL_CLOSE_TIMEOUT_MS,
  } = deps;
  // Forwards: the host sample's `port` count, which the idle sweep reads as busy.
  const tunnels = new Set();
  // Preview tunnels, apart: an open preview is no person at the box, so it never counts as busy.
  const previewTunnels = new Set();

  const refused = (port, code, reason, label = 'FORWARD') => {
    log(`[${label}] refused port=${port} code=${code} reason=${reason}`);
    return { ok: false, code, reason };
  };

  /** Connect to a checked port: the socket, or the refusal to answer (the guard's verdict cleared for the next look). */
  async function connectChecked(port, dialHost, label) {
    try {
      return { sock: await connectLocal(dialHost, port, { netImpl, timeoutMs: connectTimeoutMs }) };
    } catch (err) {
      // What the guard saw is gone (the server stopped, or changed hands):
      // the next tunnel looks again.
      clearPortCache(port);
      const code = err && err.code;
      if (code === 'ECONNREFUSED') return { refusal: refused(port, 'port_closed', `nothing accepts connections on port ${port}`, label) };
      return { refusal: refused(port, 'tunnel_failed', `connecting to port ${port} failed (${code || 'error'})`, label) };
    }
  }

  async function openTunnel({ tunnelId, port } = {}) {
    if (typeof tunnelId !== 'string' || !TUNNEL_ID_RE.test(tunnelId)) throw new Error('bad tunnel id');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
    const verdict = await checkPort(port);
    if (!verdict.ok) return refused(port, verdict.code, verdict.reason);
    const connected = await connectChecked(port, verdict.dialHost, 'FORWARD');
    if (connected.refusal) return connected.refusal;
    const { sock } = connected;
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

  /**
   * A preview link's tunnel: the preview guard (SR6 included), connect, dial
   * back, then bytes both ways in t3's framing until either side ends. The
   * answer is openTunnel's.
   */
  async function openPreviewTunnel({ tunnelId, port, confine } = {}) {
    const openedAt = now();
    if (typeof tunnelId !== 'string' || !TUNNEL_ID_RE.test(tunnelId)) throw new Error('bad tunnel id');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
    // A people or link audience: only a listener the agent started confined to the link's checkout (SR9).
    if (confine) {
      // Docker first, on every confined open: with userland-proxy off a publish binds no host port, so a confined app
      // can listen on the same one, and Docker's DNAT takes the relay's loopback dial to it (#1520). A publish
      // the loopback dial could reach (a wildcard or loopback bind) refuses the port, whatever listens; one on
      // another address alone doesn't. A Docker that's there but can't be asked refuses it too (Devin, #1520).
      const published = await dockerBindings(port);
      if (!Array.isArray(published)) {
        return refused(port, 'port_refused', `${CONFINE_REASON} (Docker can't be asked whether it publishes port ${port})`, 'PREVIEW');
      }
      if (published.some((b) => LOOPBACK_TAKERS.includes(b.ip))) {
        return refused(port, 'port_refused', `${CONFINE_REASON} (Docker publishes port ${port}, where the relay's loopback dial could reach the container)`, 'PREVIEW');
      }
      const c = listenerConfined(port, confine.checkout);
      // Nothing listening yet (an app still binding) is the closed port it is, not a refusal (Bugbot, #1520): a
      // listener that comes up is judged at the next open.
      if (!c.ok && c.closed) return refused(port, 'port_closed', `nothing listens on port ${port}`, 'PREVIEW');
      if (!c.ok) return refused(port, 'port_refused', `${CONFINE_REASON} (${c.reason})`, 'PREVIEW');
    }
    const verdict = await checkPreviewPort(port);
    if (!verdict.ok) return refused(port, verdict.code, verdict.reason, 'PREVIEW');
    const connected = await connectChecked(port, verdict.dialHost, 'PREVIEW');
    if (connected.refusal) return connected.refusal;
    // Who took the dial, not only who listened before it: closes the gap between the check and the connect (#1520).
    if (confine) {
      const { sock } = connected;
      // What's left of the open's budget: the orchestrator drops the pending id after its 15 s TTL, and the dial back
      // comes after this check, so the probe and connect before it count too (Bugbot, #1667).
      const waitMs = Math.max(0, ACCEPT_BUDGET_MS - (now() - openedAt));
      const a = await acceptedConfined({ host: sock.remoteAddress, port, peerHost: sock.localAddress, peerPort: sock.localPort }, confine.checkout, { waitMs });
      if (!a.ok) {
        connected.sock.destroy();
        // Too slow to accept isn't unconfined: the run was vouched for; say what happened, not "start it confined".
        if (a.slow) return refused(port, 'tunnel_failed', a.reason, 'PREVIEW');
        return refused(port, 'port_refused', `${CONFINE_REASON} (${a.reason})`, 'PREVIEW');
      }
    }
    const { ws, opened } = dialBack({ WebSocket, termagUrl, token, tunnelId, closeTimeoutMs });
    const end = pipe(ws, connected.sock, { WebSocket, tunnels: previewTunnels, now, log, label: 'PREVIEW', stallMs });
    try {
      await opened;
    } catch (err) {
      end();
      log(`[PREVIEW] dial-back failed port=${port}: ${err.message}`);
      throw err;
    }
    return { ok: true, port, dialHost: verdict.dialHost };
  }

  return { openTunnel, openPreviewTunnel, openTunnels: () => tunnels.size, openPreviewTunnels: () => previewTunnels.size };
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
  if (target.kind === 'preview') return portTunnels.openPreviewTunnel({ tunnelId: msg.tunnelId, port: target.port, confine: target.confine });
  return portTunnels.openTunnel({ tunnelId: msg.tunnelId, port: target.port });
}

module.exports = { CAPABILITIES, PREVIEW_CAPABILITY, CONFINE_REASON, ACCEPT_BUDGET_MS, capabilities, MAX_PAYLOAD, tunnelTarget, connectLocal, createPortTunnels, openTunnelRpc };
