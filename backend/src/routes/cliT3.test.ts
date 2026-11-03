import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import net, { type AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { RouteResult } from './routeResult';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { default: WebSocket, WebSocketServer } = await import('ws');
const { EventEmitter } = await import('events');
const { cliApiRouter, cliBearer } = await import('./cliApi');
const {
  cliT3RelayRouter, handleT3RelayUpgrade, handleAgentTunnelUpgrade, relayServerOptions, t3RelayTarget, isAgentTunnelPath, relayCloseCode,
  relayMessages, Hangup, RELAY_MAX_PAYLOAD_BYTES, RELAY_REDIAL_CLOSE_CODE,
} = await import('./cliT3');
type CliT3 = import('./cliT3').CliT3;
type T3Access = import('./cliT3').T3Access;
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');
const { AgentTunnels, TunnelError } = await import('../services/agentTunnels');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX_TOKEN = 'tmag_box';
const now = new Date('2026-10-21T00:00:00Z');

const session: CliSessionRecord = {
  id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd', createdAt: now, lastUsedAt: now, revokedAt: null,
};
const store: CliStore = {
  async findSessionByHash(hash) { return hash === sha256Hex(DEVICE) ? session : null; },
  async findSessionById(id) { return id === session.id ? session : null; },
  async validateAgentToken(raw) { return raw === BOX_TOKEN ? { user: alice, instanceId: 'box-1' } : null; },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};
const jwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);
// The bearer's clock, so a test can let an access token lapse.
let clock = now.getTime();
const bearerDeps = { store, jwt: Promise.resolve(jwt), now: () => new Date(clock) };
let recheckMs: number | undefined;

// ── a stand-in t3 server on loopback: echoes what reached it ──────────────────
let t3Port = 0;
let t3Server: http.Server;
const t3Wss = new WebSocketServer({ noServer: true });
let lastBoxRequest: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
// Upgrades that reached the stand-in box; one with wsTicket=slow waits for boxGate.
let boxUpgrades = 0;
let boxGate: Promise<void> | null = null;

// ── the fake CliT3 the routes run over ─────────────────────────────────────
let access: T3Access;
let calls: Array<[string, ...unknown[]]>;
let next: RouteResult;
let tunnelFailure: Error | null;
// Every tunnel stream handed to the relay; openTunnel waits for tunnelGate.
let opened: net.Socket[];
let tunnelGate: Promise<void> | null;
const t3: CliT3 = {
  async access(user, boxId) { calls.push(['access', user.id, boxId]); return access; },
  async ensure(user, boxId) { calls.push(['ensure', user.id, boxId]); return next; },
  async update(user, boxId, version) { calls.push(['update', user.id, boxId, version]); return next; },
  async pair(user, boxId, label) { calls.push(['pair', user.id, boxId, label]); return next; },
  async revoke(user, boxId, label) { calls.push(['revoke', user.id, boxId, label]); return next; },
  async projects(user, boxId) { calls.push(['projects', user.id, boxId]); return next; },
  async spaceSync(user, boxId, space) { calls.push(['spaceSync', user.id, boxId, space]); return next; },
  async openTunnel(user, boxId) {
    calls.push(['openTunnel', user.id, boxId]);
    if (tunnelGate) await tunnelGate;
    if (tunnelFailure) throw tunnelFailure;
    const stream = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(t3Port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    opened.push(stream);
    return { stream, port: t3Port };
  },
};

let draining = false;
let httpHangups = 0;
let server: http.Server;
let relayPort = 0;
let base: string;
let wsBase: string;
const relayWss = new WebSocketServer(relayServerOptions());

beforeAll(async () => {
  t3Server = http.createServer((req, res) => {
    // A body the box starts and never finishes: the tunnel goes away mid-way.
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 100_000 });
      res.write(Buffer.alloc(1000));
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastBoxRequest = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 't3=x', 'access-control-allow-origin': 't3code://app' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  t3Server.on('upgrade', async (req, socket, head) => {
    boxUpgrades++;
    const ticket = new URL(req.url ?? '', 'http://x').searchParams.get('wsTicket');
    if (ticket === 'slow' && boxGate) await boxGate;
    if (ticket !== 'good' && ticket !== 'slow') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\nbad ticket');
      return;
    }
    t3Wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null, origin: req.headers.origin ?? null, host: req.headers.host }));
      ws.on('message', (d, isBinary) => {
        if (String(d) === 'close-4000') { ws.close(4000, 'box says bye'); return; }
        ws.send(d, { binary: isBinary });
      });
    });
  });
  await new Promise<void>(r => t3Server.listen(0, '127.0.0.1', () => r()));
  t3Port = (t3Server.address() as AddressInfo).port;

  const app = express();
  app.use((req, res, next) => { if (req.url.includes('/relay/hangup')) res.once('close', () => { httpHangups++; }); next(); });
  app.use('/termag/api/cli/v1/boxes/:id/t3/relay', cliT3RelayRouter({ bearer: cliBearer(bearerDeps), t3 }));
  app.use(express.json());
  app.use('/termag/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, jwt: Promise.resolve(null as never), t3 }));
  server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const target = t3RelayTarget(new URL(req.url ?? '', 'http://x'), '/termag');
    if (!target) { socket.destroy(); return; }
    void handleT3RelayUpgrade(req, socket, head, target, { bearer: bearerDeps, t3, wss: relayWss, isServing: () => !draining, recheckMs });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  relayPort = port;
  base = `http://127.0.0.1:${port}/termag/api/cli/v1`;
  wsBase = `ws://127.0.0.1:${port}/termag/api/cli/v1`;
});

afterAll(async () => {
  for (const s of [server, t3Server]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
});

beforeEach(() => {
  access = { ok: true };
  calls = [];
  next = { status: 200, body: { state: 'ready' } };
  tunnelFailure = null;
  draining = false;
  lastBoxRequest = null;
  opened = [];
  tunnelGate = null;
  boxGate = null;
  boxUpgrades = 0;
  httpHangups = 0;
  clock = now.getTime();
  recheckMs = undefined;
});

/** Poll until `ok` holds; fails the test after `ms`. */
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

/** A raw WebSocket handshake on the relay, so a test can hang up mid-way or send what ws's client won't. */
function rawUpgrade(path: string, extra: Record<string, string> = {}): net.Socket {
  const s = net.connect(relayPort, '127.0.0.1');
  s.on('error', () => {});
  const headers = {
    host: `127.0.0.1:${relayPort}`, upgrade: 'websocket', connection: 'Upgrade',
    'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13', ...device, ...extra,
  };
  s.write(`GET /termag/api/cli/v1${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  return s;
}

const device = { authorization: `Bearer ${DEVICE}` };

describe('the JSON routes', () => {
  it('pass a device sign-in through to the bridge', async () => {
    const ensure = await fetch(`${base}/boxes/box-1/t3/ensure`, { method: 'POST', headers: device });
    expect(ensure.status).toBe(200);
    expect(await ensure.json()).toEqual({ state: 'ready' });
    const pair = await fetch(`${base}/boxes/box-1/t3/pair`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify({ label: ' mbp ' }) });
    expect(pair.status).toBe(200);
    const projects = await fetch(`${base}/boxes/box-1/t3/projects`, { headers: device });
    expect(projects.status).toBe(200);
    expect(calls).toEqual([['ensure', 'alice', 'box-1'], ['pair', 'alice', 'box-1', 'mbp'], ['projects', 'alice', 'box-1']]);
  });

  it('revoke a label, which it needs', async () => {
    const r = await fetch(`${base}/boxes/box-1/t3/revoke`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify({ label: ' termag-desktop 0a1b box-1 ' }) });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['revoke', 'alice', 'box-1', 'termag-desktop 0a1b box-1']]);
    for (const body of [{}, { label: '' }, { label: 'x'.repeat(81) }, { label: 'new\nline' }, { label: 7 }]) {
      const bad = await fetch(`${base}/boxes/box-1/t3/revoke`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(1);
  });

  it('sync a box\'s spaces, all of them or one by name', async () => {
    const post = (body: unknown) => fetch(`${base}/boxes/box-1/spaces/sync`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(200);
    expect((await post({ space: 'platform-team-release' })).status).toBe(200);
    expect(calls).toEqual([['spaceSync', 'alice', 'box-1', undefined], ['spaceSync', 'alice', 'box-1', 'platform-team-release']]);
    for (const space of ['', 'A', 'x'.repeat(41), '../etc', 'team:path', '--json', 7]) {
      const bad = await post({ space });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(2);
  });

  it('update to a release version, which it needs', async () => {
    const r = await fetch(`${base}/boxes/box-1/t3/update`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify({ version: '0.1.14' }) });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['update', 'alice', 'box-1', '0.1.14']]);
    for (const body of [{}, { version: '' }, { version: '0.1' }, { version: '0.1.14-abcdefabcdef' }, { version: '../0.1.14' }, { version: 14 }]) {
      const bad = await fetch(`${base}/boxes/box-1/t3/update`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(1);
  });

  it('refuse a box token with 403 and no token with 401', async () => {
    for (const path of ['/boxes/box-1/t3/ensure', '/boxes/box-1/t3/update', '/boxes/box-1/t3/pair', '/boxes/box-1/t3/revoke', '/boxes/box-1/spaces/sync']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${BOX_TOKEN}` } });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('forbidden');
    }
    expect((await fetch(`${base}/boxes/box-1/t3/projects`)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('check the pairing label', async () => {
    for (const label of ['', '   ', 'x'.repeat(81), 42, 'tab\there', 'emoji 🙂']) {
      const r = await fetch(`${base}/boxes/box-1/t3/pair`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
      expect(r.status).toBe(400);
    }
  });
});

describe('the HTTP relay', () => {
  it('forwards method, path, query and body, swapping in the t3 headers', async () => {
    const r = await fetch(`${base}/boxes/box-1/t3/relay/oauth/token?x=1`, {
      method: 'POST',
      headers: {
        ...device,
        'content-type': 'application/x-www-form-urlencoded',
        'x-t3-authorization': 'Bearer t3-session',
        'x-t3-origin': 't3code://app',
        'x-t3-forwarded-host': '127.0.0.1:47100',
        'x-t3-forwarded-proto': 'http',
        cookie: 'termag.sid=s',
      },
      body: 'grant_type=x&subject_token=y',
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('access-control-allow-origin')).toBe('t3code://app');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(lastBoxRequest).toMatchObject({ method: 'POST', url: '/oauth/token?x=1', body: 'grant_type=x&subject_token=y' });
    expect(lastBoxRequest!.headers).toMatchObject({
      authorization: 'Bearer t3-session', origin: 't3code://app', host: `127.0.0.1:${t3Port}`,
      'x-forwarded-host': '127.0.0.1:47100', 'x-forwarded-proto': 'http',
    });
    expect(lastBoxRequest!.headers.cookie).toBeUndefined();
    expect(calls).toEqual([['access', 'alice', 'box-1'], ['openTunnel', 'alice', 'box-1']]);
  });

  it('passes preflights through to the box', async () => {
    const r = await fetch(`${base}/boxes/box-1/t3/relay/api/auth/session`, { method: 'OPTIONS', headers: { ...device, 'x-t3-origin': 't3code://app' } });
    expect(r.status).toBe(201);
    expect(lastBoxRequest).toMatchObject({ method: 'OPTIONS', url: '/api/auth/session' });
  });

  it('answers the bridge\'s refusals and tunnel failures in the CLI shape', async () => {
    access = { ok: false, status: 404, error: 'No such box', code: 'not_found' };
    let r = await fetch(`${base}/boxes/nope/t3/relay/x`, { headers: device });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'No such box', code: 'not_found' });
    access = { ok: true };
    tunnelFailure = new TunnelError(429, 'too_many_tunnels', 'At most 64');
    r = await fetch(`${base}/boxes/box-1/t3/relay/x`, { headers: device });
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe('too_many_tunnels');
    expect(lastBoxRequest).toBeNull();
  });

  it('drops the tunnel when the client leaves while it opens, and never reaches the box', async () => {
    const g = gate();
    tunnelGate = g.wait;
    const ac = new AbortController();
    const r = fetch(`${base}/boxes/box-1/t3/relay/hangup`, { headers: device, signal: ac.signal }).then(() => 'answered', () => 'aborted');
    await until(() => calls.some(c => c[0] === 'openTunnel'));
    ac.abort();
    expect(await r).toBe('aborted');
    await until(() => httpHangups === 1);
    g.open();
    await until(() => opened.length === 1 && opened[0].destroyed);
    await new Promise(res => setTimeout(res, 30));
    expect(lastBoxRequest).toBeNull();
  });

  it('cuts the client\'s answer short, and drops the tunnel, when the box\'s ends mid-body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Raw http, not fetch: what matters is that the response ends at all.
      const outcome = await new Promise<{ status: number; bytes: number; how: string }>((resolve) => {
        const req = http.get(`${base}/boxes/box-1/t3/relay/cut`, { headers: device }, (res) => {
          let bytes = 0;
          res.on('data', (c: Buffer) => { bytes += c.length; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes, how: 'ended' }));
          res.on('aborted', () => resolve({ status: res.statusCode ?? 0, bytes, how: 'aborted' }));
          res.on('error', () => resolve({ status: res.statusCode ?? 0, bytes, how: 'aborted' }));
        });
        req.on('error', () => resolve({ status: 0, bytes: 0, how: 'request failed' }));
        // Before the fix the answer stayed open: nginx's 1 h timeout in production.
        req.setTimeout(2000, () => { resolve({ status: 0, bytes: 0, how: 'hung' }); req.destroy(); });
      });
      expect(outcome).toEqual({ status: 200, bytes: 1000, how: 'aborted' });
      await until(() => opened.length === 1 && opened[0].destroyed);
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[T3-RELAY]'));
      expect(lines).toEqual(['[T3-RELAY] box=box-1 user=alice response from the box cut short after headers (status 200)']);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs nothing when a whole answer is relayed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await fetch(`${base}/boxes/box-1/t3/relay/x`, { headers: device });
      expect(r.status).toBe(201);
      await r.json();
      await new Promise(res => setTimeout(res, 30));
      expect(warn.mock.calls.filter(c => String(c[0]).startsWith('[T3-RELAY]'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a box token and a missing one', async () => {
    expect((await fetch(`${base}/boxes/box-1/t3/relay/x`, { headers: { authorization: `Bearer ${BOX_TOKEN}` } })).status).toBe(403);
    expect((await fetch(`${base}/boxes/box-1/t3/relay/x`)).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

function openWs(path: string, headers: Record<string, string> = device): Promise<{ ws: InstanceType<typeof WebSocket>; first: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`, { headers });
    ws.once('message', (d) => resolve({ ws, first: JSON.parse(String(d)) }));
    ws.once('unexpected-response', (_q, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

function closeOf(path: string, headers: Record<string, string> = device, protocols?: string[]): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`, protocols, { headers });
    ws.once('error', reject);
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
    ws.once('unexpected-response', (_q, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
}

describe('the WebSocket relay', () => {
  it('reaches the box with the t3 credential and origin, and relays both ways', async () => {
    const { ws, first } = await openWs('/boxes/box-1/t3/relay/ws?wsTicket=good&orchestrationProtocol=2', {
      ...device, 'x-t3-authorization': 'Bearer t3-session', 'x-t3-origin': 't3code://app',
    });
    expect(first).toEqual({ url: '/ws?wsTicket=good&orchestrationProtocol=2', authorization: 'Bearer t3-session', origin: 't3code://app', host: `127.0.0.1:${t3Port}` });
    const echoed = await new Promise<{ text: string; binary: boolean }>((resolve) => {
      ws.once('message', (d, isBinary) => resolve({ text: String(d), binary: isBinary }));
      ws.send(Buffer.from('bytes'), { binary: true });
    });
    expect(echoed).toEqual({ text: 'bytes', binary: true });
    const text = await new Promise<{ text: string; binary: boolean }>((resolve) => {
      ws.once('message', (d, isBinary) => resolve({ text: String(d), binary: isBinary }));
      ws.send('hello');
    });
    expect(text).toEqual({ text: 'hello', binary: false });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    ws.send('close-4000');
    expect(await closed).toEqual({ code: 4000, reason: 'box says bye' });
  });

  it('closes 1012 (redial) once the access token it opened with lapses, never 4401, which t3 takes as final', async () => {
    recheckMs = 10;
    const { token } = await jwt.issue('alice', session.id, clock);
    const { ws } = await openWs('/boxes/box-1/t3/relay/ws?wsTicket=good', { authorization: `Bearer ${token}` });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    clock += 61 * 60_000;
    expect(await closed).toEqual({ code: RELAY_REDIAL_CLOSE_CODE, reason: 'Access token expired; reconnect with a fresh one' });
  });

  it('hands on the box\'s refusal of the handshake', async () => {
    await expect(openWs('/boxes/box-1/t3/relay/ws?wsTicket=bad')).rejects.toMatchObject({ status: 401 });
  });

  it('closes 4409 for a parked box and 1012 (redial) while draining, never t3\'s 4503', async () => {
    access = { ok: false, status: 409, error: 'stopped', code: 'box_not_ready', parked: 'stopped' };
    expect(await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good')).toEqual({ code: 4409, reason: 'box stopped' });
    access = { ok: true };
    draining = true;
    expect((await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good')).code).toBe(RELAY_REDIAL_CLOSE_CODE);
    expect(RELAY_REDIAL_CLOSE_CODE).toBe(1012);
  });

  it('gets those codes to a client that offered subprotocols, too', async () => {
    access = { ok: false, status: 409, error: 'stopped', code: 'box_not_ready', parked: 'stopped' };
    expect(await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good', device, ['t3.v2', 't3.v1'])).toEqual({ code: 4409, reason: 'box stopped' });
    access = { ok: true };
    draining = true;
    expect((await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good', device, ['t3.v2'])).code).toBe(RELAY_REDIAL_CLOSE_CODE);
    draining = false;
    tunnelFailure = new TunnelError(502, 'tunnel_failed', 'no dial-back');
    expect((await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good', device, ['t3.v2'])).code).toBe(1011);
  });

  it('closes 1011 when the tunnel fails, refuses 429 when there are too many', async () => {
    tunnelFailure = new TunnelError(502, 'tunnel_failed', 'no dial-back');
    expect((await closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good')).code).toBe(1011);
    tunnelFailure = new TunnelError(429, 'too_many_tunnels', 'At most 64');
    await expect(closeOf('/boxes/box-1/t3/relay/ws?wsTicket=good')).rejects.toMatchObject({ status: 429 });
  });

  it('drops the tunnel when the client hangs up while it opens, and never dials the box', async () => {
    const g = gate();
    tunnelGate = g.wait;
    const s = rawUpgrade('/boxes/box-1/t3/relay/ws?wsTicket=good');
    await until(() => calls.some(c => c[0] === 'openTunnel'));
    s.resetAndDestroy();
    await new Promise(r => setTimeout(r, 50));
    g.open();
    await until(() => opened.length === 1 && opened[0].destroyed);
    expect(boxUpgrades).toBe(0);
  });

  it('drops the box socket and the tunnel when the client hangs up during the box handshake', async () => {
    const g = gate();
    boxGate = g.wait;
    const s = rawUpgrade('/boxes/box-1/t3/relay/ws?wsTicket=slow');
    await until(() => boxUpgrades === 1);
    s.resetAndDestroy();
    await until(() => opened.length === 1 && opened[0].destroyed);
    g.open();
    await new Promise(r => setTimeout(r, 30));
    expect(t3Wss.clients.size).toBe(0);
  });

  it('refuses a duplicated subprotocol with 400 and closes the tunnel it opened', async () => {
    const s = rawUpgrade('/boxes/box-1/t3/relay/ws?wsTicket=good', { 'sec-websocket-protocol': 't3, t3' });
    const answer = await new Promise<string>((resolve) => {
      let b = '';
      s.on('data', (c) => { b += c; });
      s.on('close', () => resolve(b));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    expect(answer).toContain('"code":"invalid_request"');
    await until(() => opened.length === 1 && opened[0].destroyed);
    expect(boxUpgrades).toBe(0);
  });

  it('closes a client message over the cap with 1009', async () => {
    expect(relayServerOptions().maxPayload).toBe(RELAY_MAX_PAYLOAD_BYTES);
    const { ws } = await openWs('/boxes/box-1/t3/relay/ws?wsTicket=good');
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.on('error', () => {});
    ws.send(Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    await until(() => t3Wss.clients.size === 0);
  });

  it('refuses a box token, a missing token, a token in the URL and a refused box before upgrading', async () => {
    await expect(closeOf('/boxes/box-1/t3/relay/ws', { authorization: `Bearer ${BOX_TOKEN}` })).rejects.toMatchObject({ status: 403 });
    await expect(closeOf('/boxes/box-1/t3/relay/ws', {})).rejects.toMatchObject({ status: 401 });
    await expect(closeOf(`/boxes/box-1/t3/relay/ws?token=${DEVICE}`, {})).rejects.toMatchObject({ status: 400 });
    access = { ok: false, status: 501, error: 'update', code: 'box_outdated' };
    await expect(closeOf('/boxes/box-1/t3/relay/ws')).rejects.toMatchObject({ status: 501 });
  });
});

describe('paths and codes', () => {
  it('t3RelayTarget picks the box and the rest of the path, query included', () => {
    const u = (p: string) => new URL(p, 'http://x');
    expect(t3RelayTarget(u('/termag/api/cli/v1/boxes/b%201/t3/relay/ws?wsTicket=1'), '/termag')).toEqual({ boxId: 'b 1', path: '/ws?wsTicket=1' });
    expect(t3RelayTarget(u('/termag/api/cli/v1/boxes/b1/t3/relay'), '/termag')).toEqual({ boxId: 'b1', path: '/' });
    expect(t3RelayTarget(u('/termag/api/cli/v1/boxes/b1/t3/ensure'), '/termag')).toBeNull();
    expect(t3RelayTarget(u('/api/cli/v1/boxes/b1/t3/relay/ws'), '/termag')).toBeNull();
    expect(t3RelayTarget(u('/api/cli/v1/boxes/b1/t3/relay/ws'), '')).toEqual({ boxId: 'b1', path: '/ws' });
    expect(isAgentTunnelPath('/termag/ws/agent-tunnel', '/termag')).toBe(true);
    expect(isAgentTunnelPath('/termag/ws/agent', '/termag')).toBe(false);
  });

  it('relayCloseCode keeps sendable codes and maps the reserved ones', () => {
    expect(relayCloseCode(1000)).toBe(1000);
    expect(relayCloseCode(4401)).toBe(4401);
    expect(relayCloseCode(1005)).toBeUndefined();
    expect(relayCloseCode(1006)).toBe(1011);
    expect(relayCloseCode(1015)).toBe(1011);
  });
});

describe('relayMessages', () => {
  class Side extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    bufferedAmount = 0;
    paused = 0;
    resumed = 0;
    sent: Buffer[] = [];
    private pending: Array<() => void> = [];
    send(data: Buffer, _opts: unknown, cb?: () => void) {
      this.sent.push(data);
      this.bufferedAmount += data.length;
      this.pending.push(() => { this.bufferedAmount -= data.length; cb?.(); });
    }
    /** The socket takes `n` more of what was sent. */
    flush(n = this.pending.length) { for (const f of this.pending.splice(0, n)) f(); }
    pause() { this.paused++; }
    resume() { this.resumed++; }
  }

  it('pauses the reading side past the high-water mark and resumes it once drained to the low one', () => {
    const from = new Side();
    const to = new Side();
    relayMessages(from as never, to as never, 100, 40);
    from.emit('message', Buffer.alloc(60), true);
    expect(from.paused).toBe(0);
    from.emit('message', Buffer.alloc(60), true);
    expect(from.paused).toBe(1);
    // Already read before the pause took: still sent, not paused twice.
    from.emit('message', Buffer.alloc(10), false);
    expect(to.sent.map(b => b.length)).toEqual([60, 60, 10]);
    expect(from.paused).toBe(1);
    to.flush(1);
    expect(from.resumed).toBe(0);
    to.flush(1);
    expect(from.resumed).toBe(1);
    to.flush();
    expect(from.resumed).toBe(1);
  });

  it('sends nothing once the other side is not open', () => {
    const from = new Side();
    const to = new Side();
    relayMessages(from as never, to as never);
    to.readyState = WebSocket.CLOSING;
    from.emit('message', Buffer.from('x'), true);
    expect(to.sent).toEqual([]);
  });
});

describe('Hangup', () => {
  it('drops what it holds once, newest first; at once after; nothing once disarmed', () => {
    const order: string[] = [];
    const h = new Hangup();
    expect(h.hold(() => order.push('tunnel'))).toBe(true);
    h.hold(() => order.push('box'));
    h.fire();
    h.fire();
    expect(order).toEqual(['box', 'tunnel']);
    expect(h.hold(() => order.push('late'))).toBe(false);
    expect(order).toEqual(['box', 'tunnel', 'late']);
    const d = new Hangup();
    d.hold(() => order.push('upgraded'));
    d.disarm();
    d.fire();
    expect(order).not.toContain('upgraded');
  });
});

describe('the agent tunnel dial-back', () => {
  it('accepts only the box the id was made for, with an agent token, once', async () => {
    let sentId = '';
    const tunnels = new AgentTunnels({ send: async (_b, _t, p) => { sentId = p.tunnelId as string; return { ok: true, port: 1 }; } });
    const tunnelWss = new WebSocketServer({ noServer: true });
    const tokens: Record<string, { token: { scope: string }; instance: { id: string } | null }> = {
      tmag_box1: { token: { scope: 'agent' }, instance: { id: 'box-1' } },
      tmag_box2: { token: { scope: 'agent' }, instance: { id: 'box-2' } },
      tmag_admin: { token: { scope: 'admin' }, instance: { id: 'box-1' } },
    };
    const srv = http.createServer();
    srv.on('upgrade', (req, socket, head) => {
      void handleAgentTunnelUpgrade(req, socket, head, { tunnels, validateAgentToken: async (raw) => tokens[raw] ?? null, wss: tunnelWss });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const at = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/termag/ws/agent-tunnel`;
    const dial = (id: string, token?: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`${at}?id=${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      ws.once('open', () => resolve(101));
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
    });
    try {
      const opening = tunnels.openTunnel('box-1', 'alice');
      await new Promise(r => setTimeout(r, 10));
      expect(await dial('f'.repeat(64), 'tmag_box1')).toBe(404);
      expect(await dial(sentId)).toBe(401);
      expect(await dial(sentId, 'tmag_box2')).toBe(403);
      expect(await dial(sentId, 'tmag_admin')).toBe(403);
      expect(await dial(sentId, 'tmag_box1')).toBe(101);
      const t = await opening;
      expect(t.port).toBe(1);
      t.stream.destroy();
      // Used once: the same id again is unknown.
      expect(await dial(sentId, 'tmag_box1')).toBe(404);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>(r => srv.close(() => r()));
    }
  });
});
