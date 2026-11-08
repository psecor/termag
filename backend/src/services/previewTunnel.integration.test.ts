// Preview tunnels end to end over real sockets: AgentTunnels' `preview`
// target, a box agent that connects and dials back (tunnelTestHarness.ts,
// ported from #167), and loopback apps. What PR 2's relay builds on: an
// http.Agent per viewer session whose createConnection opens one tunnel per
// kept-alive connection (SR7), WebSocket upgrades over a tunnel, and
// backpressure across it. #167's transport tests, on AgentTunnels.
import { afterAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { Duplex } from 'stream';
import WebSocket from 'ws';
import { AgentTunnels } from './agentTunnels';
import { dialBackEndpoint, fakeBoxAgent, makeClosers, startFloodSource, startHttpEcho, startWsEcho } from './tunnelTestHarness';

const closers = makeClosers();
afterAll(() => closers.closeAll());

async function setup(opts: Parameters<typeof fakeBoxAgent>[1] = {}) {
  let base = '';
  const agent = fakeBoxAgent(() => base, opts);
  const tunnels = new AgentTunnels({ send: agent.send });
  base = await dialBackEndpoint(tunnels, closers);
  return { agent, tunnels };
}

/** A pooled agent as the relay keeps per viewer session: keep-alive, each new connection a preview tunnel. */
function sessionAgent(tunnels: AgentTunnels, port: number) {
  const pool = new http.Agent({ keepAlive: true, maxSockets: 16 });
  (pool as unknown as { createConnection: unknown }).createConnection = (_opts: unknown, cb: (err: Error | null, s?: Duplex) => void) => {
    tunnels.openPreview('box-1', 'alice', port, null).then(t => cb(null, t.stream), err => cb(err));
  };
  closers.add(() => pool.destroy());
  return pool;
}

function get(pool: http.Agent, path: string, body?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent: pool, host: 'localhost', method: body ? 'POST' : 'GET', path,
      headers: { host: 'localhost', ...(body ? { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) } : {}) },
    }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('preview tunnels (end to end)', () => {
  it('relays HTTP over a pooled tunnel: one tunnel-open for a kept-alive connection\'s many requests', async () => {
    const { agent, tunnels } = await setup();
    const app = await startHttpEcho(closers);
    const pool = sessionAgent(tunnels, app.port);
    for (const path of ['/', '/@vite/client', '/src/main.ts?t=1']) {
      expect(await get(pool, path)).toMatchObject({ status: 200, json: { method: 'GET', url: path } });
    }
    expect(await get(pool, '/api/save', '{"x":1}')).toMatchObject({ status: 200, json: { method: 'POST', body: '{"x":1}' } });
    expect(agent.opened).toEqual([{ kind: 'preview', port: app.port, confine: null }]);
    expect(app.connections()).toBe(1);
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(1);
    pool.destroy();
    for (let i = 0; i < 50 && tunnels.count('alice', 'box-1', 'preview') > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(0);
  });

  it('carries a WebSocket upgrade (an HMR socket) over a tunnel', async () => {
    const { tunnels } = await setup();
    const port = await startWsEcho(closers);
    const { stream } = await tunnels.openPreview('box-1', 'alice', port, null);
    const ws = new WebSocket('ws://localhost/__vite_hmr', { createConnection: () => stream as never });
    closers.add(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = new Promise<string>(resolve => ws.once('message', m => resolve(String(m))));
    ws.send('ping');
    expect(await reply).toBe('echo:ping:/__vite_hmr');
  });

  it('moves 16 MiB through a tunnel whose reader is slow, without losing a byte', async () => {
    const { tunnels } = await setup();
    const port = await startFloodSource(closers, 16 << 20);
    const pool = sessionAgent(tunnels, port);
    const received = await new Promise<number>((resolve, reject) => {
      http.get({ agent: pool, host: 'localhost', path: '/', headers: { host: 'localhost' } }, res => {
        let n = 0;
        res.pause();
        // Read nothing for a while: the tunnel and the agent's socket must hold back, not drop.
        setTimeout(() => { res.on('data', (c: Buffer) => { n += c.length; }); res.on('end', () => resolve(n)); res.resume(); }, 300);
      }).on('error', reject);
    });
    expect(received).toBe(16 << 20);
  }, 20_000);

  it("answers the agent's refusal, and opens nothing", async () => {
    const { agent, tunnels } = await setup({ refuse: () => ({ code: 'port_refused', reason: 'debugger or shell: the Node inspector (--inspect) holds port 9229' }) });
    await expect(tunnels.openPreview('box-1', 'alice', 9229, null)).rejects.toMatchObject({ status: 403, code: 'port_refused' });
    expect(agent.live()).toBe(0);
    expect(tunnels.count('alice', 'box-1', 'preview')).toBe(0);
  });
});
