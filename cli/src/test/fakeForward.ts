import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FakeOrchestrator } from './fakeOrchestrator.js';

/**
 * The orchestrator's forward surface and the box behind it (contract sections
 * 1, 2 and 4), on the fake orchestrator: the probe, the refusals as plain HTTP
 * answers before any upgrade, and an upgraded socket per connection that
 * stands in for the agent's end of the relay.
 */

/** What the box end does with an upgraded connection. */
export type BoxBehaviour =
  /** Echo binary frames; answer the client's fin with its own once the echo is out. */
  | 'echo'
  /** Send `banner`, then fin at once; record what arrives and close 1000 on the client's fin. */
  | 'speak-then-fin'
  /** Send `total` bytes as fast as the socket's own backpressure lets it. */
  | 'firehose'
  /** Read nothing (ws.pause()), so the client's sends back up. */
  | 'stall';

/** One dial's fate, consumed in order; when none is queued, the port's behaviour. */
export type DialAction =
  | { refuse: { status: number; code: string; error?: string } }
  /** Upgrade, then close at once with this code (as a draining process does). */
  | { closeAfterOpen: number };

export interface ForwardConn {
  port: number;
  ws: WebSocket;
  /** The subprotocol picked: termag-forward.v2 unless `fake.v1Only`. */
  protocol: string;
  /** v2: the access tokens the CLI renewed in band, in order. */
  tokens: string[];
  /** Text frames the box end would have seen other than a fin (a v1 agent fails the tunnel on one). */
  strayText: string[];
  /** Binary bytes received from the client. */
  received: Buffer[];
  gotFin: boolean;
  /** The close code the client sent, once closed. */
  closeCode: number | null;
  closed: Promise<number>;
  /** firehose: bytes handed to ws.send so far. */
  sent: number;
  /** Pings from the client. */
  pings: number;
}

export interface FakeForward {
  probe: { status: number; body: unknown };
  behaviour: Map<number, BoxBehaviour>;
  queue: Map<number, DialAction[]>;
  banner: string;
  total: number;
  /** Every forward request, upgraded or refused: what a token in a URL or a missing header would show. */
  dials: Array<{ url: string; authorization: string | null; protocol: string | null; port: number }>;
  conns: ForwardConn[];
  /** Every request URL the orchestrator saw, HTTP and upgrade alike. */
  urls: string[];
  /** An orchestrator from before v2: it picks termag-forward.v1 and relays every text frame. */
  v1Only: boolean;
}

const FORWARD_PATH = /^\/termag\/api\/cli\/v1\/boxes\/([^/]+)\/forward\/([^/?]+)$/;
const PROBE = '/api/cli/v1/boxes/i1/forward';

function refuse(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
}

export function installFakeForward(orch: FakeOrchestrator): FakeForward {
  const fake: FakeForward = {
    probe: { status: 200, body: { ok: true, capability: 'port-forward-v1', maxConnections: 128 } },
    behaviour: new Map(),
    queue: new Map(),
    banner: 'hello from the box',
    total: 0,
    dials: [],
    conns: [],
    urls: [],
    v1Only: false,
  };
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false,
    handleProtocols: (offered) => !fake.v1Only && offered.has('termag-forward.v2') ? 'termag-forward.v2' : offered.has('termag-forward.v1') ? 'termag-forward.v1' : false,
  });

  orch.override.set(PROBE, (res: ServerResponse) => {
    res.writeHead(fake.probe.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(fake.probe.body));
  });
  const validBearer = (auth: string | null) => {
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const device = orch.tokens.get(orch.accessTokens.get(raw) ?? '');
    return !!device && !device.revoked;
  };

  orch.upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    fake.urls.push(url);
    const m = FORWARD_PATH.exec(url);
    if (!m) { refuse(socket, 404, { error: 'No such CLI endpoint', code: 'not_found' }); return; }
    const port = Number(m[2]);
    const authorization = req.headers.authorization ?? null;
    fake.dials.push({ url, authorization, protocol: (req.headers['sec-websocket-protocol'] as string) ?? null, port });
    if (url.includes('token') || !validBearer(authorization)) { refuse(socket, 401, { error: 'Unknown token', code: 'auth_required' }); return; }
    if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) { refuse(socket, 400, { error: 'bad port', code: 'bad_port' }); return; }
    const action = fake.queue.get(port)?.shift();
    if (action && 'refuse' in action) {
      refuse(socket, action.refuse.status, { error: action.refuse.error ?? action.refuse.code, code: action.refuse.code });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (action && 'closeAfterOpen' in action) { ws.close(action.closeAfterOpen); return; }
      serve(ws, port, orch.accessTokens.get(authorization!.slice(7)) ?? null);
    });
  };

  /** `signIn`: the device token the connection's bearer was minted from. */
  function serve(ws: WebSocket, port: number, signIn: string | null): void {
    let resolveClosed!: (code: number) => void;
    const conn: ForwardConn = {
      port, ws, protocol: ws.protocol, tokens: [], strayText: [], received: [], gotFin: false, closeCode: null, sent: 0, pings: 0,
      closed: new Promise(resolve => { resolveClosed = resolve; }),
    };
    fake.conns.push(conn);
    ws.on('close', (code) => { conn.closeCode = code; resolveClosed(code); });
    ws.on('error', () => {});
    ws.on('ping', () => { conn.pings++; });
    const behaviour = fake.behaviour.get(port) ?? 'echo';
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString() !== '{"t":"fin"}') {
          // The orchestrator's own: on v2 a token frame is taken, never relayed.
          const msg = (() => { try { return JSON.parse(data.toString()) as { t?: string; token?: string }; } catch { return null; } })();
          if (conn.protocol === 'termag-forward.v2' && msg?.t === 'token' && typeof msg.token === 'string') {
            conn.tokens.push(msg.token);
            // As the orchestrator does: a renewal from another sign-in is refused, with 4406.
            if (orch.accessTokens.get(msg.token) !== signIn) ws.close(4406, 'Renewed access token refused (another sign-in, or not valid); reconnect');
          }
          else conn.strayText.push(data.toString());
          return;
        }
        conn.gotFin = true;
        if (behaviour === 'echo') ws.send('{"t":"fin"}');
        else if (behaviour === 'speak-then-fin') ws.close(1000);
        return;
      }
      conn.received.push(data as Buffer);
      if (behaviour === 'echo') ws.send(data, { binary: true });
    });
    if (behaviour === 'speak-then-fin') {
      ws.send(Buffer.from(fake.banner), { binary: true });
      ws.send('{"t":"fin"}');
    }
    if (behaviour === 'stall') ws.pause();
    if (behaviour === 'firehose') {
      const chunk = Buffer.alloc(64 * 1024, 7);
      const pump = () => {
        while (conn.sent < fake.total && ws.readyState === ws.OPEN) {
          const n = Math.min(chunk.length, fake.total - conn.sent);
          conn.sent += n;
          ws.send(chunk.subarray(0, n), { binary: true }, () => { if (ws.bufferedAmount <= 256 * 1024) pump(); });
          if (ws.bufferedAmount > 1024 * 1024) return;
        }
      };
      pump();
    }
  }
  // A paused box end never reads the client's close frame; don't let it hold the server open.
  const close = orch.close;
  orch.close = async () => { for (const c of fake.conns) c.ws.terminate(); await close(); };
  return fake;
}
