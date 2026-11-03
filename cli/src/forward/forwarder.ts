import { createServer, type Server, type Socket } from 'node:net';
import type { BearerSource } from '../api.js';
import { CliError } from '../errors.js';
import type { Exec } from '../system.js';
import { dialForward, forwardUrl, SUBPROTOCOL_V2 } from './dial.js';
import { portHolder } from './holder.js';
import { pipe, type Pipe } from './pipe.js';
import type { ForwardPort } from './ports.js';
import { CLOSE, describeClose, describeRefusal, RETRY_CODES } from './refusals.js';
import { RENEW_VALID_FOR_MS, tokenRenewer } from './renew.js';

/** Loopback only, both families. Never a wildcard address. */
export const LISTEN_HOSTS = ['127.0.0.1', '::1'] as const;
/** How long Ctrl-C waits for live connections to close with 1000 before dropping them. */
const STOP_GRACE_MS = 2000;

export interface ForwardOptions {
  /** The orchestrator, as the CLI addresses it (`https://…/termag`). */
  host: string;
  box: { id: string; name: string };
  ports: ForwardPort[];
  /**
   * A fresh access token per connection (`bearerFor`, which uses `freshAccess`); given a refused one, it
   * refreshes. Also asked every RENEW_EVERY_MS while v2 connections are open, for their in-band renewal.
   */
  token: BearerSource;
  /** Runs `lsof` to name a port's holder; unset, conflicts go unexplained. */
  exec?: Exec;
  /** One line per notice: a wave of failures, a refusal, a recovery. */
  notify: (line: string) => void;
  /** Before the one retry. */
  retryDelayMs?: number;
  /** How often each connection pings the orchestrator; default PING_MS. */
  pingMs?: number;
  /** How often open v2 connections get a renewed access token; default RENEW_EVERY_MS. */
  renewEveryMs?: number;
  /** How soon a failed renewal is tried again; default RENEW_RETRY_MS. */
  renewRetryMs?: number;
}

export interface Listening extends ForwardPort {
  name: string;
  /** `127.0.0.1:3000` and, where this machine has IPv6 loopback, `[::1]:3000`. */
  addresses: string[];
}

export interface Totals {
  connections: number;
  /** Connections that ended with a refusal or an error rather than 1000. */
  failed: number;
  /** Bytes from this machine to the box. */
  bytesUp: number;
  /** Bytes from the box to this machine. */
  bytesDown: number;
}

export interface Forward {
  /** The ports listened on now: add() and close() change it in place. */
  listening: Listening[];
  totals: () => Totals;
  /** Ctrl-C: stop accepting, close live connections with 1000, and resolve with the totals. */
  stop: () => Promise<Totals>;
  /**
   * Bind more ports, all or nothing as startForward does: one in use closes only the ones this call
   * bound, and throws. The ports already listening keep listening.
   */
  add: (ports: ForwardPort[]) => Promise<Listening[]>;
  /** Stop one local port's listeners and close its live connections with 1000; the rest keep listening. */
  close: (local: number) => Promise<void>;
}

/** One local port's listeners, one per loopback family. */
interface Held {
  local: number;
  servers: Server[];
  /** Set once release() begins on the port: its listeners accept nothing more, and its relays end. */
  released: boolean;
}

/** One accepted connection; relay() fills in the dial or the pipe it is waiting on, for stop(). */
interface Connection {
  /** The local port it was accepted on, and whether it is being released. */
  held: Held;
  socket: Socket;
  pipe: Pipe | null;
  abort: (() => void) | null;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hostPort = (host: string, port: number) => host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

function listenOn(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError).once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

/** This machine has no IPv6 loopback: listen on 127.0.0.1 alone. */
const NO_FAMILY = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT']);

async function bindError(err: NodeJS.ErrnoException, p: ForwardPort, opts: ForwardOptions): Promise<CliError> {
  if (err.code === 'EADDRINUSE') {
    const holder = await portHolder(opts.exec, p.local);
    const free = p.local + 1 <= 65535 ? `; stop it, or use another local port: termag forward ${opts.box.name} ${p.port}:${p.local + 1}` : '';
    return new CliError('conflict', `Local port ${p.local} is already in use${holder ? ` by ${holder}` : ''}${free}`);
  }
  if (err.code === 'EACCES') return new CliError('failed', `Not allowed to listen on local port ${p.local}`);
  return new CliError('failed', `Can't listen on local port ${p.local}: ${err.code ?? err.message}`);
}

/**
 * Bind every port's loopback listeners, then relay each connection they
 * accept to `127.0.0.1:<port>` on the box through the orchestrator (contract
 * sections 1, 4 and 6). Probe first (`probeForward`): this does not.
 *
 * Binding is all or nothing: one port in use closes the rest and throws, naming
 * the holder. Once listening, nothing but `stop()` and `close()` closes the
 * listeners; a connection that fails is closed alone and reported once per wave.
 */
export async function startForward(opts: ForwardOptions): Promise<Forward> {
  const totals: Totals = { connections: 0, failed: 0, bytesUp: 0, bytesDown: 0 };
  // Each local port bound or being bound; release() takes it out.
  const held = new Map<number, Held>();
  const live = new Set<Connection>();
  let stopping = false;

  // One notice per wave: a key is printed once, and forgotten when a connection gets through.
  const shown = new Set<string>();
  const notice = (key: string, line: string) => {
    if (shown.has(key)) return;
    shown.add(key);
    opts.notify(line);
  };
  const recovered = (p: Listening) => {
    if (shown.delete('wave')) opts.notify(`connections to ${opts.box.name} work again`);
    for (const key of [...shown]) if (key.startsWith(`${p.local}:`)) shown.delete(key);
  };
  // One renewal for every open v2 connection, whatever port it is on.
  const renewer = tokenRenewer(opts.token, {
    everyMs: opts.renewEveryMs,
    retryMs: opts.renewRetryMs,
    onError: err => notice('renew', `can't renew the access token of open connections (${err.message}); trying again, and each lasts until its token expires`),
    // Got one again: the next outage is told too, as `recovered` does for a wave.
    onRenewed: () => { shown.delete('renew'); },
  });

  async function relay(conn: Connection, p: Listening): Promise<void> {
    const { socket } = conn;
    // stop(), or close() of this connection's port.
    const ended = () => stopping || conn.held.released;
    const url = forwardUrl(opts.host, opts.box.id, p.port);
    const label = `${p.name} (localhost:${p.local})`;
    const fail = (key: string, line: string) => {
      totals.failed++;
      notice(key, line);
      if (!socket.destroyed) socket.destroy();
    };
    // The access token the orchestrator last refused, for one refresh (its signing key was retired, say).
    let rejected: string | undefined;
    for (let attempt = 0; ; attempt++) {
      if (ended() || socket.destroyed) { socket.destroy(); return; }
      let token: string;
      try {
        // Valid long enough for the renewer's next ask (renew.ts).
        token = await opts.token({ rejected, validForMs: RENEW_VALID_FOR_MS });
      } catch (err) {
        fail('wave', `can't get an access token: ${(err as Error).message}; listeners stay up`);
        return;
      }
      if (ended() || socket.destroyed) { socket.destroy(); return; }
      const dial = dialForward(url, token);
      conn.abort = dial.abort;
      const onGone = () => dial.abort();
      socket.once('close', onGone);
      const outcome = await dial.outcome;
      socket.off('close', onGone);
      conn.abort = null;
      if (outcome.kind === 'open' && (ended() || socket.destroyed)) { outcome.ws.close(CLOSE.NORMAL); socket.destroy(); return; }
      if (ended() || socket.destroyed) return;
      const retry = attempt === 0;

      if (outcome.kind === 'failed') {
        fail('wave', `can't reach the orchestrator at ${opts.host} (${outcome.reason}); listeners stay up and new connections dial again`);
        return;
      }
      if (outcome.kind === 'refused') {
        if (retry && RETRY_CODES.has(outcome.code)) { await sleep(opts.retryDelayMs ?? 500); continue; }
        if (outcome.code === 'auth_required' && rejected === undefined) { rejected = token; continue; }
        if (outcome.code === 'auth_required' || outcome.code === 'edge_auth') {
          fail('wave', `${opts.host} refused the CLI's credential; run \`termag login\` (listeners stay up)`);
          return;
        }
        const what = describeRefusal(outcome.code, { box: opts.box.name, host: opts.host, port: p.port, error: outcome.error });
        fail(`${p.local}:${outcome.code}`, `${label}: ${outcome.code}: ${what}`);
        return;
      }

      // A port close() releases is ended, not renewed (nor its closes counted as failures: ended()).
      if (outcome.ws.protocol === SUBPROTOCOL_V2) renewer.add(outcome.ws, token, ended);
      // Through once the box answers: an open alone may yet be closed with 1012.
      let through = false;
      const relayPipe = pipe(socket, outcome.ws, {
        keepIfUntouched: code => retry && code === CLOSE.DRAINING,
        pingMs: opts.pingMs,
        onBytes: (up, down) => {
          totals.bytesUp += up;
          totals.bytesDown += down;
          if (down && !through) { through = true; recovered(p); }
        },
      });
      conn.pipe = relayPipe;
      const result = await relayPipe.done;
      conn.pipe = null;
      if (result.untouched) { await sleep(opts.retryDelayMs ?? 500); continue; }
      if (result.code === CLOSE.NORMAL) { if (!through) recovered(p); return; }
      // A local peer that resets its own connection (a browser does) is no failure of the forward.
      // The orchestrator's 12 h cap: expected, and only this connection's; a TCP stream can't redial, so it was reset.
      if (result.code === CLOSE.LIFETIME && result.closedBy === 'remote' && !ended()) {
        totals.failed++;
        notice(`${p.local}:lifetime`, `${label}: a connection reached the orchestrator's 12 h limit and was closed; a new connection will work (listeners stay up)`);
        return;
      }
      // v2: its token expired before a renewal reached the orchestrator (offline for the renewer's asks, say),
      // or it was opened under a sign-in a later `termag login` replaced, which can't renew it.
      if (result.code === CLOSE.TOKEN_NOT_RENEWED && result.closedBy === 'remote' && !ended()) {
        totals.failed++;
        if (renewer.outlived(outcome.ws)) {
          notice(`${p.local}:signin`, `${label}: a connection opened under an earlier sign-in reached its access token's expiry and was closed: a later \`termag login\` replaced that sign-in, which can't renew it; new connections use the new one (listeners stay up)`);
        } else {
          notice(`${p.local}:token`, `${label}: a connection was closed: ${describeClose(result.code, opts.box.name)}; a new connection gets a fresh one (listeners stay up)`);
        }
        return;
      }
      if (result.code === CLOSE.RENEWAL_REFUSED && result.closedBy === 'remote' && !ended()) {
        totals.failed++;
        notice(`${p.local}:refused`, `${label}: a connection was closed: ${describeClose(result.code, opts.box.name)}; a new connection gets a fresh token (listeners stay up)`);
        return;
      }
      if (result.closedBy === 'remote' && !ended()) {
        totals.failed++;
        notice('wave', `a connection to ${p.name} dropped: ${describeClose(result.code, opts.box.name)}; listeners stay up and new connections dial again`);
      }
      return;
    }
  }

  const accept = (socket: Socket, p: Listening, h: Held) => {
    // A connection the listener had queued when its release began: every relay must be one release() ends.
    if (stopping || h.released) { socket.destroy(); return; }
    totals.connections++;
    socket.on('error', () => { /* the relay sees 'close' */ });
    const conn: Connection = { held: h, socket, pipe: null, abort: null, done: Promise.resolve() };
    conn.done = relay(conn, p)
      .catch((err) => { notice('wave', `relay error: ${(err as Error).message}`); socket.destroy(); })
      .finally(() => { live.delete(conn); });
    live.add(conn);
  };

  const listening: Listening[] = [];

  /**
   * Stop accepting on these local ports, then end their live connections: a relaying one closes
   * with 1000 and is dropped after `graceMs`, a dial still pending is aborted. A server's close()
   * calls back only once its accepted sockets have closed, so the ports are marked released first:
   * accept() destroys what comes in after, and every relay they have is one this ends.
   */
  const release = async (ports: Held[], graceMs: number) => {
    // A port released already is another release()'s to finish.
    const going = ports.filter(h => !h.released);
    for (const h of going) {
      h.released = true;
      held.delete(h.local);
      const i = listening.findIndex(l => l.local === h.local);
      if (i >= 0) listening.splice(i, 1);
    }
    const ending = [...live].filter(c => going.includes(c.held));
    const closed = Promise.all(going.flatMap(h => h.servers).map(s => new Promise(resolve => s.close(resolve))));
    for (const c of ending) {
      if (c.pipe) c.pipe.stop(graceMs);
      else { c.abort?.(); c.socket.destroy(); }
    }
    // Cleared once the pipes finish first: the bin sets exitCode rather than exiting, so a pending timer holds the process up.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(ending.map(c => c.done)), new Promise(resolve => { timer = setTimeout(resolve, graceMs + 500); })]);
    clearTimeout(timer);
    await closed;
  };
  const shutdown = async (graceMs: number) => {
    stopping = true;
    renewer.stop();
    await release([...held.values()], graceMs);
  };

  /**
   * Bind each port's loopback listeners; one that fails closes what this call bound (`held` has them) and throws.
   * So does a close() or stop() that releases a port while it is being bound.
   */
  const bind = async (ports: ForwardPort[]): Promise<Listening[]> => {
    const bound: Listening[] = [];
    const tried: Held[] = [];
    for (const p of ports) {
      if (held.has(p.local)) {
        await release(tried, 0);
        throw new CliError('conflict', `Local port ${p.local} is already forwarded`);
      }
      const h: Held = { local: p.local, servers: [], released: false };
      tried.push(h);
      held.set(p.local, h);
      const l: Listening = { ...p, name: p.name ?? `${opts.box.name}:${p.port}`, addresses: [] };
      for (const host of LISTEN_HOSTS) {
        const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => accept(socket, l, h));
        try {
          await listenOn(server, host, p.local);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (host !== LISTEN_HOSTS[0] && NO_FAMILY.has(e.code ?? '')) continue;
          // The listeners already bound accept while lsof names the holder (up to 5 s): stop them meanwhile.
          const [failure] = await Promise.all([bindError(e, p, opts), release(tried, 0)]);
          throw failure;
        }
        // Released while listen() was pending: release() closed the listeners it knew of, not this one.
        if (h.released) {
          await Promise.all([new Promise(resolve => server.close(resolve)), release(tried, 0)]);
          throw new CliError('failed', stopping ? 'The forward has stopped' : `Local port ${p.local} was closed while it was being bound`);
        }
        server.on('error', (err: Error) => notice(`${p.local}:listen`, `the listener on ${hostPort(host, p.local)} failed: ${err.message}`));
        h.servers.push(server);
        l.addresses.push(hostPort(host, p.local));
      }
      bound.push(l);
    }
    listening.push(...bound);
    return bound;
  };

  try {
    await bind(opts.ports);
  } catch (err) {
    if (!stopping) await shutdown(0);
    throw err;
  }

  return {
    listening,
    totals: () => ({ ...totals }),
    stop: async () => {
      await shutdown(STOP_GRACE_MS);
      return { ...totals };
    },
    add: async (ports) => {
      if (stopping) throw new CliError('failed', 'The forward has stopped');
      return await bind(ports);
    },
    close: async (local) => {
      const h = held.get(local);
      if (h) await release([h], STOP_GRACE_MS);
    },
  };
}
