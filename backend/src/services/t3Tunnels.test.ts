import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net, { type AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentTunnels, TunnelError, socketLikeStream, tunnelHeartbeat } from './agentTunnels';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});

/** Where an agent's dial-back lands: hands the socket to the registry as index.ts does. */
async function dialBackEndpoint(tunnels: AgentTunnels, tokenBox: (auth: string | undefined) => string | null) {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!tunnels.accept(id, tokenBox(req.headers.authorization), ws)) ws.close(1008, 'unknown tunnel');
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A t3 server stand-in that echoes the request line. */
async function echoServer() {
  const server = http.createServer((req, res) => { res.end(`${req.method} ${req.url} ${req.headers.host}`); });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** An agent: on tunnel-open, connect to the t3 port, then dial back with its token. */
function fakeAgent(base: () => string, t3Port: () => number, token = 'tmag_box') {
  return async (_box: string, type: string, payload: Record<string, unknown>) => {
    expect(type).toBe('tunnel-open');
    expect(payload.target).toBe('t3');
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(t3Port(), '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const ws = new WebSocket(`${base()}/termag/ws/agent-tunnel?id=${payload.tunnelId}`, { headers: { authorization: `Bearer ${token}` } });
    ws.on('message', (d) => sock.write(d as Buffer));
    sock.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
    sock.on('close', () => ws.close());
    ws.on('close', () => sock.destroy());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ok: true, port: t3Port() };
  };
}

describe('AgentTunnels', () => {
  it('opens a tunnel the agent dials back on, and HTTP runs over it', async () => {
    const port = await echoServer();
    let base = '';
    const tunnels = new AgentTunnels({ send: fakeAgent(() => base, () => port) });
    base = await dialBackEndpoint(tunnels, (auth) => (auth === 'Bearer tmag_box' ? 'box-1' : null));
    const t = await tunnels.openTunnel('box-1', 'alice');
    expect(t.port).toBe(port);
    expect(tunnels.count('alice', 'box-1')).toBe(1);
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ createConnection: () => t.stream as unknown as net.Socket, path: '/.well-known/t3/environment', headers: { host: `127.0.0.1:${port}`, connection: 'close' } }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe(`GET /.well-known/t3/environment 127.0.0.1:${port}`);
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1') > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(tunnels.count('alice', 'box-1')).toBe(0);
  });

  it('refuses a dial-back from another box, once', async () => {
    const port = await echoServer();
    let base = '';
    const tunnels = new AgentTunnels({ send: fakeAgent(() => base, () => port) });
    base = await dialBackEndpoint(tunnels, () => 'box-2');
    await expect(tunnels.openTunnel('box-1', 'alice')).rejects.toMatchObject({ code: 'tunnel_failed' });
  });

  it('times out when no dial-back comes', async () => {
    const tunnels = new AgentTunnels({ send: async () => ({ ok: true }), ttlMs: 50 });
    await expect(tunnels.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 504, code: 'tunnel_timeout' });
    expect(tunnels.count('alice', 'box-1')).toBe(0);
  });

  it('maps the agent\'s t3_not_running reply to t3_not_running, any other refusal or failure to tunnel_failed', async () => {
    const down = new AgentTunnels({ send: async () => ({ ok: false, reason: 't3_not_running' }) });
    await expect(down.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 503, code: 't3_not_running' });
    expect(down.count('alice', 'box-1')).toBe(0);
    // The words alone are no longer the signal.
    const worded = new AgentTunnels({ send: async () => { throw new Error('t3 server is not running'); } });
    await expect(worded.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 502, code: 'tunnel_failed' });
    const refused = new AgentTunnels({ send: async () => ({ ok: false, reason: 'something_else' }) });
    await expect(refused.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 502, code: 'tunnel_failed' });
    const broken = new AgentTunnels({ send: async () => { throw new Error('Agent request timed out: tunnel-open'); } });
    await expect(broken.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 502, code: 'tunnel_failed' });
  });

  it('caps open tunnels per user and box', async () => {
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}), caps: { t3: 2 }, ttlMs: 10_000 });
    void tunnels.openTunnel('box-1', 'alice').catch(() => {});
    void tunnels.openTunnel('box-1', 'alice').catch(() => {});
    await expect(tunnels.openTunnel('box-1', 'alice')).rejects.toBeInstanceOf(TunnelError);
    await expect(tunnels.openTunnel('box-1', 'alice')).rejects.toMatchObject({ status: 429, code: 'too_many_tunnels' });
    // Another box or another user is not counted against it.
    expect(tunnels.count('alice', 'box-2')).toBe(0);
    expect(tunnels.count('bob', 'box-1')).toBe(0);
  });

  it('stops counting a tunnel whose dial-back closed before the agent replied', async () => {
    let base = '';
    let accepted: WebSocket | undefined;
    const tunnels = new AgentTunnels({
      send: async (_box, _type, payload) => {
        const ws = new WebSocket(`${base}/termag/ws/agent-tunnel?id=${payload.tunnelId}`, { headers: { authorization: 'Bearer tmag_box' } });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        ws.close();
        await new Promise(resolve => ws.once('close', resolve));
        // The orchestrator's side has seen the close too before the reply goes out.
        await new Promise<void>(resolve => { const tick = () => (accepted?.readyState === WebSocket.CLOSED ? resolve() : setImmediate(tick)); tick(); });
        return { ok: true, port: 1 };
      },
    });
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
      wss.handleUpgrade(req, socket, head, (ws) => { accepted = ws; tunnels.accept(id, 'box-1', ws); });
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await tunnels.openTunnel('box-1', 'alice');
    expect(tunnels.count('alice', 'box-1')).toBe(0);
  });

  it('knows only pending, unexpired, well-formed ids', async () => {
    let now = 1_000;
    let sentId = '';
    const tunnels = new AgentTunnels({ send: async (_b, _t, p) => { sentId = p.tunnelId as string; return new Promise(() => {}); }, now: () => now, ttlMs: 15_000 });
    void tunnels.openTunnel('box-1', 'alice').catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(sentId).toMatch(/^[0-9a-f]{64}$/);
    expect(tunnels.pendingBox(sentId)).toBe('box-1');
    expect(tunnels.pendingBox('nope')).toBeNull();
    expect(tunnels.pendingBox('a'.repeat(64))).toBeNull();
    now += 15_001;
    expect(tunnels.pendingBox(sentId)).toBeNull();
  });
});

describe('tunnelHeartbeat', () => {
  const HB = 50;

  /** A dial-back pair on loopback: `tunnel` is the orchestrator's end, under tunnelHeartbeat; `box` the agent's. */
  async function pair(boxOptions: WebSocket.ClientOptions = {}) {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const server = http.createServer();
    const accepted = new Promise<WebSocket>((resolve) => {
      server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => { tunnelHeartbeat(ws, HB); resolve(ws); }));
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const box = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, { perMessageDeflate: false, ...boxOptions });
    await new Promise<void>((resolve, reject) => { box.once('open', () => resolve()); box.once('error', reject); });
    const tunnel = await accepted;
    const closed = new Promise<number>((resolve) => tunnel.once('close', (code) => resolve(code)));
    return { tunnel, box, closed };
  }

  it('keeps a tunnel the relay is not reading for backpressure, however long, and every byte arrives', async () => {
    const { tunnel, box, closed } = await pair();
    let ended = false;
    void closed.then(() => { ended = true; });
    // The relay's stream, never read for now: past its high-water mark it pauses
    // the socket, and the box's pongs queue behind the bytes nobody reads.
    const stream = socketLikeStream(tunnel);
    const chunk = Buffer.alloc(64 * 1024, 7);
    const total = 64 * chunk.length;
    for (let i = 0; i < 64; i++) box.send(chunk);
    await new Promise(r => setTimeout(r, 2 * HB));
    expect(tunnel.isPaused).toBe(true);
    // Ten intervals paused: the old heartbeat terminated it after two.
    await new Promise(r => setTimeout(r, 10 * HB));
    expect(ended).toBe(false);
    expect(tunnel.readyState).toBe(WebSocket.OPEN);
    let got = 0;
    stream.on('data', (c: Buffer) => { got += c.length; });
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (got >= total) { clearInterval(t); resolve(); } }, 5); });
    expect(got).toBe(total);
    expect(ended).toBe(false);
    box.close();
  });

  it('counts any frame from the box as life, pong or not', async () => {
    const { tunnel, box, closed } = await pair({ autoPong: false });
    let ended = false;
    void closed.then(() => { ended = true; });
    tunnel.on('message', () => {});
    const talk = setInterval(() => box.send('x'), HB / 2);
    await new Promise(r => setTimeout(r, 8 * HB));
    clearInterval(talk);
    expect(ended).toBe(false);
    box.close();
  });

  it('keeps a socket whose peer has stopped reading what it is sent, as a paused termag forward client does', { timeout: 20_000 }, async () => {
    const { tunnel, box, closed } = await pair();
    let ended = false;
    void closed.then(() => { ended = true; });
    let got = 0;
    box.on('message', (d) => { got += (d as Buffer).length; });
    // The peer reads nothing, our ping included; what we send queues here.
    (box as unknown as { _socket: import('net').Socket })._socket.pause();
    const chunk = Buffer.alloc(64 * 1024, 5);
    const total = 48 * 1024 * 1024;
    for (let i = 0; i < total / chunk.length; i++) tunnel.send(chunk);
    await new Promise(r => setTimeout(r, 10 * HB));
    expect(tunnel.bufferedAmount).toBeGreaterThan(0);
    expect(ended).toBe(false);
    (box as unknown as { _socket: import('net').Socket })._socket.resume();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (got >= total) { clearInterval(t); resolve(); } }, 5); });
    expect(got).toBe(total);
    expect(ended).toBe(false);
    box.close();
  });

  it('keeps a peer that pings on its own while it reads nothing, as a paused termag forward connection does', async () => {
    const { tunnel, box, closed } = await pair();
    let ended = false;
    void closed.then(() => { ended = true; });
    // It reads nothing, our pings included, and what we sent sits in the kernel: nothing queued here.
    (box as unknown as { _socket: import('net').Socket })._socket.pause();
    tunnel.send(Buffer.alloc(16 * 1024, 1));
    const pings = setInterval(() => box.ping(), HB / 3);
    await new Promise(r => setTimeout(r, 10 * HB));
    clearInterval(pings);
    expect(tunnel.bufferedAmount).toBe(0);
    expect(ended).toBe(false);
    box.terminate();
  });

  it('terminates a peer that pinged on its own and fell silent, even while it holds our bytes (a laptop that slept)', { timeout: 20_000 }, async () => {
    const { tunnel, box, closed } = await pair({ autoPong: false });
    const pings = setInterval(() => box.ping(), HB / 3);
    await new Promise(r => setTimeout(r, 3 * HB));
    // Asleep: it reads nothing, answers nothing, sends nothing; what we send backs up here.
    clearInterval(pings);
    (box as unknown as { _socket: import('net').Socket })._socket.pause();
    const chunk = Buffer.alloc(64 * 1024, 5);
    for (let i = 0; i < 48 * 1024 * 1024 / chunk.length; i++) tunnel.send(chunk);
    const started = Date.now();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (tunnel.bufferedAmount > 0) { clearInterval(t); resolve(); } }, 5); });
    expect(await closed).toBe(1006);
    expect(Date.now() - started).toBeLessThan(5 * HB + 500);
    box.terminate();
  });

  it('still terminates a tunnel that is read and answers nothing', async () => {
    // autoPong off: a box that is gone without a FIN looks like this.
    const { tunnel, closed } = await pair({ autoPong: false });
    tunnel.on('message', () => {});
    const started = Date.now();
    expect(await closed).toBe(1006);
    expect(Date.now() - started).toBeLessThan(5 * HB + 200);
  });
});
