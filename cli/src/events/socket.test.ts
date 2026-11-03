import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CliError } from '../errors.js';
import { openStatusSocket, statusSocketUrl } from './socket.js';

/** A status socket that accepts the bearers in `accept`, or answers the upgrade with `refuseWith`. */
let server: Server;
let wss: WebSocketServer;
let url: string;
let accept: Set<string>;
let refuseWith: number | null;
let dials: Array<{ authorization: string | undefined; ws: WebSocket | null }>;
let socket: { stop: () => void } | null;

beforeEach(async () => {
  accept = new Set(['t1']);
  refuseWith = null;
  dials = [];
  socket = null;
  wss = new WebSocketServer({ noServer: true });
  server = createServer();
  server.on('upgrade', (req: IncomingMessage, sock, head) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const dial = { authorization: req.headers.authorization, ws: null as WebSocket | null };
    dials.push(dial);
    const status = refuseWith ?? (accept.has(bearer) ? null : 401);
    if (status) { sock.end(`HTTP/1.1 ${status} No\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    wss.handleUpgrade(req, sock, head, (ws) => { dial.ws = ws; ws.send(JSON.stringify({ type: 'heartbeat', ts: 1 })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = statusSocketUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}/termag`);
});

afterEach(async () => {
  socket?.stop();
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A token source that hands out t1, t2, … and records what it was asked. */
function tokens() {
  const asked: Array<string | undefined> = [];
  let n = 1;
  let current = 't1';
  return {
    asked,
    source: async (opts?: { rejected?: string }) => {
      asked.push(opts?.rejected);
      if (opts?.rejected === current) current = `t${++n}`;
      return current;
    },
  };
}

function open(token = tokens(), over: { staleMs?: number } = {}) {
  const seen = { opens: 0, texts: [] as string[], downs: [] as string[], fatal: null as CliError | null };
  socket = openStatusSocket({
    url, token: token.source, backoffMs: [0, 10, 20], ...over,
    onOpen: () => { seen.opens++; },
    onText: t => seen.texts.push(t),
    onDown: r => seen.downs.push(r),
    onFatal: (e) => { seen.fatal = e; },
  });
  return { seen, token };
}

describe('the events status socket', () => {
  it('sends the bearer in the header, never the URL', async () => {
    open();
    await until(() => dials.length === 1 && dials[0].ws !== null);
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/termag\/api\/cli\/v1\/ws\/status$/);
    expect(dials[0].authorization).toBe('Bearer t1');
  });

  it('dials again after the server drops it, and again after a draining close', async () => {
    const { seen } = open();
    await until(() => seen.opens === 1);
    dials[0].ws!.terminate();
    await until(() => seen.opens === 2);
    dials[1].ws!.close(4503, 'draining');
    await until(() => seen.opens === 3);
    expect(seen.downs).toHaveLength(2);
    expect(seen.fatal).toBeNull();
  });

  it('dials again at once with a renewed token after 4401', async () => {
    accept.add('t2');
    const { seen, token } = open();
    await until(() => seen.opens === 1);
    dials[0].ws!.close(4401, 'Access token expired; reconnect with a fresh one');
    await until(() => seen.opens === 2);
    expect(token.asked).toEqual([undefined, 't1']);
    expect(dials[1].authorization).toBe('Bearer t2');
    expect(seen.downs).toEqual([]);
  });

  it('renews a token refused at the upgrade once, and stops when the renewed one is refused too', async () => {
    accept = new Set(['t2']);
    const first = open();
    await until(() => first.seen.opens === 1);
    expect(dials.map(d => d.authorization)).toEqual(['Bearer t1', 'Bearer t2']);
    socket!.stop();

    accept = new Set();
    dials = [];
    const second = open();
    await until(() => second.seen.fatal !== null);
    expect(second.seen.fatal).toMatchObject({ code: 'auth_required' });
    expect(dials).toHaveLength(2);
  });

  it('stops for good on a revoked sign-in, and retries a 1008 that waiting can fix', async () => {
    const { seen } = open();
    await until(() => seen.opens === 1);
    dials[0].ws!.close(1008, 'auth error');
    await until(() => seen.opens === 2);
    dials[1].ws!.close(1008, 'This device was signed out; run `termag login`');
    await until(() => seen.fatal !== null);
    expect(seen.fatal).toMatchObject({ code: 'auth_required', message: 'This device was signed out; run `termag login`' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dials).toHaveLength(2);
  });

  it('retries an edge that is down, and gives up on one that redirects to a browser sign-in', async () => {
    refuseWith = 502;
    const { seen } = open();
    await until(() => dials.length >= 2);
    expect(seen.fatal).toBeNull();
    refuseWith = 302;
    await until(() => seen.fatal !== null);
    expect(seen.fatal).toMatchObject({ code: 'edge_auth' });
  });

  it('drops a socket that has gone quiet and dials again', async () => {
    const { seen } = open(tokens(), { staleMs: 100 });
    await until(() => seen.opens === 1);
    await until(() => seen.opens === 2, 2000);
    expect(seen.downs[0]).toMatch(/no word from the orchestrator/);
  });
});
