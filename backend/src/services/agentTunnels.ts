/**
 * Tunnels to a box, opened by its agent on the orchestrator's request: to the
 * box's t3 server for the desktop app's relay,
 * to a loopback port for the native port forward,
 * or to a published port for a preview link's relay.
 *
 * The orchestrator can't reach a box: boxes only dial out. So for each relayed
 * connection it picks a random id, asks the box's agent over its control
 * socket to open a tunnel (`tunnel-open`, naming its target), and the agent
 * connects on loopback and dials back on /termag/ws/agent-tunnel?id=<id> with
 * its own token. That socket, accepted here once and only from the box the id
 * was made for, is handed to the relay as is (the forward relays its
 * messages) or as a byte stream the t3 relay speaks HTTP or WebSocket over.
 *
 * An id lives in this process only and for TUNNEL_TTL_MS: during an overlap
 * deploy a dial-back that lands on the other process finds nothing and is
 * refused, and the client's request fails (the desktop and the CLI retry).
 *
 * Each kind has its own per-user, per-box cap, so a browser full of forwards
 * can't starve the desktop's t3 relay, nor the reverse. Preview tunnels are
 * counted under the link owner's id, so a link's viewers share the owner's
 * preview budget and never touch their `port` or `t3` one. An open preview
 * tunnel is not box activity: the lifecycle sweep's busy check asks for
 * `port` only, and a viewer's input counts instead
 * (services/previewLinkActivity.ts).
 */
import { randomBytes } from 'crypto';
import type { Duplex } from 'stream';
import { createWebSocketStream, type WebSocket } from 'ws';

export const TUNNEL_TTL_MS = 15_000;
/** Open or opening tunnels one user may have to one box, per kind. */
export const TUNNEL_CAPS: Readonly<Record<TunnelKind, number>> = { t3: 64, port: 128, preview: 128 };
const TUNNEL_RPC_TIMEOUT_MS = 20_000;
const ID_RE = /^[0-9a-f]{64}$/;
// An agent's refusal reason is shown to the user (port_refused); bounded.
const REASON_MAX = 300;

/**
 * What a tunnel reaches on the box. A `preview` target goes through the same
 * port guard as `port`, plus the refusals for debuggers, shells and notebooks
 * (SR6, agent/port-guard.js); with `confine` set (a `people` or `link`
 * audience) the agent also requires the listener to descend from a
 * `termag preview run` of that checkout (PR 5), and refuses it until then.
 * Sent only to an agent announcing `preview-link-v1`.
 */
export type TunnelTarget =
  | { kind: 't3' }
  | { kind: 'port'; port: number }
  | { kind: 'preview'; port: number; confine: { checkout: string } | null };
export type TunnelKind = TunnelTarget['kind'];

export class TunnelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface OpenedTunnel {
  stream: Duplex;
  /** The box's t3 port, from the agent's reply; for the Host header. */
  port: number | null;
}

/** A dial-back, as the agent's reply came with it. */
export interface OpenedSocket {
  ws: WebSocket;
  /** The agent's tunnel-open reply (t3: `{ ok: true, port }`). */
  reply: unknown;
}

interface Pending {
  boxId: string;
  userId: string;
  kind: TunnelKind;
  expiresAt: number;
  resolve: (ws: WebSocket) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentTunnelDeps {
  /** sendToInstanceAgent: one RPC to the box's agent. */
  send: (boxId: string, type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
  /** Per-kind caps over TUNNEL_CAPS. */
  caps?: Partial<Record<TunnelKind, number>>;
}

/** How tunnel-open names a target on the wire (agent/agent.js): t3 keeps its original bare string. */
function wireTarget(target: TunnelTarget): unknown {
  if (target.kind === 't3') return 't3';
  if (target.kind === 'preview') return { kind: 'preview', port: target.port, confine: target.confine ? { checkout: target.confine.checkout } : null };
  return { kind: 'port', port: target.port };
}

/** The TunnelError for an agent's `{ ok: false, code | reason }` reply: it dialed nothing back. */
function refusalError(reply: { code?: unknown; reason?: unknown }): TunnelError {
  const code = typeof reply.code === 'string' ? reply.code : reply.reason;
  const reason = typeof reply.reason === 'string' && reply.reason ? reply.reason.slice(0, REASON_MAX) : null;
  if (code === 't3_not_running') return new TunnelError(503, 't3_not_running', "The box's t3 server is not running");
  if (code === 'port_refused') return new TunnelError(403, 'port_refused', reason ?? 'The box refused that port');
  if (code === 'port_closed') return new TunnelError(502, 'port_closed', reason ?? 'Nothing listens on that port on the box');
  // A connect failure other than ECONNREFUSED (ETIMEDOUT, EHOSTUNREACH): the agent's reason says which.
  if (code === 'tunnel_failed') return new TunnelError(502, 'tunnel_failed', reason ?? 'The box did not open the tunnel');
  return new TunnelError(502, 'tunnel_failed', `The box did not open the tunnel (${String(code)})`);
}

/**
 * A Duplex over a WebSocket, with the socket methods http and ws call on what
 * createConnection gives them, so either can run over a tunnel.
 */
export function socketLikeStream(ws: WebSocket): Duplex {
  const stream = createWebSocketStream(ws) as Duplex & Record<string, unknown>;
  const self = () => stream;
  stream.setTimeout = self;
  stream.setNoDelay = self;
  stream.setKeepAlive = self;
  stream.ref = self;
  stream.unref = self;
  return stream;
}

/**
 * Liveness for a tunnel dial-back, in place of the ping-and-terminate
 * heartbeat other sockets get (index.ts startHeartbeat). That one ends a
 * socket whose pong it has not read by the next tick, and a tunnel the relay
 * has paused for backpressure (createWebSocketStream pauses it whenever the
 * client reads slower than the box sends) reads nothing at all, pong
 * included: a slow but healthy download was cut 25-50 s in. Here every frame
 * that arrives counts as life, and a tick is not judged while the socket is
 * paused (the relay chose not to read it) or while it holds bytes its peer
 * has not taken yet (the peer has stopped reading: a `termag forward` client
 * whose local socket is full pauses its WebSocket, and it can't read our ping
 * either). Either way the other side, its hang-up, TCP and the proxies'
 * timeouts bound how long that lasts. A socket that reads, has nothing
 * queued, and receives nothing for a whole interval after a ping is
 * terminated.
 *
 * A peer that pings us on its own (`termag forward`'s connections and the
 * agent's port dial-backs, every 10 s) needs neither allowance but the
 * first: its pings come the way nothing is backed up, so it is judged even
 * while it holds bytes of ours. A laptop that slept mid-download, or a stream
 * black-holed with our bytes in it, is then cut within two intervals rather
 * than whenever TCP gives up. One that doesn't ping (an older CLI or agent,
 * the t3 relay) keeps the allowance.
 */
export function tunnelHeartbeat(ws: WebSocket, intervalMs: number): void {
  let alive = true;
  let peerPings = false;
  const life = () => { alive = true; };
  ws.on('pong', life);
  ws.on('ping', () => { peerPings = true; alive = true; });
  ws.on('message', life);
  const hb = setInterval(() => {
    if (ws.isPaused || (!peerPings && ws.bufferedAmount > 0)) { alive = true; return; }
    if (!alive) {
      try { ws.terminate(); } catch { /* gone */ }
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, intervalMs);
  ws.once('close', () => clearInterval(hb));
}

export class AgentTunnels {
  private pending = new Map<string, Pending>();
  private open = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly caps: Record<TunnelKind, number>;

  constructor(private readonly deps: AgentTunnelDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? TUNNEL_TTL_MS;
    this.caps = { ...TUNNEL_CAPS, ...deps.caps };
  }

  private key(userId: string, boxId: string, kind: TunnelKind): string {
    return `${userId}\u0000${boxId}\u0000${kind}`;
  }

  /** The cap on one user's tunnels of a kind to one box. */
  cap(kind: TunnelKind): number {
    return this.caps[kind];
  }

  /** Tunnels of a kind this user has open or opening to this box. */
  count(userId: string, boxId: string, kind: TunnelKind = 't3'): number {
    let n = this.open.get(this.key(userId, boxId, kind)) ?? 0;
    for (const p of this.pending.values()) if (p.userId === userId && p.boxId === boxId && p.kind === kind) n++;
    return n;
  }

  /**
   * The boxes among `ids` with a tunnel of one of `kinds` this process
   * carries or is opening, any user: the lifecycle sweep's `tunnels` check
   * asks for `port` (never `preview`: an open preview tab is no person at
   * the box), since it can't wait for the next host sample to see a forward
   * opened since the last.
   */
  boxesWithTunnels(ids: readonly string[], kinds: TunnelKind | readonly TunnelKind[]): Set<string> {
    const wanted = new Set(ids);
    const of = new Set<string>(typeof kinds === 'string' ? [kinds] : kinds);
    const found = new Set<string>();
    for (const k of this.open.keys()) {
      const [, boxId, kindOf] = k.split('\u0000');
      if (of.has(kindOf) && wanted.has(boxId)) found.add(boxId);
    }
    for (const p of this.pending.values()) if (of.has(p.kind) && wanted.has(p.boxId)) found.add(p.boxId);
    return found;
  }

  /** The box a pending, unexpired id was made for; null for any other id. */
  pendingBox(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    const p = this.pending.get(id);
    if (!p || this.now() > p.expiresAt) return null;
    return p.boxId;
  }

  /**
   * Hand the agent's dial-back socket to the waiting relay. Single use: the
   * id is gone afterwards whether or not the box matched.
   */
  accept(id: string, boxIdOfToken: string | null, ws: WebSocket): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (this.now() > p.expiresAt || boxIdOfToken !== p.boxId) {
      p.reject(new TunnelError(502, 'tunnel_failed', 'The tunnel was answered by the wrong box or too late'));
      return false;
    }
    // A port's server may speak first (SSH, Postgres): hold its bytes in the
    // socket until the forward relay listens and resumes it, since ws drops a
    // message nobody listens for. A t3 tunnel's stream resumes on first read.
    if (p.kind === 'port') ws.pause();
    // Counted as open from here, in the same step that took it out of
    // pending: the agent dials back before it replies, so a socket counted
    // only once the reply lands would be in neither while it is live, and
    // let a tunnel past the cap (Devin on #724). Released when it closes,
    // which covers one abandoned after the dial-back (openSocket terminates it).
    const release = this.hold(p.userId, p.boxId, p.kind);
    ws.once('close', release);
    p.resolve(ws);
    return true;
  }

  /** Count one open tunnel; the release gives it back, once. */
  private hold(userId: string, boxId: string, kind: TunnelKind): () => void {
    const k = this.key(userId, boxId, kind);
    this.open.set(k, (this.open.get(k) ?? 0) + 1);
    let counted = true;
    return () => {
      if (!counted) return;
      counted = false;
      const n = (this.open.get(k) ?? 1) - 1;
      if (n <= 0) this.open.delete(k); else this.open.set(k, n);
    };
  }

  /**
   * Open a tunnel and hand back the dial-back socket itself, counted against
   * its kind's cap from the dial-back until it closes. Rejects with a TunnelError: 429
   * too_many_tunnels, 502 tunnel_failed (the RPC failed or timed out), 504
   * tunnel_timeout (no dial-back in time), or the agent's own refusal
   * (t3_not_running, port_refused, port_closed).
   */
  async openSocket(boxId: string, userId: string, target: TunnelTarget): Promise<OpenedSocket> {
    const { kind } = target;
    const cap = this.caps[kind];
    if (this.count(userId, boxId, kind) >= cap) {
      throw new TunnelError(429, 'too_many_tunnels', `At most ${cap} open connections to one box`);
    }
    const id = randomBytes(32).toString('hex');
    const dialed = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new TunnelError(504, 'tunnel_timeout', 'The box did not open the tunnel in time'));
      }, this.ttlMs);
      timer.unref?.();
      this.pending.set(id, { boxId, userId, kind, expiresAt: this.now() + this.ttlMs, resolve, reject, timer });
    });
    // Both must happen: the agent's reply and its dial-back, in either order.
    dialed.catch(() => {});
    const abandon = (err: TunnelError): never => {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); clearTimeout(p.timer); }
      // A dial-back that arrived anyway has nobody to serve.
      dialed.then(ws => ws.terminate(), () => {});
      throw err;
    };
    let reply: unknown;
    try {
      reply = await this.deps.send(boxId, 'tunnel-open', { tunnelId: id, target: wireTarget(target) }, TUNNEL_RPC_TIMEOUT_MS);
    } catch (err) {
      abandon(new TunnelError(502, 'tunnel_failed', (err as Error).message ?? String(err)));
    }
    // The agent answers { ok: false, reason } (t3) or { ok: false, code, reason }
    // (port) when it dialed nothing back.
    const refused = reply as { ok?: unknown; code?: unknown; reason?: unknown } | null;
    if (refused?.ok === false) abandon(refusalError(refused));
    // Counted against the cap since accept took it.
    const ws = await dialed;
    return { ws, reply };
  }

  /**
   * Open a tunnel to a published port, as a byte stream the preview relay
   * speaks HTTP or WebSocket over (an http.Agent's createConnection), counted
   * under the link's owner. Rejects with a TunnelError: the agent's
   * port_refused (the guard, SR6, or an unconfined listener for a confined
   * target) and port_closed among them.
   */
  async openPreview(boxId: string, ownerId: string, port: number, confine: { checkout: string } | null): Promise<OpenedTunnel> {
    const { ws } = await this.openSocket(boxId, ownerId, { kind: 'preview', port, confine });
    return { stream: socketLikeStream(ws), port };
  }

  /** Open a tunnel to the box's t3 server, as a byte stream. Rejects with a TunnelError. */
  async openTunnel(boxId: string, userId: string): Promise<OpenedTunnel> {
    const { ws, reply } = await this.openSocket(boxId, userId, { kind: 't3' });
    const port = typeof (reply as { port?: unknown } | null)?.port === 'number' ? (reply as { port: number }).port : null;
    return { stream: socketLikeStream(ws), port };
  }
}
