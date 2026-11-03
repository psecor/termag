import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import net, { type AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import type { Duplex } from 'stream';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { default: WebSocket, WebSocketServer } = await import('ws');
const { metrics } = await import('@opentelemetry/api');
const { AggregationTemporality, MeterProvider, MetricReader } = await import('@opentelemetry/sdk-metrics');
const { resetForwardMetricsForTests } = await import('../services/forwardMetrics');
const { sha256Hex } = await import('../services/cliAuth');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');
const { AgentTunnels, tunnelHeartbeat } = await import('../services/agentTunnels');
const { handleAgentTunnelUpgrade, isAgentTunnelPath } = await import('./cliT3');
const {
  createCliForward, forwardMaxConcurrent, forwardServerOptions, forwardTarget, parseForwardPort,
  DEFAULT_FORWARD_MAX_CONCURRENT, FORWARD_MAX_LIFETIME_MS, FORWARD_SUBPROTOCOL, FORWARD_SUBPROTOCOL_V2, FORWARD_TOKEN_CLOSE_CODE,
  FORWARD_OVERDUE_IDLE_MS, FORWARD_RENEWAL_REFUSED_CLOSE_CODE, FORWARD_V1_MAX_LIFETIME_MS, FORWARD_V1_REFUSE_AFTER,
  FORWARD_CONTROL_FRAMES_PER_WINDOW,
} = await import('./cliForward');
type ForwardAccess = import('./cliForward').ForwardAccess;
type CliForward = import('./cliForward').CliForward;

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX_TOKEN = 'tmag_box';
const now = new Date('2026-10-26T00:00:00Z');
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
const cliJwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);
let clockMs = now.getTime();
const bearer = { store, jwt: Promise.resolve(cliJwt), now: () => new Date(clockMs) };
const HB = 50;

// ── the fake agent: what it does with a tunnel-open, per test ─────────────────
type AgentMode =
  | 'echo'          // dial back, echo every message with its flag
  | 'greet'         // dial back and say hello before replying, as SSH and Postgres speak first
  | 'flood'         // dial back and send FLOOD bytes at once
  | 'refused'       // { ok: false, code: 'port_refused', reason }
  | 'closed'        // { ok: false, code: 'port_closed', reason }
  | 'rpc-error'     // the RPC fails (an agent that never answered, say)
  | 'no-dial-back'  // answers ok and never dials back
  | 'gated';        // echo, but dial back only once dialGate opens
let mode: AgentMode;
let dialGate: Promise<void> | null = null;
let rpcs: Array<Record<string, unknown>>;
let agentEnds: Array<InstanceType<typeof WebSocket>>;
let dialedAt: number[];
let tunnelBase = '';
// Past what loopback's kernel buffers take in on both legs (some 20 MB).
const FLOOD = 48 * 1024 * 1024;

async function fakeAgent(_boxId: string, type: string, payload: Record<string, unknown>): Promise<unknown> {
  expect(type).toBe('tunnel-open');
  rpcs.push(payload);
  if (mode === 'refused') return { ok: false, code: 'port_refused', reason: 'port 22 is held by root (uid 0)' };
  if (mode === 'closed') return { ok: false, code: 'port_closed', reason: 'nothing listens on port 4000' };
  if (mode === 'rpc-error') throw new Error('Agent request timed out: tunnel-open');
  if (mode === 'no-dial-back') return { ok: true };
  if (mode === 'gated' && dialGate) await dialGate;
  const ws = new WebSocket(`${tunnelBase}?id=${payload.tunnelId}`, { headers: { authorization: `Bearer ${BOX_TOKEN}` }, perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  dialedAt.push(Date.now());
  agentEnds.push(ws);
  if (mode === 'echo' || mode === 'gated') ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
  if (mode === 'greet') ws.send(Buffer.from('SSH-2.0-box\r\n'), { binary: true });
  if (mode === 'flood') {
    const chunk = Buffer.alloc(64 * 1024, 7);
    for (let i = 0; i < FLOOD / chunk.length; i++) ws.send(chunk, { binary: true });
  }
  return { ok: true };
}

// ── the box's state, as ForwardBoxes reports it ─────────────────────────────
let access: ForwardAccess;
let parked: boolean | 'hangs';
let draining: boolean;
let accessCalls: number;
const boxes = {
  async access(_user: CliUser, _boxId: string) { accessCalls++; return access; },
  async parked() { return parked === 'hangs' ? new Promise<boolean>(() => {}) : parked; },
};

let server: http.Server;
let tunnelWss: InstanceType<typeof WebSocketServer>;
let base = '';
let wsBase = '';
let tunnels: InstanceType<typeof AgentTunnels>;
let forward: CliForward;
let forwardWss: InstanceType<typeof WebSocketServer>;
let logs: string[];

function build(opts: {
  portCap?: number; maxConcurrent?: number; boxDropGraceMs?: number; recheckMs?: number; maxLifetimeMs?: number;
  v1MaxLifetimeMs?: number; v1RefuseAfter?: number;
} = {}) {
  tunnels = new AgentTunnels({ send: fakeAgent, caps: { port: opts.portCap ?? 128 }, ttlMs: 300 });
  forwardWss = new WebSocketServer(forwardServerOptions());
  forward = createCliForward({
    bearer, boxes, tunnels, wss: forwardWss, isServing: () => !draining,
    maxConcurrent: opts.maxConcurrent, heartbeat: (ws) => tunnelHeartbeat(ws, HB), now: Date.now,
    boxDropGraceMs: opts.boxDropGraceMs, recheckMs: opts.recheckMs, maxLifetimeMs: opts.maxLifetimeMs,
    v1MaxLifetimeMs: opts.v1MaxLifetimeMs,
    // Not the real date: these tests mean v1 as it is until the refusal date, whenever they run.
    v1RefuseAfter: opts.v1RefuseAfter ?? Infinity,
  });
}

beforeAll(async () => {
  build();
  tunnelWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const app = express();
  app.use('/termag/api/cli/v1/boxes/:id/forward', (req, res, next) => forward.router()(req, res, next));
  server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://x');
    const target = forwardTarget(url, '/termag');
    if (target) { void forward.upgrade(req, socket, head, target); return; }
    if (isAgentTunnelPath(url.pathname, '/termag')) {
      void handleAgentTunnelUpgrade(req, socket, head, {
        tunnels, wss: tunnelWss, heartbeat: (ws) => tunnelHeartbeat(ws, HB),
        validateAgentToken: async (raw) => (raw === BOX_TOKEN ? { token: { scope: 'agent' }, instance: { id: 'box-1' } } : null),
      });
      return;
    }
    socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/termag/api/cli/v1`;
  wsBase = `ws://127.0.0.1:${port}/termag/api/cli/v1`;
  tunnelBase = `ws://127.0.0.1:${port}/termag/ws/agent-tunnel`;
});

afterAll(async () => {
  for (const c of [...forwardWss.clients, ...tunnelWss.clients]) c.terminate();
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});

beforeEach(() => {
  build();
  mode = 'echo';
  rpcs = [];
  agentEnds = [];
  dialedAt = [];
  access = { ok: true };
  parked = false;
  draining = false;
  accessCalls = 0;
  clockMs = now.getTime();
  session.revokedAt = null;
  bearer.jwt = Promise.resolve(cliJwt);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  return () => vi.restoreAllMocks();
});

const device = { authorization: `Bearer ${DEVICE}` };
// What a box token is told, on the socket and the probe alike: about the forward, not the desktop bridge.
const FORWARD_BOX_ONLY_BODY = {
  code: 'forbidden',
  error: "A box's own credentials can't open a port forward; run `termag forward` on your laptop, signed in with `termag login`",
};

type Dialed =
  // `early`: messages from the moment of the upgrade; the first can come in
  // the same read as the 101, before 'open' has been handled.
  | { kind: 'open'; ws: InstanceType<typeof WebSocket>; at: number; early: string[] }
  | { kind: 'refused'; status: number; body: { error?: string; code?: string } };

/** Dial a forward as the CLI does: the bearer in the header, termag-forward.v1. */
function dial(path: string, opts: { headers?: Record<string, string>; protocols?: string[] } = {}): Promise<Dialed> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`, opts.protocols ?? [FORWARD_SUBPROTOCOL], { headers: opts.headers ?? device, perMessageDeflate: false });
    const early: string[] = [];
    ws.on('message', (d) => { if (early.length < 10) early.push(String(d)); });
    ws.once('open', () => resolve({ kind: 'open', ws, at: Date.now(), early }));
    ws.once('unexpected-response', (_q, res) => {
      let b = '';
      res.on('data', (c: Buffer) => { b += c; });
      res.on('end', () => resolve({ kind: 'refused', status: res.statusCode ?? 0, body: b ? JSON.parse(b) : {} }));
    });
    ws.once('error', reject);
  });
}

async function refusal(path: string, opts?: Parameters<typeof dial>[1]): Promise<[number, string | undefined]> {
  const d = await dial(path, opts);
  if (d.kind === 'open') { d.ws.close(); throw new Error('expected a refusal, got an upgrade'); }
  return [d.status, d.body.code];
}

async function opened(path = '/boxes/box-1/forward/3000'): Promise<InstanceType<typeof WebSocket>> {
  const d = await dial(path);
  if (d.kind !== 'open') throw new Error(`refused: ${d.status} ${d.body.code}`);
  return d.ws;
}

const closeOf = (ws: InstanceType<typeof WebSocket>) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('paths, ports and the ceiling setting', () => {
  it('knows the forward path and nothing else', () => {
    expect(forwardTarget(new URL('http://x/termag/api/cli/v1/boxes/box%2D1/forward/3000'), '/termag')).toEqual({ boxId: 'box-1', port: '3000' });
    expect(forwardTarget(new URL('http://x/termag/api/cli/v1/boxes/b/forward/'), '/termag')).toEqual({ boxId: 'b', port: '' });
    expect(forwardTarget(new URL('http://x/termag/api/cli/v1/boxes/b/forward'), '/termag')).toBeNull();
    expect(forwardTarget(new URL('http://x/termag/api/cli/v1/boxes/b/forward/1/2'), '/termag')).toBeNull();
    expect(forwardTarget(new URL('http://x/termag/api/cli/v1/boxes/b/t3/relay/x'), '/termag')).toBeNull();
  });

  it('takes ports 1 to 65535, written plainly', () => {
    expect([1, 80, 3000, 65535].map(p => parseForwardPort(String(p)))).toEqual([1, 80, 3000, 65535]);
    for (const bad of ['', '0', '65536', '080', '3e3', ' 80', '-1', '1.5', 'abc', '999999']) expect(parseForwardPort(bad), bad).toBeNull();
  });

  it('reads FORWARD_MAX_CONCURRENT, clamped', () => {
    expect(forwardMaxConcurrent({})).toBe(DEFAULT_FORWARD_MAX_CONCURRENT);
    expect(forwardMaxConcurrent({ FORWARD_MAX_CONCURRENT: '250' })).toBe(250);
    for (const bad of ['0', '-5', 'many', '1000000']) expect(forwardMaxConcurrent({ FORWARD_MAX_CONCURRENT: bad })).toBe(DEFAULT_FORWARD_MAX_CONCURRENT);
  });
});

describe('the refusals, in the contract\'s order', () => {
  it('auth first: no bearer 401, a token in the URL 400, then a box token 403 forbidden', async () => {
    expect(await refusal('/boxes/box-1/forward/3000', { headers: {} })).toEqual([401, 'auth_required']);
    expect(await refusal(`/boxes/box-1/forward/3000?token=${DEVICE}`, { headers: {} })).toEqual([400, 'invalid_request']);
    // A box token is refused before the port is even read, in the forward's own words.
    const boxTok = await dial('/boxes/box-1/forward/0', { headers: { authorization: `Bearer ${BOX_TOKEN}` } });
    expect(boxTok).toEqual({ kind: 'refused', status: 403, body: FORWARD_BOX_ONLY_BODY });
    expect(accessCalls).toBe(0);
  });

  it('then the subprotocol and the port, before any box is looked at', async () => {
    expect(await refusal('/boxes/box-1/forward/3000', { protocols: ['something-else'] })).toEqual([400, 'invalid_request']);
    access = { ok: false, status: 404, error: 'No such box', code: 'not_found' };
    for (const p of ['0', '65536', 'http', '080']) expect(await refusal(`/boxes/box-1/forward/${p}`)).toEqual([400, 'bad_port']);
    expect(accessCalls).toBe(0);
  });

  it('then access: not_found (the flag off among them), box_parked, box_not_ready, box_outdated', async () => {
    for (const a of [
      { status: 404, code: 'not_found' }, { status: 409, code: 'box_parked' }, { status: 409, code: 'box_not_ready' }, { status: 501, code: 'box_outdated' },
    ]) {
      access = { ok: false, error: 'no', ...a };
      // Draining too: access comes first.
      draining = true;
      expect(await refusal('/boxes/box-1/forward/3000')).toEqual([a.status, a.code]);
    }
    expect(rpcs).toEqual([]);
  });

  it('then draining 503, then the cap 429, never reaching the agent', async () => {
    draining = true;
    expect(await refusal('/boxes/box-1/forward/3000')).toEqual([503, 'draining']);
    draining = false;
    build({ portCap: 1 });
    const first = await opened();
    draining = true;
    expect(await refusal('/boxes/box-1/forward/3001')).toEqual([503, 'draining']);
    draining = false;
    expect(await refusal('/boxes/box-1/forward/3001')).toEqual([429, 'too_many_tunnels']);
    expect(rpcs).toHaveLength(1);
    first.close(1000);
  });

  it("then the agent's verdicts: port_refused with its reason, port_closed, tunnel_failed for a failed RPC or no dial-back", async () => {
    mode = 'refused';
    const d = await dial('/boxes/box-1/forward/22');
    expect(d).toEqual({ kind: 'refused', status: 403, body: { code: 'port_refused', error: 'port 22 is held by root (uid 0)' } });
    expect(rpcs[0]).toMatchObject({ target: { kind: 'port', port: 22 } });
    mode = 'closed';
    expect(await refusal('/boxes/box-1/forward/4000')).toEqual([502, 'port_closed']);
    mode = 'rpc-error';
    expect(await refusal('/boxes/box-1/forward/4000')).toEqual([502, 'tunnel_failed']);
    mode = 'no-dial-back';
    expect(await refusal('/boxes/box-1/forward/4000')).toEqual([502, 'tunnel_failed']);
    expect(forward.active()).toBe(0);
  });

  it('logs each refusal with its code, and never a token', async () => {
    access = { ok: false, status: 404, error: 'No such box', code: 'not_found' };
    await refusal('/boxes/box-1/forward/3000');
    await refusal('/boxes/box-1/forward/3000', { headers: { authorization: `Bearer ${BOX_TOKEN}` } });
    expect(logs.filter(l => l.startsWith('[FORWARD]'))).toEqual([
      '[FORWARD] refused user=alice box=box-1 port=3000 status=404 code=not_found',
      '[FORWARD] refused user=alice box=box-1 port=- status=403 code=forbidden',
    ]);
    expect(logs.join('\n')).not.toContain('tmcli_');
  });
});

describe('the relay', () => {
  it('upgrades the client only once the box end has dialed back', async () => {
    const d = await dial('/boxes/box-1/forward/3000');
    expect(d.kind).toBe('open');
    if (d.kind !== 'open') return;
    expect(dialedAt).toHaveLength(1);
    expect(d.at).toBeGreaterThanOrEqual(dialedAt[0]);
    expect(d.ws.protocol).toBe(FORWARD_SUBPROTOCOL);
    d.ws.close(1000);
  });

  it('passes every message untouched both ways, binary as binary and text (a fin) as text', async () => {
    const ws = await opened();
    const got: Array<{ data: string; binary: boolean }> = [];
    ws.on('message', (d, isBinary) => got.push({ data: Buffer.from(d as Buffer).toString('latin1'), binary: isBinary }));
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    ws.send(bytes, { binary: true });
    ws.send('{"t":"fin"}');
    ws.send(Buffer.from('{"t":"fin"}'), { binary: true });
    await until(() => got.length === 3);
    expect(got).toEqual([
      { data: bytes.toString('latin1'), binary: true },
      { data: '{"t":"fin"}', binary: false },
      { data: '{"t":"fin"}', binary: true },
    ]);
    ws.close(1000);
  });

  it('loses nothing a server says before the client is upgraded', async () => {
    mode = 'greet';
    const d = await dial('/boxes/box-1/forward/22');
    if (d.kind !== 'open') throw new Error('refused');
    await until(() => d.early.length > 0);
    expect(d.early[0]).toBe('SSH-2.0-box\r\n');
    d.ws.close(1000);
  });

  it('holds the box end while the client reads nothing, for many heartbeats, then delivers every byte', { timeout: 30_000 }, async () => {
    mode = 'flood';
    const ws = await opened();
    let got = 0;
    ws.on('message', (d) => { got += (d as Buffer).length; });
    // The laptop stops reading: its TCP socket fills, the relay pauses the box end.
    (ws as unknown as { _socket: import('net').Socket })._socket.pause();
    await new Promise(r => setTimeout(r, 12 * HB));
    const agent = agentEnds[0];
    // Backpressure reached the box: most of what it sent still waits on its side.
    expect(agent.bufferedAmount).toBeGreaterThan(FLOOD / 3);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(agent.readyState).toBe(WebSocket.OPEN);
    (ws as unknown as { _socket: import('net').Socket })._socket.resume();
    await until(() => got === FLOOD, 20_000);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close(1000);
  });

  it('passes 1000 and 1011 through, both ways', async () => {
    for (const code of [1000, 1011]) {
      const ws = await opened();
      const agentClosed = closeOf(agentEnds.at(-1)!);
      ws.close(code);
      expect(await agentClosed).toBe(code);
    }
    for (const code of [1000, 1011]) {
      const ws = await opened();
      const clientClosed = closeOf(ws);
      agentEnds.at(-1)!.close(code);
      expect(await clientClosed).toBe(code);
    }
  });

  it('closes with 4409 when the box end drops because the box parked, and 1011 otherwise', async () => {
    let ws = await opened();
    let closed = closeOf(ws);
    agentEnds.at(-1)!.terminate();
    expect(await closed).toBe(1011);
    parked = true;
    ws = await opened();
    closed = closeOf(ws);
    agentEnds.at(-1)!.terminate();
    expect(await closed).toBe(4409);
  });

  // An unmasked frame from the agent: the box end emits 'error', then 'close'.
  const breakBoxEnd = (agent: InstanceType<typeof WebSocket>) => (agent as unknown as { _socket: Duplex })._socket.write(Buffer.from([0x82, 0x00]));

  it('still says 4409 when the box end fails with an error before it closes', async () => {
    parked = true;
    const ws = await opened();
    const closed = closeOf(ws);
    breakBoxEnd(agentEnds.at(-1)!);
    expect(await closed).toBe(4409);
  });

  it('ends the client anyway when the parked check after a box error never answers', async () => {
    build({ boxDropGraceMs: 100 });
    parked = 'hangs';
    const ws = await opened();
    const closed = closeOf(ws);
    const at = Date.now();
    breakBoxEnd(agentEnds.at(-1)!);
    expect(await closed).toBe(1006);
    expect(Date.now() - at).toBeLessThan(2000);
    await until(() => forward.active() === 0);
  });

  it("outlives its access token's exp, and still closes 1008 when the sign-in is revoked", async () => {
    build({ recheckMs: 10 });
    const { token } = await cliJwt.issue('alice', session.id, clockMs);
    const d = await dial('/boxes/box-1/forward/3000', { headers: { authorization: `Bearer ${token}` } });
    if (d.kind !== 'open') throw new Error(`refused: ${d.status} ${d.body.code}`);
    const ws = d.ws;
    let code: number | null = null;
    ws.once('close', (c) => { code = c; });
    clockMs += 61 * 60_000;
    // Many rechecks past the token's exp: still open, and still relaying.
    await new Promise(r => setTimeout(r, 100));
    expect(code).toBeNull();
    const echoed = await new Promise<string>((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send('still here'); });
    expect(echoed).toBe('still here');
    session.revokedAt = new Date(clockMs);
    await until(() => code !== null);
    expect(code).toBe(1008);
  });

  it('closes v1 with 4408 at its own, shorter cap, both legs, and frees the slots', async () => {
    expect(FORWARD_V1_MAX_LIFETIME_MS).toBe(2 * 60 * 60 * 1000);
    // v2's cap is far off: v1 is held to its own.
    build({ v1MaxLifetimeMs: 150, maxLifetimeMs: 60_000 });
    const ws = await opened();
    const agent = agentEnds.at(-1)!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    const agentClosed = closeOf(agent);
    // Still relaying before the cap.
    const echoed = await new Promise<string>((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send('before'); });
    expect(echoed).toBe('before');
    expect(await closed).toEqual({ code: 4408, reason: 'This forward reached its 2 h limit; reconnect' });
    expect(await agentClosed).toBe(1011);
    await until(() => forward.active() === 0 && tunnels.count('alice', 'box-1', 'port') === 0);
  });

  it('closes 4401 once the signing key its token was signed with is retired', async () => {
    build({ recheckMs: 10 });
    const { token } = await cliJwt.issue('alice', session.id, clockMs);
    const d = await dial('/boxes/box-1/forward/3000', { headers: { authorization: `Bearer ${token}` } });
    if (d.kind !== 'open') throw new Error(`refused: ${d.status} ${d.body.code}`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => d.ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    // The orchestrator now publishes only a new key: the old one is retired.
    bearer.jwt = Promise.resolve(new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]));
    expect(await closed).toEqual({ code: 4401, reason: 'Access token no longer valid; reconnect with a fresh one' });
  });

  it('logs the open and the close with bytes each way, duration and code, and no payload', async () => {
    const ws = await opened('/boxes/box-1/forward/3456');
    const echoed = new Promise((resolve) => ws.once('message', resolve));
    ws.send('top secret payload');
    await echoed;
    const closed = closeOf(agentEnds[0]);
    ws.close(1000);
    await closed;
    await until(() => logs.some(l => l.startsWith('[FORWARD] close') && l.includes('port=3456')));
    const lines = logs.filter(l => l.startsWith('[FORWARD]') && l.includes('port=3456'));
    expect(lines[0]).toMatch(/^\[FORWARD\] open user=alice box=box-1 port=3456 protocol=v1 setupMs=\d+$/);
    expect(lines[1]).toMatch(/^\[FORWARD\] close user=alice box=box-1 port=3456 bytesIn=18 bytesOut=18 durationMs=\d+ code=1000$/);
    expect(logs.join('\n')).not.toContain('top secret');
  });
});

describe('v2: the access token renewed in band', () => {
  const BOTH = [FORWARD_SUBPROTOCOL_V2, FORWARD_SUBPROTOCOL];
  type Ws = InstanceType<typeof WebSocket>;
  const closing = (ws: Ws) => new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  const echo = (ws: Ws, text: string) => new Promise<string>((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send(Buffer.from(text), { binary: true }); });
  const tokenFrame = (token: string) => JSON.stringify({ t: 'token', token });

  /** A v2 forward opened with an access token issued at `issuedAt`; `boxGot` is every frame the box end received. */
  async function openV2(issuedAt = clockMs, protocols = BOTH) {
    const { token } = await cliJwt.issue('alice', session.id, issuedAt);
    const d = await dial('/boxes/box-1/forward/3000', { headers: { authorization: `Bearer ${token}` }, protocols });
    if (d.kind !== 'open') throw new Error(`refused: ${d.status} ${d.body.code}`);
    const boxGot: Array<{ data: string; binary: boolean }> = [];
    agentEnds.at(-1)!.on('message', (m, isBinary) => boxGot.push({ data: String(m), binary: isBinary }));
    return { ws: d.ws, boxGot, closed: closing(d.ws), agentClosed: closeOf(agentEnds.at(-1)!) };
  }

  it('is picked over v1 when both are offered; v1 alone still gets v1', async () => {
    const both = await dial('/boxes/box-1/forward/3000', { protocols: BOTH });
    const v1 = await dial('/boxes/box-1/forward/3001');
    if (both.kind !== 'open' || v1.kind !== 'open') throw new Error('refused');
    expect([both.ws.protocol, v1.ws.protocol]).toEqual([FORWARD_SUBPROTOCOL_V2, FORWARD_SUBPROTOCOL]);
    expect(await refusal('/boxes/box-1/forward/3000', { protocols: ['termag-forward.v3'] })).toEqual([400, 'invalid_request']);
    const closed = closeOf(agentEnds[0]);
    both.ws.close(1000);
    v1.ws.close(1000);
    await closed;
    await until(() => logs.filter(l => l.startsWith('[FORWARD] open')).length === 2);
    expect(logs.filter(l => l.startsWith('[FORWARD] open')).map(l => /protocol=(v\d)/.exec(l)?.[1])).toEqual(['v2', 'v1']);
  });

  it('outlives the first token once a fresh one arrives, then closes 4402 when that one expires unrenewed', async () => {
    build({ recheckMs: 10 });
    const f = await openV2();
    let code: number | null = null;
    f.ws.once('close', (c) => { code = c; });
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs + 30 * 60_000);
    f.ws.send(tokenFrame(fresh));
    expect(await echo(f.ws, 'after the renewal')).toBe('after the renewal');
    // Past the first token's exp, inside the fresh one's: many rechecks, still open.
    clockMs += 61 * 60_000;
    await new Promise(r => setTimeout(r, 100));
    expect(code).toBeNull();
    expect(await echo(f.ws, 'still here')).toBe('still here');
    // Past the fresh one's too.
    clockMs += 30 * 60_000;
    expect((await f.closed).code).toBe(FORWARD_TOKEN_CLOSE_CODE);
    expect(await f.agentClosed).toBe(1011);
    // The box end saw the bytes and nothing of the token.
    expect(f.boxGot).toEqual([{ data: 'after the renewal', binary: true }, { data: 'still here', binary: true }]);
  });

  it('closes both legs with 4402 at the token\'s exp when no fresh one came, on its own deadline', async () => {
    // Opened a second before its token's exp; the recheck (60 s) never runs.
    const f = await openV2(clockMs - 60 * 60_000 + 1000);
    const at = Date.now();
    clockMs += 2000;
    expect(await f.closed).toEqual({ code: FORWARD_TOKEN_CLOSE_CODE, reason: 'Access token expired and was not renewed; reconnect' });
    expect(Date.now() - at).toBeLessThan(2500);
    expect(await f.agentClosed).toBe(1011);
    await until(() => forward.active() === 0 && tunnels.count('alice', 'box-1', 'port') === 0);
  });

  it('works when opened with a nearly expired token that is renewed in time', async () => {
    const f = await openV2(clockMs - 60 * 60_000 + 1000);
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs);
    f.ws.send(tokenFrame(fresh));
    clockMs += 2000;
    await new Promise(r => setTimeout(r, 1500));
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    expect(await echo(f.ws, 'renewed')).toBe('renewed');
    f.ws.close(1000);
    expect(await f.agentClosed).toBe(1000);
  });

  it('refuses a token for another device sign-in or user, an expired one, or no JWT, with 4406 (not 4402) and no falling back', async () => {
    const other = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);
    for (const token of [
      (await cliJwt.issue('alice', 's2', clockMs)).token,
      (await cliJwt.issue('bob', session.id, clockMs)).token,
      (await cliJwt.issue('alice', session.id, clockMs - 61 * 60_000)).token,
      (await other.issue('alice', session.id, clockMs)).token,
      DEVICE,
    ]) {
      const f = await openV2();
      f.ws.send(tokenFrame(token));
      expect(await f.closed).toEqual({ code: FORWARD_RENEWAL_REFUSED_CLOSE_CODE, reason: 'Renewed access token refused (another sign-in, or not valid); reconnect' });
      expect(await f.agentClosed).toBe(1011);
      expect(f.boxGot).toEqual([]);
    }
  });

  it('relays a fin to the box but never a token or any other text frame; an unknown one closes 1002', async () => {
    const f = await openV2();
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs);
    f.ws.send(tokenFrame(fresh));
    f.ws.send(Buffer.from(tokenFrame(fresh)), { binary: true });
    f.ws.send('{"t":"fin"}');
    await until(() => f.boxGot.length === 2);
    // A token as binary is the laptop's bytes: relayed as they are.
    expect(f.boxGot).toEqual([{ data: tokenFrame(fresh), binary: true }, { data: '{"t":"fin"}', binary: false }]);
    for (const text of ['{"t":"hello"}', 'not json', `{"t":"token","token":"${'x'.repeat(20_000)}"}`]) {
      const g = await openV2();
      g.ws.send(text);
      // Past 16 KiB a frame isn't even parsed: no JWT is that long.
      expect((await g.closed).code).toBe(1002);
      expect(g.boxGot).toEqual([]);
    }
    f.ws.close(1000);
  });

  it('keeps the recheck: a revoked sign-in still closes 1008, and a retired key 4402', async () => {
    build({ recheckMs: 10 });
    let f = await openV2();
    session.revokedAt = new Date(clockMs);
    expect((await f.closed).code).toBe(1008);
    session.revokedAt = null;
    f = await openV2();
    bearer.jwt = Promise.resolve(new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]));
    expect((await f.closed).code).toBe(FORWARD_TOKEN_CLOSE_CODE);
  });

  // ── a client leg the relay holds paused at its token's exp (Bugbot on #965) ──
  /** The server's end of the client leg, to see the relay pause it. */
  const serverLeg = () => [...forwardWss.clients].at(-1)!;
  const agentSocket = (agent: Ws) => (agent as unknown as { _socket: import('net').Socket })._socket;
  /** Stop the box end reading, then upload until the relay pauses the client leg; the rest waits on the laptop. */
  async function pauseClientLeg(f: Awaited<ReturnType<typeof openV2>>) {
    agentSocket(agentEnds.at(-1)!).pause();
    const chunk = Buffer.alloc(64 * 1024, 1);
    for (let i = 0; i < 24 * 16 && !serverLeg().isPaused; i++) {
      f.ws.send(chunk, { binary: true });
      if (i % 16 === 15) await new Promise(r => setTimeout(r, 20));
    }
    await until(() => serverLeg().isPaused, 5000);
  }

  it('keeps a leg paused at exp until it reads the renewal queued behind its data', { timeout: 20_000 }, async () => {
    const f = await openV2(clockMs - 60 * 60_000 + 1000);
    await pauseClientLeg(f);
    // The CLI renewed in time, but the frame waits behind the upload.
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs);
    f.ws.send(tokenFrame(fresh));
    clockMs += 2000;
    // Well past exp, still paused: not judged yet.
    await new Promise(r => setTimeout(r, 1500));
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    // The box reads again: the queue drains, the renewal is read, and the forward lives on.
    agentSocket(agentEnds.at(-1)!).resume();
    await until(() => !serverLeg().isPaused && f.ws.bufferedAmount === 0, 10_000);
    await new Promise(r => setTimeout(r, FORWARD_OVERDUE_IDLE_MS + 1000));
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    f.ws.close(1000);
    await until(() => forward.active() === 0, 10_000);
  });

  it('still closes a leg paused at exp with no renewal 4402, once it reads again and finds none', { timeout: 20_000 }, async () => {
    const f = await openV2(clockMs - 60 * 60_000 + 1000);
    await pauseClientLeg(f);
    clockMs += 2000;
    await new Promise(r => setTimeout(r, 1500));
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    const resumedAt = Date.now();
    agentSocket(agentEnds.at(-1)!).resume();
    expect(await f.closed).toEqual({ code: FORWARD_TOKEN_CLOSE_CODE, reason: 'Access token expired and was not renewed; reconnect' });
    expect(Date.now() - resumedAt).toBeLessThan(8000);
    await until(() => forward.active() === 0, 10_000);
  });

  it('counts only the bytes it relays: a renewal is no upload, in the close log and termag.forward.bytes', async () => {
    class Reader extends MetricReader {
      constructor() { super({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA }); }
      protected async onForceFlush(): Promise<void> {}
      protected async onShutdown(): Promise<void> {}
    }
    const reader = new Reader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    resetForwardMetricsForTests();
    const f = await openV2();
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs);
    f.ws.send(tokenFrame(fresh));
    expect(await echo(f.ws, 'five!')).toBe('five!');
    f.ws.close(1000);
    await f.agentClosed;
    await until(() => logs.some(l => l.startsWith('[FORWARD] close')));
    expect(logs.find(l => l.startsWith('[FORWARD] close'))).toMatch(/ bytesIn=5 bytesOut=5 /);
    const { resourceMetrics } = await reader.collect();
    const bytes = resourceMetrics.scopeMetrics.flatMap(m => m.metrics).filter(m => m.descriptor.name === 'termag.forward.bytes').flatMap(m => m.dataPoints);
    expect(bytes.map(p => [p.attributes['termag.forward.direction'], p.value]).sort()).toEqual([['down', 5], ['up', 5]]);
    metrics.disable();
    resetForwardMetricsForTests();
  });

  // ── what a control frame may cost (Cursor Security Agent on #965) ──
  it('ignores a token frame for the token it holds without verifying it, and verifies a renewal once', async () => {
    const f = await openV2();
    await new Promise(r => setTimeout(r, 50));
    const verify = vi.spyOn(cliJwt, 'verify');
    const held = String((await cliJwt.issue('alice', session.id, clockMs)).token);
    // The token it was opened with is the one openV2 issued at clockMs: the same bytes.
    for (let i = 0; i < 5; i++) f.ws.send(tokenFrame(held));
    expect(await echo(f.ws, 'still')).toBe('still');
    expect(verify).not.toHaveBeenCalled();
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs + 60_000);
    f.ws.send(tokenFrame(fresh));
    expect(await echo(f.ws, 'renewed')).toBe('renewed');
    await new Promise(r => setTimeout(r, 50));
    expect(verify).toHaveBeenCalledTimes(1);
    f.ws.close(1000);
  });

  it('closes 4406 for a second renewal sooner than the minimum interval, without verifying it', async () => {
    const f = await openV2();
    const { token: a } = await cliJwt.issue('alice', session.id, clockMs + 1000);
    const { token: b } = await cliJwt.issue('alice', session.id, clockMs + 2000);
    f.ws.send(tokenFrame(a));
    expect(await echo(f.ws, 'one')).toBe('one');
    const verify = vi.spyOn(cliJwt, 'verify');
    f.ws.send(tokenFrame(b));
    expect(await f.closed).toEqual({ code: FORWARD_RENEWAL_REFUSED_CLOSE_CODE, reason: 'Renewals too frequent' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('closes 4406 past the control-frame budget, and parses nothing past it', async () => {
    const f = await openV2();
    const { token } = await cliJwt.issue('alice', session.id, clockMs);
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < FORWARD_CONTROL_FRAMES_PER_WINDOW + 50; i++) f.ws.send(tokenFrame(token));
    expect(await f.closed).toEqual({ code: FORWARD_RENEWAL_REFUSED_CLOSE_CODE, reason: 'Too many control frames' });
    expect(parse.mock.calls.filter(([t]) => typeof t === 'string' && t.includes('"t":"token"')).length).toBeLessThanOrEqual(FORWARD_CONTROL_FRAMES_PER_WINDOW);
  });

  it('never logs a token, the one it opened with or a renewal', async () => {
    const { token: first } = await cliJwt.issue('alice', session.id, clockMs);
    const d = await dial('/boxes/box-1/forward/3000', { headers: { authorization: `Bearer ${first}` }, protocols: BOTH });
    if (d.kind !== 'open') throw new Error('refused');
    const { token: fresh } = await cliJwt.issue('alice', session.id, clockMs + 60_000);
    d.ws.send(tokenFrame(fresh));
    expect(await echo(d.ws, 'x')).toBe('x');
    // And a refused one.
    const g = await openV2();
    const { token: other } = await cliJwt.issue('alice', 's2', clockMs);
    g.ws.send(tokenFrame(other));
    await g.closed;
    const closed = closeOf(agentEnds[0]);
    d.ws.close(1000);
    await closed;
    await until(() => logs.filter(l => l.startsWith('[FORWARD] close')).length === 2);
    const all = logs.join('\n');
    for (const t of [first, fresh, other]) {
      expect(all).not.toContain(t);
      expect(all).not.toContain(t.split('.')[2]);
    }
    expect(all).not.toContain('eyJ');
  });

  it('refuses a v1-only upgrade from FORWARD_V1_REFUSE_AFTER, with the words an old CLI prints; v2 is unaffected', async () => {
    expect(new Date(FORWARD_V1_REFUSE_AFTER).toISOString()).toBe('2026-11-19T00:00:00.000Z');
    build({ v1RefuseAfter: Date.now() - 1 });
    const d = await dial('/boxes/box-1/forward/3000');
    expect(d).toEqual({ kind: 'refused', status: 426, body: { code: 'cli_outdated', error: 'This termag is too old for the forward: run `termag update`' } });
    expect(rpcs).toEqual([]);
    const v2 = await dial('/boxes/box-1/forward/3000', { protocols: BOTH });
    expect(v2.kind === 'open' && v2.ws.protocol).toBe(FORWARD_SUBPROTOCOL_V2);
    if (v2.kind === 'open') v2.ws.close(1000);
    // Before the date, v1 still opens.
    build({ v1RefuseAfter: Date.now() + 60_000 });
    const before = await dial('/boxes/box-1/forward/3001');
    expect(before.kind === 'open' && before.ws.protocol).toBe(FORWARD_SUBPROTOCOL);
    if (before.kind === 'open') before.ws.close(1000);
  });

  it('keeps the 12 h cap as a backstop, not v1\'s 2 h', async () => {
    build({ maxLifetimeMs: 150, v1MaxLifetimeMs: 60_000 });
    const f = await openV2();
    expect(await f.closed).toEqual({ code: 4408, reason: 'This forward reached its 12 h limit; reconnect' });
  });
});

describe('a client gone while its tunnel opens', () => {
  it('ends a laptop connection that half-closed meanwhile, instead of leaving it to TCP', async () => {
    let open!: () => void;
    dialGate = new Promise<void>((r) => { open = r; });
    mode = 'gated';
    const port = Number(new URL(base).port);
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    let answered = '';
    s.on('data', (d) => { answered += d; });
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write([
      'GET /termag/api/cli/v1/boxes/box-1/forward/3000 HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: ${FORWARD_SUBPROTOCOL}`,
      `Authorization: Bearer ${DEVICE}`, '', '',
    ].join('\r\n'));
    await until(() => rpcs.length === 1);
    // The laptop's side goes away for writing (a half-closed connection), while the box is still dialing back.
    s.end();
    await new Promise(r => setTimeout(r, 50));
    open();
    const outcome = await new Promise<string>((resolve) => {
      s.once('close', () => resolve('closed'));
      setTimeout(() => resolve('left open'), 1500);
    });
    expect(outcome).toBe('closed');
    // Never upgraded, and nothing held for it.
    expect(answered).not.toContain('101');
    await until(() => forward.active() === 0);
    await until(() => agentEnds.length === 1 && agentEnds[0].readyState === WebSocket.CLOSED);
    s.destroy();
    dialGate = null;
  });
});

describe('limits', () => {
  it('caps one user\'s forwards to one box, and frees the slot when one closes', async () => {
    build({ portCap: 2 });
    const a = await opened();
    const b = await opened();
    expect(await refusal('/boxes/box-1/forward/3000')).toEqual([429, 'too_many_tunnels']);
    const freed = closeOf(agentEnds[0]);
    a.close(1000);
    await freed;
    await until(() => tunnels.count('alice', 'box-1', 'port') === 1);
    const c = await opened();
    b.close(1000);
    c.close(1000);
  });

  it('holds the process to its ceiling, all users together', async () => {
    build({ maxConcurrent: 1 });
    const a = await opened();
    expect(forward.active()).toBe(1);
    const d = await dial('/boxes/box-1/forward/3000');
    expect(d).toMatchObject({ kind: 'refused', status: 429, body: { code: 'too_many_tunnels' } });
    const freed = closeOf(agentEnds[0]);
    a.close(1000);
    await freed;
    await until(() => forward.active() === 0);
    (await opened()).close(1000);
  });
});

describe('drain', () => {
  it('closes live forwards with 1012, as index.ts closeSockets does, and the box end with 1011', async () => {
    const ws = await opened();
    const clientClosed = closeOf(ws);
    const agentClosed = closeOf(agentEnds[0]);
    draining = true;
    for (const c of forwardWss.clients) c.close(1012, 'draining');
    expect(await clientClosed).toBe(1012);
    expect(await agentClosed).toBe(1011);
    expect(await refusal('/boxes/box-1/forward/3000')).toEqual([503, 'draining']);
  });
});

describe('shutdown', () => {
  it('logs each live forward\'s close at once, with the shutdown code, before any handshake ends; and only once', async () => {
    const ws = await opened();
    await new Promise<string>((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send('hello'); });
    const clientClosed = closeOf(ws);
    const agentClosed = closeOf(agentEnds[0]);
    forward.closeAll(1001, 'server shutting down');
    // Synchronously: the process exits before the close handshakes end.
    const closes = () => logs.filter(l => l.startsWith('[FORWARD] close'));
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toMatch(/^\[FORWARD\] close user=alice box=box-1 port=3000 bytesIn=5 bytesOut=5 durationMs=\d+ code=1001$/);
    expect(await clientClosed).toBe(1001);
    expect(await agentClosed).toBe(1001);
    await until(() => forward.active() === 0);
    expect(closes()).toHaveLength(1);
    forward.closeAll(1001, 'server shutting down');
    expect(closes()).toHaveLength(1);
  });

  it('logs a forward whose client already closed with the client\'s own code, not the shutdown\'s', async () => {
    const ws = await opened();
    await new Promise<string>((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send('hello'); });
    // A paused box end can't finish its close handshake, so the box leg is still open at shutdown.
    agentEnds[0].pause();
    const clientClosed = closeOf(ws);
    ws.close(1000);
    expect(await clientClosed).toBe(1000);
    const closes = () => logs.filter(l => l.startsWith('[FORWARD] close'));
    await new Promise(r => setTimeout(r, 50));
    expect(closes()).toHaveLength(0);
    forward.closeAll(1001, 'server shutting down');
    expect(closes()).toHaveLength(1);
    expect(closes()[0]).toMatch(/ code=1000$/);
    agentEnds[0].resume();
  });
});

describe('the probe', () => {
  const probe = (headers: Record<string, string> = device) => fetch(`${base}/boxes/box-1/forward`, { headers });

  it('answers ok, the capability and the per-box cap', async () => {
    const r = await probe();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, capability: 'port-forward-v1', maxConnections: 128 });
  });

  it('refuses as the socket does: 401, box token 403, access, draining', async () => {
    expect((await probe({})).status).toBe(401);
    const boxTok = await probe({ authorization: `Bearer ${BOX_TOKEN}` });
    expect([boxTok.status, await boxTok.json()]).toEqual([403, FORWARD_BOX_ONLY_BODY]);
    access = { ok: false, status: 404, error: 'No such box', code: 'not_found' };
    const off = await probe();
    expect([off.status, await off.json()]).toEqual([404, { error: 'No such box', code: 'not_found' }]);
    access = { ok: true };
    draining = true;
    const d = await probe();
    expect([d.status, (await d.json()).code]).toEqual([503, 'draining']);
    expect(logs.filter(l => l.startsWith('[FORWARD] refused probe'))).toHaveLength(3);
  });

  it('answers a plain GET of the socket path with 426', async () => {
    const r = await fetch(`${base}/boxes/box-1/forward/3000`, { headers: device });
    expect([r.status, (await r.json()).code]).toEqual([426, 'upgrade_required']);
  });
});
