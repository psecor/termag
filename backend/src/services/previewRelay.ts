/**
 * The preview relay: a
 * viewer's HTTP requests and WebSockets to the app on the box, over preview
 * tunnels the box's agent opens (agentTunnels.openPreview), with the header
 * rules of services/previewHostRules.ts both ways. Modelled on
 * routes/cliT3.ts's relays, whose WebSocket helpers it shares.
 *
 * - **One pool per viewer session (SR7).** Each session gets its own
 *   keep-alive http.Agent (16 connections, dropped after 30 s idle) whose
 *   createConnection opens a tunnel, so a tunnel opens once per kept-alive
 *   connection rather than once per request, and no two viewers' requests
 *   ever share a connection to the app: a request-smuggling desync in a dev
 *   server can't hand one viewer another's response.
 * - **WebSockets** (HMR) each get a tunnel of their own, counted against the
 *   same per-owner cap, and are terminated on both sides so a revoke can close
 *   them with 1008. Every open one is in a per-session registry.
 * - **Backpressure**: HTTP bodies are piped; WebSocket messages are read no
 *   faster than the other side writes (cliT3's relayMessages).
 *
 * Tunnels are counted under the link's owner (agentTunnels' `preview` kind),
 * so viewers share the owner's preview budget.
 */
import http, { type IncomingMessage, type ServerResponse } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { type WebSocketServer } from 'ws';
import { TunnelError, type OpenedTunnel } from './agentTunnels';
import { closeSafely, endUpgrade, relayMessages } from '../routes/cliT3';
import {
  PREVIEW_BODY_LIMIT, previewRequestHeaders, previewResponseHeaders, type RelayTarget,
} from './previewHostRules';
import { sendPage, type PreviewPageKind } from '../previewPages';
import { answered, bytesRelayed, refused, tunnelClosed, tunnelOpened } from './previewLinkTelemetry';

export const POOL_MAX_SOCKETS = 16;
export const POOL_IDLE_MS = 30_000;
/** The largest WebSocket message either side may send: HMR's are small, a dev tool's can be a few MB. */
export const PREVIEW_WS_MAX_PAYLOAD = 32 * 1024 * 1024;
/** The close code for a socket whose session was revoked or no longer holds (A3). */
export const PREVIEW_REVOKED_CLOSE_CODE = 1008;

export interface PreviewTunnels {
  openPreview(boxId: string, ownerId: string, port: number, confine: { checkout: string } | null): Promise<OpenedTunnel>;
}

/** Where a session's requests go: the link's box and port, as the orchestrator chose them, never the request (SR8). */
export interface RelayContext {
  sessionIdHash: string;
  linkId: string;
  boxId: string;
  ownerId: string;
  port: number;
  confine: { checkout: string } | null;
  target: RelayTarget;
}

/** A tunnel error, as the termag page the viewer gets (tech spec, "Errors"). */
export function tunnelErrorPage(err: unknown): PreviewPageKind {
  const code = err instanceof TunnelError ? err.code : 'tunnel_failed';
  if (code === 'port_closed') return 'not_running';
  if (code === 'port_refused') return 'port_refused';
  if (code === 'too_many_tunnels') return 'busy';
  if (code === 'box_parked') return 'asleep';
  return 'try_again';
}

interface Pool {
  agent: http.Agent;
  linkId: string;
  sessionIdHash: string;
  /** What its connections dial: box, owner, port and confinement. A request for another target gets a new pool. */
  target: string;
  inflight: number;
  lastUsed: number;
  /** Replaced by a pool for a new target: closes once its last request is done. */
  retired?: boolean;
}

function targetKey(ctx: RelayContext): string {
  return JSON.stringify([ctx.boxId, ctx.ownerId, ctx.port, ctx.confine?.checkout ?? null]);
}

export interface PreviewRelayDeps {
  tunnels: PreviewTunnels;
  /** A noServer WebSocketServer built with previewRelayServerOptions(). */
  wss: WebSocketServer;
  now?: () => number;
  idleMs?: number;
  maxSockets?: number;
  /** Keep a viewer's socket alive through the ALB. */
  heartbeat?: (ws: WebSocket) => void;
}

/** The subprotocol the app chose, for the relay's server to agree to. */
const chosenProtocol = new WeakMap<IncomingMessage, string>();

export function previewRelayServerOptions(): WebSocket.ServerOptions {
  return {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: PREVIEW_WS_MAX_PAYLOAD,
    handleProtocols: (_offered, req) => chosenProtocol.get(req) ?? false,
  };
}

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** A refused upgrade: a plain status, nothing about why (A4). */
export function rawStatus(status: number, extra = ''): string {
  const body = `${STATUS_TEXT[status] ?? 'Error'}\n`;
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n${extra}Cache-Control: no-store\r\nConnection: close\r\n\r\n${body}`;
}

export class PreviewRelay {
  private pools = new Map<string, Pool>();
  /** Retired pools still finishing a request, by session: a revoke or a drain closes them too. */
  private retired = new Map<string, Set<Pool>>();
  private sockets = new Map<string, Set<WebSocket>>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxSockets: number;
  private sweeper: NodeJS.Timeout;

  constructor(private readonly deps: PreviewRelayDeps) {
    this.now = deps.now ?? Date.now;
    this.idleMs = deps.idleMs ?? POOL_IDLE_MS;
    this.maxSockets = deps.maxSockets ?? POOL_MAX_SOCKETS;
    this.sweeper = setInterval(() => this.dropIdle(), Math.max(1_000, Math.floor(this.idleMs / 3)));
    this.sweeper.unref();
  }

  /** Open a preview tunnel, timed and counted. */
  private async open(ctx: RelayContext): Promise<Duplex> {
    const t0 = this.now();
    const t = await this.deps.tunnels.openPreview(ctx.boxId, ctx.ownerId, ctx.port, ctx.confine);
    tunnelOpened(ctx.boxId, this.now() - t0);
    let counted = true;
    t.stream.once('close', () => { if (counted) { counted = false; tunnelClosed(); } });
    return t.stream;
  }

  /**
   * The session's pool for this target, made on first use. Its connections dial the target they were made
   * for, so when a renew moves the link to another port, or the project to another box, the old pool is
   * retired: no new request uses it, and it closes once its last one is done.
   */
  private pool(ctx: RelayContext): Pool {
    const target = targetKey(ctx);
    const existing = this.pools.get(ctx.sessionIdHash);
    if (existing && existing.target === target) return existing;
    if (existing) {
      this.pools.delete(ctx.sessionIdHash);
      existing.retired = true;
      if (existing.inflight === 0) existing.agent.destroy();
      else {
        const set = this.retired.get(ctx.sessionIdHash) ?? new Set<Pool>();
        set.add(existing);
        this.retired.set(ctx.sessionIdHash, set);
      }
    }
    const agent = new http.Agent({ keepAlive: true, maxSockets: this.maxSockets, maxFreeSockets: this.maxSockets });
    (agent as unknown as { createConnection: unknown }).createConnection = (_opts: unknown, cb: (err: Error | null, s?: Duplex) => void) => {
      this.open(ctx).then(s => cb(null, s), err => cb(err as Error));
    };
    const pool: Pool = { agent, linkId: ctx.linkId, sessionIdHash: ctx.sessionIdHash, target, inflight: 0, lastUsed: this.now() };
    this.pools.set(ctx.sessionIdHash, pool);
    return pool;
  }

  /** Pools with nothing in flight for idleMs: their connections close, and their tunnels with them. */
  dropIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, p] of this.pools) {
      if (p.inflight === 0 && p.lastUsed <= cutoff) { p.agent.destroy(); this.pools.delete(id); }
    }
  }

  /** Pools and open sockets now, for tests and the drain. */
  stats(): { pools: number; sockets: number } {
    let sockets = 0;
    for (const set of this.sockets.values()) sockets += set.size;
    return { pools: this.pools.size, sockets };
  }

  private closeRetired(pool: Pool): void {
    pool.agent.destroy();
    const set = this.retired.get(pool.sessionIdHash);
    if (set) { set.delete(pool); if (set.size === 0) this.retired.delete(pool.sessionIdHash); }
  }

  /** A session ended (revoked, removed, its basis gone): its connections and sockets close now, sockets with 1008. */
  dropSession(idHash: string, reason = 'preview session ended'): void {
    const p = this.pools.get(idHash);
    if (p) { p.agent.destroy(); this.pools.delete(idHash); }
    // A retired pool's in-flight response (a stream from the link's old target) ends with the session too.
    for (const r of this.retired.get(idHash) ?? []) r.agent.destroy();
    this.retired.delete(idHash);
    const set = this.sockets.get(idHash);
    if (set) {
      this.sockets.delete(idHash);
      for (const ws of set) closeSafely(ws, PREVIEW_REVOKED_CLOSE_CODE, reason);
    }
  }

  /** Every pool and socket, at shutdown or drain. */
  closeAll(code: number, reason: string): void {
    for (const p of this.pools.values()) p.agent.destroy();
    this.pools.clear();
    for (const set of this.retired.values()) for (const r of set) r.agent.destroy();
    this.retired.clear();
    for (const set of this.sockets.values()) for (const ws of set) closeSafely(ws, code, reason);
    this.sockets.clear();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  /** Relay one HTTP request over the session's pool. Answers every failure with a termag page. */
  relayHttp(req: IncomingMessage, res: ServerResponse, ctx: RelayContext): void {
    const pool = this.pool(ctx);
    pool.inflight++;
    pool.lastUsed = this.now();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      pool.inflight--;
      pool.lastUsed = this.now();
      if (pool.retired && pool.inflight === 0) this.closeRetired(pool);
    };
    res.once('close', done);
    res.once('finish', () => answered(res.statusCode));

    const upstream = http.request({
      agent: pool.agent,
      method: req.method,
      path: req.url,
      headers: previewRequestHeaders(req.headers, ctx.target),
    });
    let up = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      up += c.length;
      if (up > PREVIEW_BODY_LIMIT && !tooLarge) {
        tooLarge = true;
        refused('too_large');
        upstream.destroy();
        if (!res.headersSent) sendPage(res, 'too_large', req.method);
        else res.destroy();
        req.unpipe(upstream);
        req.resume();
      }
    });
    req.once('end', () => bytesRelayed('up', up));
    upstream.on('response', (appRes) => {
      res.writeHead(appRes.statusCode ?? 502, appRes.statusMessage, previewResponseHeaders(appRes.headers, ctx.target));
      // SSE and other streams: headers now, each chunk as it comes.
      res.flushHeaders();
      let down = 0;
      appRes.on('data', (c: Buffer) => { down += c.length; });
      appRes.pipe(res);
      appRes.on('error', () => {});
      appRes.on('close', () => {
        bytesRelayed('down', down);
        // The app's answer cut short: cut the viewer's short too, so it sees the truncation.
        if (!appRes.complete) res.destroy();
      });
    });
    upstream.on('error', (err) => {
      if (tooLarge) return;
      if (!res.headersSent) {
        const page = err instanceof TunnelError ? tunnelErrorPage(err) : 'not_running';
        refused(err instanceof TunnelError ? err.code : 'app_failed');
        sendPage(res, page, req.method);
      } else {
        res.destroy();
      }
    });
    // The viewer left (or the answer is done): an unfinished request to the app goes too.
    res.once('close', () => { if (!upstream.destroyed && !res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  /**
   * Relay a WebSocket upgrade (HMR): a tunnel of its own, the handshake
   * written with the request rules, the app's answer passed back, then
   * messages both ways. `stillValid` is the session recheck, run every
   * `recheckMs`; false closes the socket with 1008.
   */
  async relayUpgrade(
    req: IncomingMessage, socket: Duplex, head: Buffer, ctx: RelayContext,
    opts: { stillValid?: () => Promise<boolean>; recheckMs?: number } = {},
  ): Promise<void> {
    let gone = false;
    socket.once('close', () => { gone = true; });
    let stream: Duplex;
    try {
      stream = await this.open(ctx);
    } catch (err) {
      const page = tunnelErrorPage(err);
      refused(err instanceof TunnelError ? err.code : 'tunnel_failed');
      endUpgrade(socket, rawStatus(page === 'busy' ? 429 : page === 'not_running' || page === 'port_refused' ? 502 : 503, page === 'try_again' || page === 'busy' ? 'Retry-After: 5\r\n' : ''));
      return;
    }
    if (gone) { stream.destroy(); return; }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    let app: WebSocket;
    try {
      app = new WebSocket(`ws://localhost:${ctx.port}${req.url ?? '/'}`, offered, {
        createConnection: () => stream as unknown as import('net').Socket,
        headers: previewRequestHeaders(req.headers, ctx.target, { websocket: true }) as Record<string, string>,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        maxPayload: PREVIEW_WS_MAX_PAYLOAD,
      });
    } catch {
      stream.destroy();
      endUpgrade(socket, rawStatus(400));
      return;
    }
    const dropApp = () => { try { app.terminate(); } catch { /* gone */ } };
    socket.once('close', () => { if (!upgraded) dropApp(); });
    let upgraded = false;
    let answered = false;
    const answer = (raw: string | Buffer) => {
      if (answered) return;
      answered = true;
      endUpgrade(socket, raw);
    };
    app.on('error', () => { /* answered below */ });
    app.once('unexpected-response', (_q, appRes) => {
      // The app refused the handshake: hand its answer on, under the response rules.
      const chunks: Buffer[] = [];
      let n = 0;
      appRes.on('data', (c: Buffer) => { if (n < 64 * 1024) { chunks.push(c); n += c.length; } });
      appRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = previewResponseHeaders(appRes.headers, ctx.target);
        delete headers['content-length'];
        const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`));
        answer(Buffer.concat([
          Buffer.from(`HTTP/1.1 ${appRes.statusCode ?? 502} ${STATUS_TEXT[appRes.statusCode ?? 502] ?? ''}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`),
          body,
        ]));
        dropApp();
      });
    });
    app.once('error', () => {
      if (!upgraded) { refused('app_failed'); answer(rawStatus(502)); }
    });
    app.once('open', () => {
      if (answered || gone || socket.destroyed) { dropApp(); socket.destroy(); return; }
      upgraded = true;
      answered = true;
      if (app.protocol) chosenProtocol.set(req, app.protocol);
      this.deps.wss.handleUpgrade(req, socket, head, (client) => {
        this.track(ctx.sessionIdHash, client);
        this.deps.heartbeat?.(client);
        relayMessages(client, app);
        relayMessages(app, client);
        let up = 0;
        let down = 0;
        client.on('message', (d: Buffer) => { up += d.length ?? 0; });
        app.on('message', (d: Buffer) => { down += d.length ?? 0; });
        client.on('close', (code, reason) => { closeSafely(app, code, reason); bytesRelayed('up', up); bytesRelayed('down', down); });
        app.on('close', (code, reason) => closeSafely(client, code, reason));
        client.on('error', () => app.terminate());
        app.on('error', () => client.terminate());
        if (opts.stillValid) {
          const t = setInterval(() => {
            opts.stillValid!().then(ok => {
              if (!ok) closeSafely(client, PREVIEW_REVOKED_CLOSE_CODE, 'preview session ended');
            }, () => { /* a failed check isn't a revoke; the next one decides */ });
          }, opts.recheckMs ?? 30_000);
          t.unref();
          client.once('close', () => clearInterval(t));
        }
      });
    });
  }

  private track(idHash: string, ws: WebSocket): void {
    let set = this.sockets.get(idHash);
    if (!set) { set = new Set(); this.sockets.set(idHash, set); }
    set.add(ws);
    ws.once('close', () => {
      const s = this.sockets.get(idHash);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) this.sockets.delete(idHash);
    });
  }
}
