import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { type AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentTunnels, TUNNEL_CAPS, TunnelError } from './agentTunnels';

// The t3 kind is held by t3Tunnels.test.ts; this covers what the registry adds
// for the native port forward: the port target, the raw socket, per-kind caps.

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});

/** Where an agent's dial-back lands, as index.ts hands it to the registry. */
async function dialBackEndpoint(tunnels: AgentTunnels) {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => { if (!tunnels.accept(id, 'box-1', ws)) ws.close(1008, 'unknown tunnel'); });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An agent that dials back and echoes every message, flag and all, as a port tunnel's far end would carry bytes. */
function echoAgent(base: () => string, seen: unknown[] = []) {
  return async (_box: string, type: string, payload: Record<string, unknown>) => {
    seen.push({ type, target: payload.target });
    const ws = new WebSocket(`${base()}/termag/ws/agent-tunnel?id=${payload.tunnelId}`);
    ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ok: true };
  };
}

async function failure(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(TunnelError);
    const e = err as TunnelError;
    return { status: e.status, code: e.code, message: e.message };
  }
  throw new Error('expected a TunnelError');
}

describe('AgentTunnels: port targets', () => {
  it('asks the agent for { kind: "port", port } and hands back the raw dial-back socket, paused', async () => {
    let base = '';
    const seen: unknown[] = [];
    const tunnels = new AgentTunnels({ send: echoAgent(() => base, seen) });
    base = await dialBackEndpoint(tunnels);
    const { ws, reply } = await tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 3000 });
    expect(seen).toEqual([{ type: 'tunnel-open', target: { kind: 'port', port: 3000 } }]);
    expect(reply).toEqual({ ok: true });
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(1);
    expect(tunnels.count('alice', 'box-1', 't3')).toBe(0);
    // Handed over paused, so nothing the port's server says first is lost
    // before the relay listens; the relay resumes it.
    expect(ws.isPaused).toBe(true);
    ws.resume();
    const echoed = await new Promise<{ text: string; binary: boolean }>((resolve) => {
      ws.once('message', (d, isBinary) => resolve({ text: String(d), binary: isBinary }));
      ws.send('{"t":"fin"}');
    });
    expect(echoed).toEqual({ text: '{"t":"fin"}', binary: false });
    ws.close();
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1', 'port') > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(0);
  });

  it("maps the agent's refusals: port_refused with its reason, port_closed, anything else tunnel_failed", async () => {
    const open = (reply: unknown) => new AgentTunnels({ send: async () => reply }).openSocket('box-1', 'alice', { kind: 'port', port: 22 });
    expect(await failure(open({ ok: false, code: 'port_refused', reason: 'port 22 is held by root' })))
      .toEqual({ status: 403, code: 'port_refused', message: 'port 22 is held by root' });
    expect(await failure(open({ ok: false, code: 'port_refused', reason: 'x'.repeat(1000) })).then(f => f.message.length)).toBe(300);
    expect(await failure(open({ ok: false, code: 'port_closed', reason: 'nothing listens on port 22' })))
      .toEqual({ status: 502, code: 'port_closed', message: 'nothing listens on port 22' });
    expect((await failure(open({ ok: false, code: 'port_closed' }))).code).toBe('port_closed');
    expect(await failure(open({ ok: false, code: 'tunnel_failed', reason: 'connect ETIMEDOUT 127.0.0.1:22' })))
      .toEqual({ status: 502, code: 'tunnel_failed', message: 'connect ETIMEDOUT 127.0.0.1:22' });
    expect(await failure(open({ ok: false, code: 'weird' }))).toMatchObject({ status: 502, code: 'tunnel_failed' });
    const rpcDown = new AgentTunnels({ send: async () => { throw new Error('Agent request timed out: tunnel-open'); } });
    expect(await failure(rpcDown.openSocket('box-1', 'alice', { kind: 'port', port: 22 }))).toMatchObject({ status: 502, code: 'tunnel_failed' });
    const noDialBack = new AgentTunnels({ send: async () => ({ ok: true }), ttlMs: 50 });
    expect(await failure(noDialBack.openSocket('box-1', 'alice', { kind: 'port', port: 22 }))).toMatchObject({ status: 504, code: 'tunnel_timeout' });
  });

  it('counts a dial-back against the cap while its reply is still on the way, and gives it back if the RPC then fails', async () => {
    let base = '';
    let answer: (fail: boolean) => void = () => {};
    let dialedBack: () => void = () => {};
    const dialed = new Promise<void>(r => { dialedBack = r; });
    // An agent that dials back, then holds its reply until the test answers.
    const send = async (_box: string, _type: string, payload: Record<string, unknown>) => {
      const ws = new WebSocket(`${base}/termag/ws/agent-tunnel?id=${payload.tunnelId}`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      dialedBack();
      const fail = await new Promise<boolean>(r => { answer = r; });
      if (fail) throw new Error('Agent request timed out: tunnel-open');
      return { ok: true };
    };
    const tunnels = new AgentTunnels({ send, caps: { port: 1 } });
    base = await dialBackEndpoint(tunnels);
    const first = tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 3000 });
    first.catch(() => {});
    await dialed;
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1', 'port') === 0; i++) await new Promise(r => setTimeout(r, 10));
    // Accepted, not yet answered: out of pending, and still counted.
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(1);
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2'], 'port')).toEqual(new Set(['box-1']));
    expect(await failure(tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 3001 }))).toMatchObject({ status: 429, code: 'too_many_tunnels' });
    answer(true);
    expect(await failure(first)).toMatchObject({ status: 502, code: 'tunnel_failed' });
    // The abandoned dial-back is terminated, and its close gives the slot back.
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1', 'port') > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(0);
    expect(tunnels.boxesWithTunnels(['box-1'], 'port')).toEqual(new Set());
  });

  it('tells the boxes with a tunnel of one kind: a t3 relay is no port forward', async () => {
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}), ttlMs: 10_000 });
    void tunnels.openSocket('box-1', 'alice', { kind: 't3' }).catch(() => {});
    void tunnels.openSocket('box-2', 'bob', { kind: 'port', port: 5173 }).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2', 'box-3'], 'port')).toEqual(new Set(['box-2']));
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2', 'box-3'], 't3')).toEqual(new Set(['box-1']));
  });

  it('caps each kind on its own: 128 port tunnels, 128 preview ones and 64 t3 ones by default', async () => {
    expect(TUNNEL_CAPS).toEqual({ t3: 64, port: 128, preview: 128 });
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}), caps: { port: 2, t3: 1 }, ttlMs: 10_000 });
    expect(tunnels.cap('port')).toBe(2);
    void tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 1 }).catch(() => {});
    void tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 2 }).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(await failure(tunnels.openSocket('box-1', 'alice', { kind: 'port', port: 3 }))).toMatchObject({ status: 429, code: 'too_many_tunnels' });
    // The port tunnels don't count against t3, nor another box's or user's.
    void tunnels.openSocket('box-1', 'alice', { kind: 't3' }).catch(() => {});
    void tunnels.openSocket('box-2', 'alice', { kind: 'port', port: 1 }).catch(() => {});
    void tunnels.openSocket('box-1', 'bob', { kind: 'port', port: 1 }).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect([tunnels.count('alice', 'box-1', 't3'), tunnels.count('alice', 'box-2', 'port'), tunnels.count('bob', 'box-1', 'port')]).toEqual([1, 1, 1]);
    expect(await failure(tunnels.openSocket('box-1', 'alice', { kind: 't3' }))).toMatchObject({ status: 429, code: 'too_many_tunnels' });
  });
});

describe('AgentTunnels: preview targets', () => {
  it('asks the agent for { kind: "preview", port, confine } and hands back a byte stream, counted under the owner', async () => {
    let base = '';
    const seen: unknown[] = [];
    const tunnels = new AgentTunnels({ send: echoAgent(() => base, seen) });
    base = await dialBackEndpoint(tunnels);
    const { stream, port } = await tunnels.openPreview('box-1', 'alice', 5173, null);
    expect(port).toBe(5173);
    expect(seen).toEqual([{ type: 'tunnel-open', target: { kind: 'preview', port: 5173, confine: null } }]);
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(1);
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(0);
    stream.write('GET / HTTP/1.1\r\n\r\n');
    const echoed = await new Promise<string>(resolve => stream.once('data', (c: Buffer) => resolve(c.toString())));
    expect(echoed).toBe('GET / HTTP/1.1\r\n\r\n');
    stream.destroy();
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1', 'preview') > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(0);
  });

  it('sends a confined target with its checkout, and hands the agent\'s refusal back', async () => {
    const seen: unknown[] = [];
    const tunnels = new AgentTunnels({
      send: async (_box, _type, payload) => {
        seen.push(payload.target);
        return { ok: false, code: 'port_refused', reason: 'Start this app with `termag preview run` to share it more widely' };
      },
    });
    expect(await failure(tunnels.openPreview('box-1', 'alice', 5173, { checkout: '/home/alice/termag/projects/app' }))).toMatchObject({
      status: 403, code: 'port_refused', message: 'Start this app with `termag preview run` to share it more widely',
    });
    expect(seen).toEqual([{ kind: 'preview', port: 5173, confine: { checkout: '/home/alice/termag/projects/app' } }]);
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(0);
  });

  it('caps preview tunnels on their own, and tells them apart from forwards for the busy check', async () => {
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}), caps: { preview: 1 }, ttlMs: 10_000 });
    void tunnels.openPreview('box-1', 'alice', 1, null).catch(() => {});
    void tunnels.openSocket('box-2', 'alice', { kind: 'port', port: 1 }).catch(() => {});
    void tunnels.openSocket('box-3', 'alice', { kind: 't3' }).catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(await failure(tunnels.openPreview('box-1', 'alice', 2, null))).toMatchObject({ status: 429, code: 'too_many_tunnels' });
    expect(tunnels.count('alice', 'box-1', 'port')).toBe(0);
    // The busy check asks for 'port' only (index.ts): an open preview tunnel holds no box up.
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2', 'box-3'], 'port')).toEqual(new Set(['box-2']));
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2', 'box-3'], ['port', 'preview'])).toEqual(new Set(['box-1', 'box-2']));
    expect(tunnels.boxesWithTunnels(['box-1', 'box-2', 'box-3'], 'preview')).toEqual(new Set(['box-1']));
  });
});
