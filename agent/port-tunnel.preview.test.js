'use strict';
// A preview link's tunnel (port-tunnel.js openPreviewTunnel): the `preview`
// target, the preview guard (SR6) on the way in, a confined target refused
// until `termag preview run` exists, and a plain byte pipe the orchestrator
// speaks HTTP over (no fin frames: t3's framing).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { CONFINE_REASON, createPortTunnels, openTunnelRpc, tunnelTarget } = require('./port-tunnel');

let idSeq = 0;
const newId = () => crypto.createHash('sha256').update(`preview-${++idSeq}`).digest('hex');
const until = async (ok, ms = 5000, what = 'condition') => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** The orchestrator's end of dial-backs, each with every frame it got. */
async function fakeOrchestrator() {
  const server = http.createServer();
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const dials = [];
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== 'Bearer tmag_box') { socket.end('HTTP/1.1 401 No\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const d = { ws, id: new URL(req.url, 'http://x').searchParams.get('id'), frames: [], closed: null };
      ws.on('message', (data, isBinary) => d.frames.push({ binary: isBinary, data: Buffer.from(data) }));
      ws.on('close', (code) => { d.closed = code; });
      dials.push(d);
    });
  });
  const port = await listen(server);
  return {
    dials,
    termagUrl: `ws://127.0.0.1:${port}/termag/ws/agent`,
    close: () => { for (const c of wss.clients) c.terminate(); server.closeAllConnections?.(); server.close(); },
  };
}

function tunnels(orch, over = {}) {
  const logs = [];
  const checked = [];
  const t = createPortTunnels({
    termagUrl: orch.termagUrl, token: 'tmag_box', WebSocket, log: (m) => logs.push(m),
    checkPort: async () => { throw new Error('a preview never asks the forward\'s guard alone'); },
    checkPreviewPort: async (port) => { checked.push(port); return { ok: true, dialHost: '127.0.0.1' }; },
    clearPortCache: () => {},
    ...over,
  });
  return { t, logs, checked };
}

test('the preview target: a port and confine (null, or an absolute checkout); anything else is unknown', () => {
  assert.deepEqual(tunnelTarget({ kind: 'preview', port: 5173, confine: null }), { kind: 'preview', port: 5173, confine: null });
  assert.deepEqual(tunnelTarget({ kind: 'preview', port: 5173 }), { kind: 'preview', port: 5173, confine: null });
  assert.deepEqual(tunnelTarget({ kind: 'preview', port: 5173, confine: { checkout: '/home/a/termag/projects/x', extra: 1 } }), { kind: 'preview', port: 5173, confine: { checkout: '/home/a/termag/projects/x' } });
  for (const bad of [
    { kind: 'preview' }, { kind: 'preview', port: 0 }, { kind: 'preview', port: '80' },
    { kind: 'preview', port: 80, confine: 'x' }, { kind: 'preview', port: 80, confine: {} }, { kind: 'preview', port: 80, confine: { checkout: 'relative' } },
    { kind: 'preview', port: 80, confine: [] },
  ]) assert.equal(tunnelTarget(bad), null, JSON.stringify(bad));
});

test('tunnel-open routes a preview target to the preview tunnel', async () => {
  const calls = [];
  const portTunnels = {
    openTunnel: async (a) => { calls.push(['port', a]); return { ok: true }; },
    openPreviewTunnel: async (a) => { calls.push(['preview', a]); return { ok: true }; },
  };
  const id = 'a'.repeat(64);
  await openTunnelRpc({ tunnelId: id, target: { kind: 'preview', port: 5173, confine: null } }, { t3: null, portTunnels });
  await openTunnelRpc({ tunnelId: id, target: { kind: 'preview', port: 5173, confine: { checkout: '/c' } } }, { t3: null, portTunnels });
  assert.deepEqual(calls, [['preview', { tunnelId: id, port: 5173, confine: null }], ['preview', { tunnelId: id, port: 5173, confine: { checkout: '/c' } }]]);
});

test('HTTP over a preview tunnel: the guard asked, bytes as binary frames both ways, no fin, counted apart from forwards', async () => {
  const orch = await fakeOrchestrator();
  const app = http.createServer((req, res) => res.end(`hello from ${req.url}`));
  const port = await listen(app);
  const { t, checked, logs } = tunnels(orch);
  try {
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port, confine: null }), { ok: true, port, dialHost: '127.0.0.1' });
    assert.deepEqual(checked, [port]);
    // Never in the host sample's `port` count: an open preview doesn't keep the box busy.
    assert.equal(t.openTunnels(), 0);
    assert.equal(t.openPreviewTunnels(), 1);
    const d = orch.dials[0];
    d.ws.send(Buffer.from('GET /app HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    await until(() => d.closed !== null, 3000, 'the answer and the close');
    const answer = Buffer.concat(d.frames.map((f) => f.data)).toString();
    assert.match(answer, /^HTTP\/1\.1 200 OK/);
    assert.match(answer, /hello from \/app$/);
    assert.ok(d.frames.every((f) => f.binary), 'only binary frames: the relay reads a byte stream');
    assert.equal(d.closed, 1000);
    await until(() => t.openPreviewTunnels() === 0, 3000, 'the count back down');
    assert.ok(!logs.some((l) => /hello from/.test(l)), 'never payload');
  } finally {
    app.close();
    orch.close();
  }
});

test("the preview guard's refusal (a debugger, say) reaches the RPC answer, and nothing dials back", async () => {
  const orch = await fakeOrchestrator();
  try {
    const verdict = { ok: false, code: 'port_refused', reason: 'debugger or shell: the Node inspector (--inspect) holds port 9229' };
    const { t, logs } = tunnels(orch, { checkPreviewPort: async () => verdict });
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port: 9229, confine: null }), verdict);
    assert.ok(logs.includes(`[PREVIEW] refused port=9229 code=port_refused reason=${verdict.reason}`));
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

test('a confined target is refused until `termag preview run` can vouch for the listener, before any look at the port', async () => {
  const orch = await fakeOrchestrator();
  try {
    const { t, checked } = tunnels(orch);
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } }), { ok: false, code: 'port_refused', reason: CONFINE_REASON });
    assert.deepEqual(checked, []);
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

test('nothing listening answers port_closed and clears the verdict; a bad id or port is an error', async () => {
  const orch = await fakeOrchestrator();
  const free = net.createServer();
  const port = await listen(free);
  await new Promise((r) => free.close(r));
  try {
    const cleared = [];
    const { t } = tunnels(orch, { clearPortCache: (p) => cleared.push(p) });
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port, confine: null }), { ok: false, code: 'port_closed', reason: `nothing accepts connections on port ${port}` });
    assert.deepEqual(cleared, [port]);
    await assert.rejects(t.openPreviewTunnel({ tunnelId: 'nope', port: 80 }), /bad tunnel id/);
    await assert.rejects(t.openPreviewTunnel({ tunnelId: newId(), port: 0 }), /bad port/);
  } finally {
    orch.close();
  }
});
