/**
 * A test harness for relays over AgentTunnels (services/agentTunnels.ts):
 * the orchestrator's dial-back endpoint, a box agent that answers
 * `tunnel-open` as agent/port-tunnel.js does for a `port` or `preview`
 * target (connect to 127.0.0.1:<port>, dial back, binary frames both ways in
 * t3's framing), and loopback apps to relay to. No database, no registry: the
 * agent's RPC is AgentTunnels' `send`.
 *
 * Ported from #167's tunnelTestHarness (with credit to its author), from its
 * multiplexed agent tunnel onto AgentTunnels' dial-backs, for the preview
 * relay's integration tests.
 */
import http from 'http';
import net, { type AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentTunnelDeps, AgentTunnels } from './agentTunnels';

/** Tracks servers and sockets to close in afterAll. */
export function makeClosers() {
  const fns: Array<() => void> = [];
  return { add: (fn: () => void) => fns.push(fn), closeAll: () => fns.splice(0).forEach(fn => fn()) };
}
export type Closers = ReturnType<typeof makeClosers>;

function listen(server: http.Server | net.Server, closers: Closers): Promise<number> {
  closers.add(() => {
    (server as http.Server).closeAllConnections?.();
    server.close();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

/** Where an agent's dial-back lands, as index.ts hands it to the registry, for box `boxId`. The base ws:// URL. */
export async function dialBackEndpoint(tunnels: AgentTunnels, closers: Closers, boxId = 'box-1'): Promise<string> {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
    wss.handleUpgrade(req, socket, head, ws => { if (!tunnels.accept(id, boxId, ws)) ws.close(1008, 'unknown tunnel'); });
  });
  const port = await listen(server, closers);
  return `ws://127.0.0.1:${port}`;
}

export interface FakeBoxAgent {
  send: AgentTunnelDeps['send'];
  /** Every tunnel-open the agent was sent: its target. */
  opened: unknown[];
  /** Tunnels open on the box now. */
  live(): number;
}

/**
 * A box agent answering `tunnel-open` for `port` and `preview` targets: the
 * connect, then the dial-back to `base()`, piped both ways. `refuse` answers a
 * target with an agent refusal instead (the guard's port_refused, say).
 */
export function fakeBoxAgent(base: () => string, opts: { refuse?: (target: any) => { code: string; reason: string } | null } = {}): FakeBoxAgent {
  const opened: unknown[] = [];
  let live = 0;
  const send: AgentTunnelDeps['send'] = async (_boxId, type, payload) => {
    if (type !== 'tunnel-open') throw new Error(`unexpected RPC ${type}`);
    const target = payload.target as { kind?: string; port?: number };
    opened.push(target);
    const refusal = opts.refuse?.(target);
    if (refusal) return { ok: false, ...refusal };
    const sock = await new Promise<net.Socket | null>(resolve => {
      const s = net.connect({ host: '127.0.0.1', port: target.port! });
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (!sock) return { ok: false, code: 'port_closed', reason: `nothing accepts connections on port ${target.port}` };
    const ws = new WebSocket(`${base()}/termag/ws/agent-tunnel?id=${payload.tunnelId}`, { perMessageDeflate: false });
    live++;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      live--;
      sock.destroy();
      try { ws.close(1000); } catch { /* closing */ }
    };
    sock.on('data', chunk => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true });
      // As the agent's pipe: a slow orchestrator pauses the local socket.
      if (ws.bufferedAmount > 1024 * 1024) {
        sock.pause();
        const t = setInterval(() => { if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 256 * 1024) { clearInterval(t); sock.resume(); } }, 10);
      }
    });
    ws.on('message', data => {
      if (!sock.write(data as Buffer)) { ws.pause(); sock.once('drain', () => ws.resume()); }
    });
    sock.on('end', end);
    sock.on('close', end);
    sock.on('error', end);
    ws.on('close', end);
    ws.on('error', end);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ok: true, port: target.port, dialHost: '127.0.0.1' };
  };
  return { send, opened, live: () => live };
}

/** An HTTP app answering any request with `totalBytes` of output, for flow tests. */
export function startFloodSource(closers: Closers, totalBytes = 16 << 20): Promise<number> {
  const app = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(totalBytes) });
    const chunk = Buffer.alloc(64 << 10, 0x7f);
    let written = 0;
    const pump = () => {
      while (written < totalBytes) {
        const n = Math.min(chunk.length, totalBytes - written);
        written += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  });
  return listen(app, closers);
}

/** An HTTP app that reflects what it received, for asserting what a relay sends. Counts the connections it was given. */
export async function startHttpEcho(closers: Closers): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const app = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  app.on('connection', () => { connections++; });
  return { port: await listen(app, closers), connections: () => connections };
}

/** A WebSocket app that echoes "echo:<msg>:<url>". */
export function startWsEcho(closers: Closers): Promise<number> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => ws.on('message', m => ws.send(`echo:${m}:${req.url}`)));
  return listen(server, closers);
}
