'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const portGuard = require('./port-guard');
const { createPortTunnels, openTunnelRpc, tunnelTarget, CAPABILITIES, capabilities } = require('./port-tunnel');
const { pipeStream, FRAME_MAX, FRAME_FIRST, FRAME_RAMP_IDLE_MS } = require('./tunnel-dial');

const FIN = JSON.stringify({ t: 'fin' });
const MiB = 1024 * 1024;
let idSeq = 0;
const newId = () => crypto.createHash('sha256').update(String(++idSeq)).digest('hex');

const until = async (ok, ms = 5000, what = 'condition') => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The agent resets a local socket whose tunnel died; the test servers' ends see that as ECONNRESET.
const listen = (server, host = '127.0.0.1') => {
  server.on('connection', (c) => c.on('error', () => {}));
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
};
const freePort = async () => { const s = net.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };

/**
 * The orchestrator's end of dial-backs: each accepted one, with every frame
 * it got ({ binary, data }) and how it closed. `refuse` answers the upgrade
 * with that status instead.
 */
async function fakeOrchestrator({ refuse = null, acceptPausedMs = 0 } = {}) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const dials = [];
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (refuse || url.pathname !== '/termag/ws/agent-tunnel' || req.headers.authorization !== 'Bearer tmag_box') {
      socket.end(`HTTP/1.1 ${refuse || 401} No\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const d = { ws, id: url.searchParams.get('id'), frames: [], closed: null, resumedAt: null, pings: 0 };
      ws.on('ping', () => { d.pings++; });
      // As the orchestrator accepts a port dial-back: paused until its relay listens.
      if (acceptPausedMs) {
        ws.pause();
        setTimeout(() => { d.resumedAt = Date.now(); ws.resume(); }, acceptPausedMs);
      }
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

const bytesOf = (d) => Buffer.concat(d.frames.filter((f) => f.binary).map((f) => f.data));
const fins = (d) => d.frames.filter((f) => !f.binary && f.data.toString() === FIN).length;

function tunnels(orch, over = {}) {
  const logs = [];
  const allow = async () => ({ ok: true, dialHost: '127.0.0.1' });
  const t = createPortTunnels({
    termagUrl: orch.termagUrl, token: 'tmag_box', WebSocket, log: (m) => logs.push(m),
    checkPort: allow, clearPortCache: () => {}, ...over,
  });
  return { t, logs };
}

test('port-forward-v1 is the capability, advertised only where the guard can read the kernel tables', () => {
  assert.deepEqual(CAPABILITIES, ['port-forward-v1']);
  assert.deepEqual(capabilities({ canCheckPorts: () => true }), ['port-forward-v1']);
  assert.deepEqual(capabilities({ canCheckPorts: () => false }), []);
  assert.deepEqual(capabilities(), portGuard.canCheckPorts() ? ['port-forward-v1'] : []);
});

test('an echo through a port tunnel, then fins both ways and a 1000 from the far side: a normal end', async () => {
  const orch = await fakeOrchestrator();
  const echo = net.createServer((c) => c.pipe(c));
  const port = await listen(echo);
  const { t, logs } = tunnels(orch);
  try {
    const id = newId();
    assert.deepEqual(await t.openTunnel({ tunnelId: id, port }), { ok: true, port, dialHost: '127.0.0.1' });
    const d = orch.dials[0];
    assert.equal(d.id, id);
    assert.equal(t.openTunnels(), 1);
    d.ws.send(Buffer.from('hello, box'));
    await until(() => bytesOf(d).toString() === 'hello, box', 3000, 'the echo');
    // The CLI's peer half-closes: the echo server ends too, and its fin comes back.
    d.ws.send(FIN);
    await until(() => fins(d) === 1, 3000, 'the agent\'s fin');
    // The CLI closes first, as contract 6a has it.
    d.ws.close(1000);
    await until(() => t.openTunnels() === 0 && d.closed !== null, 3000, 'the close');
    assert.equal(d.closed, 1000);
    const close = logs.find((l) => l.startsWith('[FORWARD] close'));
    assert.equal(close, `[FORWARD] close port=${port} bytesIn=10 bytesOut=10 durationMs=${close.match(/durationMs=(\d+)/)[1]} code=1000`);
    assert.ok(logs.includes(`[FORWARD] open port=${port} dialHost=127.0.0.1`));
    assert.ok(!logs.some((l) => /hello, box/.test(l)), 'never payload');
  } finally {
    echo.close();
    orch.close();
  }
});

test('half-close: the request and its fin, an answer after EOF, then the server\'s fin; the agent closes 1000 itself', async () => {
  const orch = await fakeOrchestrator();
  let serverErr = null;
  // Reads to EOF, then answers: as an HTTP/1.0 upload or `nc -N` would.
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    let got = 0;
    c.on('data', (b) => { got += b.length; });
    c.on('end', () => setTimeout(() => c.end(`got ${got} bytes`), 50));
    c.on('error', (e) => { serverErr = e; });
  });
  const port = await listen(server);
  const { t, logs } = tunnels(orch);
  try {
    await t.openTunnel({ tunnelId: newId(), port });
    const d = orch.dials[0];
    for (let i = 0; i < 3; i++) d.ws.send(Buffer.alloc(1000, i));
    d.ws.send(FIN);
    await until(() => fins(d) === 1, 3000, 'the server\'s fin');
    assert.equal(bytesOf(d).toString(), 'got 3000 bytes');
    // Both fins have passed: the agent closes with 1000 without waiting for the CLI.
    await until(() => d.closed !== null, 3000, 'the agent\'s close');
    assert.equal(d.closed, 1000);
    assert.equal(serverErr, null, 'the local socket ended, not reset');
    await until(() => logs.some((l) => /\[FORWARD\] close .* code=1000$/.test(l)));
  } finally {
    server.close();
    orch.close();
  }
});

test('a 1000 from the CLI right after both fins is a normal end: what the local socket still holds is delivered', async () => {
  const orch = await fakeOrchestrator();
  const total = 16 * MiB;
  let got = 0;
  let serverErr = null;
  // Finishes its own side at once (the agent's fin goes first), then reads
  // slowly to the end, so the agent still holds bytes when the 1000 comes.
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    c.end();
    c.on('data', (b) => { got += b.length; c.pause(); setTimeout(() => c.resume(), 3); });
    c.on('error', (e) => { serverErr = e; });
  });
  server.on('connection', (c) => c.on('error', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { t, logs } = tunnels(orch);
  try {
    await t.openTunnel({ tunnelId: newId(), port });
    const d = orch.dials[0];
    await until(() => fins(d) === 1, 3000, 'the agent\'s fin');
    for (let i = 0; i < total / FRAME_MAX; i++) d.ws.send(Buffer.alloc(FRAME_MAX, 1));
    d.ws.send(FIN);
    // Both fins have passed: the CLI closes at once (contract 6a).
    d.ws.close(1000);
    await until(() => got === total, 20000, 'every byte, after the close');
    assert.equal(serverErr, null);
    await until(() => logs.some((l) => l.startsWith('[FORWARD] close')));
    assert.match(logs.find((l) => l.startsWith('[FORWARD] close')), new RegExp(`bytesIn=${total} bytesOut=0 .*code=1000$`));
  } finally {
    server.close();
    orch.close();
  }
});

test('each refusal from the guard reaches the RPC answer, and nothing dials back', async () => {
  const orch = await fakeOrchestrator();
  try {
    for (const verdict of [
      { ok: false, code: 'port_refused', reason: 'the listener on 127.0.0.1:22 belongs to uid 0, not this user' },
      { ok: false, code: 'port_closed', reason: 'nothing listens on port 4999' },
    ]) {
      const { t, logs } = tunnels(orch, { checkPort: async () => verdict });
      assert.deepEqual(await t.openTunnel({ tunnelId: newId(), port: 4999 }), verdict);
      assert.ok(logs.includes(`[FORWARD] refused port=4999 code=${verdict.code} reason=${verdict.reason}`));
      assert.equal(t.openTunnels(), 0);
    }
    // The real guard refuses a root daemon: sshd on 22, where it runs.
    const real = createPortTunnels({ termagUrl: orch.termagUrl, token: 'tmag_box', WebSocket, checkPort: (p) => portGuard.checkPort(p, { cache: new Map() }) });
    const sshd = await real.openTunnel({ tunnelId: newId(), port: 22 });
    assert.equal(sshd.ok, false);
    assert.match(sshd.code, /^port_(refused|closed)$/);
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

// The real guard reads /proc/net/tcp: Linux only.
const noKernelTables = !portGuard.canCheckPorts() && 'needs /proc/net/tcp (Linux)';

test('port_closed, then a listener appears: the next tunnel goes through (no stale verdict)', { skip: noKernelTables }, async () => {
  const orch = await fakeOrchestrator();
  const cache = new Map();
  const { t } = tunnels(orch, {
    checkPort: (p) => portGuard.checkPort(p, { cache }),
    clearPortCache: (p) => portGuard.clearPortCache(p, cache),
  });
  const port = await freePort();
  const server = net.createServer((c) => c.end('up'));
  try {
    assert.deepEqual(await t.openTunnel({ tunnelId: newId(), port }), { ok: false, code: 'port_closed', reason: `nothing listens on port ${port}` });
    server.on('connection', (c) => c.on('error', () => {}));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    assert.deepEqual(await t.openTunnel({ tunnelId: newId(), port }), { ok: true, port, dialHost: '127.0.0.1' });
    await until(() => orch.dials[0] && bytesOf(orch.dials[0]).toString() === 'up');
  } finally {
    server.close();
    orch.close();
  }
});

test('a connect refused after an allowed verdict answers port_closed and clears that port\'s verdict', async () => {
  const orch = await fakeOrchestrator();
  const cleared = [];
  const { t } = tunnels(orch, { clearPortCache: (p) => cleared.push(p) });
  const port = await freePort();
  try {
    assert.deepEqual(await t.openTunnel({ tunnelId: newId(), port }), { ok: false, code: 'port_closed', reason: `nothing accepts connections on port ${port}` });
    assert.deepEqual(cleared, [port]);
    // Another connect failure: tunnel_failed, cleared too.
    const hanging = { connect: () => { const s = new net.Socket(); setImmediate(() => s.emit('error', Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))); return s; } };
    const other = tunnels(orch, { netImpl: hanging, clearPortCache: (p) => cleared.push(p) }).t;
    assert.deepEqual(await other.openTunnel({ tunnelId: newId(), port }), { ok: false, code: 'tunnel_failed', reason: `connecting to port ${port} failed (EHOSTUNREACH)` });
    assert.deepEqual(cleared, [port, port]);
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

/** A WebSocket that counts its pause() and resume() calls. */
class CountingWebSocket extends WebSocket {
  pause() { CountingWebSocket.pauses++; return super.pause(); }
  resume() { CountingWebSocket.resumes++; return super.resume(); }
}
CountingWebSocket.pauses = 0;
CountingWebSocket.resumes = 0;

test('a slow local reader pauses the dial-back until its socket drains; no byte lost', async () => {
  const orch = await fakeOrchestrator();
  const total = 32 * MiB;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const server = net.createServer((c) => {
    c.pause();
    setTimeout(() => c.resume(), 800);
    c.on('data', (b) => { got += b.length; hash.update(b); });
  });
  const port = await listen(server);
  const { t } = tunnels(orch, { WebSocket: CountingWebSocket });
  try {
    await t.openTunnel({ tunnelId: newId(), port });
    const d = orch.dials[0];
    const want = crypto.createHash('sha256');
    for (let i = 0; i < total / FRAME_MAX; i++) {
      const frame = Buffer.alloc(FRAME_MAX, i % 251);
      want.update(frame);
      d.ws.send(frame);
    }
    await until(() => CountingWebSocket.pauses > 0, 5000, 'a pause');
    await until(() => got === total, 20000, 'every byte');
    assert.ok(CountingWebSocket.resumes > 0, 'resumed on drain');
    assert.equal(hash.digest('hex'), want.digest('hex'));
  } finally {
    server.close();
    orch.close();
  }
});

test('a slow orchestrator reader pauses the local socket and the send callbacks resume it; no byte lost', async () => {
  const orch = await fakeOrchestrator();
  const total = 32 * MiB;
  const sent = crypto.createHash('sha256');
  const server = net.createServer((c) => {
    let i = 0;
    const more = () => {
      while (i < total / FRAME_MAX) {
        const b = Buffer.alloc(FRAME_MAX, i % 251);
        sent.update(b);
        i++;
        if (!c.write(b)) { c.once('drain', more); return; }
      }
      c.end();
    };
    more();
  });
  const port = await listen(server);
  let socks = [];
  const netImpl = {
    connect: (...a) => {
      const s = net.connect(...a);
      s.calls = { pause: 0, resume: 0 };
      const { pause, resume } = s;
      s.pause = function p() { s.calls.pause++; return pause.call(this); };
      s.resume = function r() { s.calls.resume++; return resume.call(this); };
      socks.push(s);
      return s;
    },
  };
  const { t } = tunnels(orch, { netImpl });
  try {
    await t.openTunnel({ tunnelId: newId(), port });
    const d = orch.dials[0];
    const pausedAtOpen = socks[0].calls.pause; // held until the dial-back opened
    d.ws.pause();
    await sleep(800);
    assert.ok(socks[0].calls.pause > pausedAtOpen, 'paused above the high-water mark');
    const resumesBefore = socks[0].calls.resume;
    d.ws.resume();
    await until(() => fins(d) === 1, 20000, 'all of it and the fin');
    assert.ok(socks[0].calls.resume > resumesBefore, 'resumed by a send callback');
    const got = bytesOf(d);
    assert.equal(got.length, total);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), sent.digest('hex'));
    assert.ok(d.frames.every((f) => f.data.length <= FRAME_MAX));
  } finally {
    socks = [];
    server.close();
    orch.close();
  }
});

/** A local socket stand-in whose reads come in whatever chunks the test pushes. */
function fakeSocket() {
  const written = [];
  const s = new Duplex({
    allowHalfOpen: true,
    read() {},
    write(chunk, _enc, cb) { written.push(chunk); cb(); },
    final(cb) { s.ended = true; cb(); },
  });
  s.written = written;
  return s;
}

/** A connected ws pair: the agent's client end, and the orchestrator's. */
async function wsPair() {
  const orch = await fakeOrchestrator();
  const ws = new WebSocket(`${orch.termagUrl.replace('/ws/agent', '/ws/agent-tunnel')}?id=x`, { headers: { Authorization: 'Bearer tmag_box' }, perMessageDeflate: false });
  return { orch, ws };
}

test('frames are at most 64 KiB, however big a chunk the socket reads', async () => {
  const { orch, ws } = await wsPair();
  const sock = fakeSocket();
  const set = new Set();
  pipeStream(ws, sock, { WebSocket, tunnels: set });
  try {
    await until(() => orch.dials.length === 1);
    sock.push(Buffer.alloc(200 * 1024 + 7, 9));
    const d = orch.dials[0];
    await until(() => bytesOf(d).length === 200 * 1024 + 7);
    assert.deepEqual(d.frames.map((f) => f.data.length), [4, 8, 16, 32, 64, 64, 12].map((k) => k * 1024).map((n, i, a) => (i === a.length - 1 ? n + 7 : n)));
    assert.equal(Math.max(...d.frames.map((f) => f.data.length)), FRAME_MAX);
  } finally {
    orch.close();
  }
});

test("a burst's first frames start small and double, again after a pause, so a fresh connection's first round trip carries a whole frame", async () => {
  const { orch, ws } = await wsPair();
  const sock = fakeSocket();
  let clock = 1_000_000;
  pipeStream(ws, sock, { WebSocket, tunnels: new Set(), now: () => clock });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    const sizes = () => d.frames.map((f) => f.data.length / 1024);
    sock.push(Buffer.alloc(20 * 1024, 1));
    await until(() => bytesOf(d).length === 20 * 1024);
    assert.equal(FRAME_FIRST, 4 * 1024);
    assert.deepEqual(sizes(), [4, 8, 8]);
    // Within a burst the ramp goes on where it was...
    clock += FRAME_RAMP_IDLE_MS - 1;
    sock.push(Buffer.alloc(128 * 1024, 2));
    await until(() => bytesOf(d).length === 148 * 1024);
    assert.deepEqual(sizes().slice(3), [32, 64, 32]);
    // ... and a pause as long as a minimum RTO starts it again.
    clock += FRAME_RAMP_IDLE_MS;
    sock.push(Buffer.alloc(12 * 1024, 3));
    await until(() => bytesOf(d).length === 160 * 1024);
    assert.deepEqual(sizes().slice(6), [4, 8]);
  } finally {
    orch.close();
  }
});

test('a text frame other than fin is a protocol error: 1011, the socket reset, the payload not logged', async () => {
  const { orch, ws } = await wsPair();
  const sock = fakeSocket();
  const logs = [];
  const set = new Set();
  pipeStream(ws, sock, { WebSocket, tunnels: set, log: (m) => logs.push(m) });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    d.ws.send('{"t":"secret-token-123"}');
    await until(() => d.closed !== null);
    assert.equal(d.closed, 1011);
    assert.equal(sock.destroyed, true);
    assert.equal(set.size, 0);
    assert.deepEqual(logs, ['[FORWARD] protocol error: unexpected text frame (24 bytes)']);
  } finally {
    orch.close();
  }
});

test('a local reset closes the dial-back with 1011; a 1011 from the far side resets the local socket', async () => {
  const orch = await fakeOrchestrator();
  const resets = net.createServer((c) => setTimeout(() => c.resetAndDestroy(), 100));
  const resetsPort = await listen(resets);
  let farErr = null;
  const victim = net.createServer((c) => { c.on('error', (e) => { farErr = e; }); });
  const victimPort = await listen(victim);
  const { t } = tunnels(orch);
  try {
    await t.openTunnel({ tunnelId: newId(), port: resetsPort });
    await until(() => orch.dials[0].closed !== null);
    assert.equal(orch.dials[0].closed, 1011);
    await t.openTunnel({ tunnelId: newId(), port: victimPort });
    orch.dials[1].ws.close(1011);
    await until(() => farErr !== null, 3000, 'the reset');
    assert.equal(farErr.code, 'ECONNRESET');
    await until(() => t.openTunnels() === 0);
  } finally {
    resets.close();
    victim.close();
    orch.close();
  }
});

test('a server that speaks first: its greeting goes out as soon as the dial-back opens, without the orchestrator speaking or reading', async () => {
  // The orchestrator accepts the dial-back paused and never sends a byte.
  const orch = await fakeOrchestrator({ acceptPausedMs: 400 });
  const greeter = net.createServer((c) => c.write('SSH-2.0-hello\r\n'));
  const port = await listen(greeter);
  let firstSendAt = null;
  class SendClock extends WebSocket {
    send(...a) { if (firstSendAt === null) firstSendAt = Date.now(); return super.send(...a); }
  }
  const { t } = tunnels(orch, { WebSocket: SendClock });
  try {
    await t.openTunnel({ tunnelId: newId(), port });
    await until(() => bytesOf(orch.dials[0]).toString() === 'SSH-2.0-hello\r\n', 3000, 'the greeting');
    assert.ok(firstSendAt !== null && orch.dials[0].resumedAt !== null && firstSendAt < orch.dials[0].resumedAt, 'sent before the orchestrator resumed its reading');
    assert.equal(orch.dials[0].frames.filter((f) => !f.binary).length, 0, 'no fin: the server is still open');
  } finally {
    greeter.close();
    orch.close();
  }
});

test('a dial-back the orchestrator refuses fails the RPC and leaves nothing open', async () => {
  const orch = await fakeOrchestrator({ refuse: 404 });
  let localClosed = false;
  const server = net.createServer((c) => { c.on('close', () => { localClosed = true; }); c.on('error', () => {}); });
  const port = await listen(server);
  const { t } = tunnels(orch);
  try {
    await assert.rejects(t.openTunnel({ tunnelId: newId(), port }), /refused the tunnel \(404\)/);
    assert.equal(t.openTunnels(), 0);
    await until(() => localClosed, 3000, 'the local socket closed');
  } finally {
    server.close();
    orch.close();
  }
});

test('the open tunnel count goes up and back down', async () => {
  const orch = await fakeOrchestrator();
  const server = net.createServer({ allowHalfOpen: true }, (c) => { c.on('end', () => c.end()); });
  const port = await listen(server);
  const { t } = tunnels(orch);
  try {
    assert.equal(t.openTunnels(), 0);
    await t.openTunnel({ tunnelId: newId(), port });
    await t.openTunnel({ tunnelId: newId(), port });
    assert.equal(t.openTunnels(), 2);
    orch.dials[0].ws.send(FIN);
    await until(() => t.openTunnels() === 1, 3000, 'one closed');
    orch.dials[1].ws.close(1012);
    await until(() => t.openTunnels() === 0, 3000, 'both closed');
  } finally {
    server.close();
    orch.close();
  }
});

test('tunnel-open by target: t3 as before, port without t3, anything else an error', async () => {
  const calls = [];
  const t3 = { openTunnel: async (a) => { calls.push(['t3', a]); return { ok: true, port: 1 }; } };
  const portTunnels = { openTunnel: async (a) => { calls.push(['port', a]); return { ok: true, port: a.port, dialHost: '127.0.0.1' }; } };
  const id = 'a'.repeat(64);
  assert.deepEqual(await openTunnelRpc({ tunnelId: id, target: 't3' }, { t3, portTunnels }), { ok: true, port: 1 });
  assert.deepEqual(await openTunnelRpc({ tunnelId: id, target: { kind: 'port', port: 3002 } }, { t3: null, portTunnels }), { ok: true, port: 3002, dialHost: '127.0.0.1' });
  assert.deepEqual(calls, [['t3', { tunnelId: id, target: 't3' }], ['port', { tunnelId: id, port: 3002 }]]);
  await assert.rejects(openTunnelRpc({ tunnelId: id, target: 't3' }, { t3: null, portTunnels }), /No t3 command on this box/);
  for (const target of [undefined, null, 'ssh', 7, [], {}, { kind: 'host', port: 80 }, { kind: 'port' }, { kind: 'port', port: 0 }, { kind: 'port', port: 65536 }, { kind: 'port', port: '80' }, { kind: 'port', port: 1.5 }]) {
    await assert.rejects(openTunnelRpc({ tunnelId: id, target }, { t3, portTunnels }), /unknown tunnel target/, JSON.stringify(target));
  }
  await assert.rejects(openTunnelRpc(null, { t3, portTunnels }), /unknown tunnel target/);
  assert.equal(calls.length, 2);
  assert.deepEqual(tunnelTarget({ kind: 'port', port: 65535 }), { kind: 'port', port: 65535 });
  // A malformed tunnel id never reaches the guard.
  const orch = await fakeOrchestrator();
  try {
    let checked = 0;
    const { t } = tunnels(orch, { checkPort: async () => { checked++; return { ok: true, dialHost: '127.0.0.1' }; } });
    await assert.rejects(t.openTunnel({ tunnelId: 'nope', port: 80 }), /bad tunnel id/);
    assert.equal(checked, 0);
  } finally {
    orch.close();
  }
});

/** A dial-back the test drives: open at once; it holds every frame (and its send callback) until the test lets some go. */
class HeldDialBack extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.held = [];
    this.closes = [];
    this.terminated = false;
  }
  send(data, _opts, cb) { this.bufferedAmount += data.length; this.held.push({ n: data.length, cb }); }
  release(count) {
    for (const f of this.held.splice(0, count)) { this.bufferedAmount -= f.n; f.cb && f.cb(); }
  }
  close(code) { this.closes.push(code); }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close', 1006); }
  pause() {}
  resume() {}
}

test('a fin stuck behind unsent bytes is given up after the stall bound, which progress resets; an open tunnel never is', async () => {
  const logs = [];
  const set = new Set();
  // Open, with bytes held and no fin: never given up.
  const idleWs = new HeldDialBack();
  const idleSock = fakeSocket();
  pipeStream(idleWs, idleSock, { WebSocket, tunnels: set, stallMs: 200, log: (m) => logs.push(m) });
  idleSock.resume();
  idleSock.push(Buffer.alloc(10_000));
  // Ended, its fin behind 300 KB nobody reads (the held dial-back never says open, so the test resumes the socket).
  const ws = new HeldDialBack();
  const sock = fakeSocket();
  pipeStream(ws, sock, { WebSocket, tunnels: set, stallMs: 200, log: (m) => logs.push(m) });
  sock.resume();
  for (let i = 0; i < 5; i++) sock.push(Buffer.alloc(60_000));
  sock.push(null);
  // The first chunk goes as the ramp's four frames (4, 8, 16 KiB and the rest), the others whole.
  await until(() => ws.held.length === 9, 2000, 'the fin queued');
  ws.release(3);
  // Progress every 100 ms keeps it, well past the bound.
  for (let i = 0; i < 4; i++) { await sleep(100); ws.release(1); }
  assert.equal(ws.terminated, false);
  await until(() => ws.terminated, 2000, 'the give-up');
  assert.deepEqual(logs, ['[FORWARD] tunnel gave up: 60011 bytes unsent for 0s'], 'a 60 KB frame and the fin');
  assert.deepEqual(ws.closes, []);
  await sleep(300);
  assert.equal(idleWs.terminated, false);
  assert.equal(set.size, 1);
});

/** A local socket that takes one chunk every `everyMs` (none once `stuck` is set), as a slow reader's socket does. */
function slowSocket(everyMs, writableHighWaterMark) {
  const s = new Duplex({
    allowHalfOpen: true,
    ...(writableHighWaterMark ? { writableHighWaterMark } : {}),
    read() {},
    write(chunk, _enc, cb) {
      const take = () => { if (s.stuck) { s.release = take; return; } s.got += chunk.length; setTimeout(cb, everyMs); };
      take();
    },
  });
  s.got = 0;
  s.stuck = false;
  return s;
}

test('a dial-back paused for a slow local reader pings the orchestrator, and is never cut while the reader moves', async () => {
  const { orch, ws } = await wsPair();
  const logs = [];
  const sock = slowSocket(20);
  const set = new Set();
  let pauses = 0;
  const pause = ws.pause.bind(ws);
  ws.pause = () => { pauses++; return pause(); };
  // A stall bound well under the transfer's length: a paused dial-back is judged by progress, not time.
  pipeStream(ws, sock, { WebSocket, tunnels: set, stallMs: 300, pingMs: 50, log: (m) => logs.push(m) });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    const total = 4 * MiB;
    for (let i = 0; i < total / FRAME_MAX; i++) d.ws.send(Buffer.alloc(FRAME_MAX, i % 251));
    await until(() => sock.got === total, 20000, 'every byte, slowly');
    assert.ok(pauses > 0, 'the dial-back was paused');
    assert.ok(d.pings >= 10, `the orchestrator heard from it while it read nothing (${d.pings} pings)`);
    assert.equal(d.closed, null);
    assert.deepEqual(logs, []);
  } finally {
    orch.close();
  }
});

test('a fin read while the dial-back is paused: the socket flushes, and the tunnel stays up past the stall bound for the answer', async () => {
  const { orch, ws } = await wsPair();
  const logs = [];
  // write() asks for a pause past 8 KiB queued, well inside the burst below.
  const sock = slowSocket(20, 8 * 1024);
  const set = new Set();
  let pauses = 0;
  const pause = ws.pause.bind(ws);
  ws.pause = () => { pauses++; return pause(); };
  pipeStream(ws, sock, { WebSocket, tunnels: set, stallMs: 300, pingMs: 50, log: (m) => logs.push(m) });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    // The upload and its fin in one TCP write, under one 64 KiB read: the dial-back pauses a few
    // frames in, and reads the rest and the fin anyway, as when the fin shares a read with the last frames.
    const total = 50 * 1024;
    const raw = d.ws._socket;
    raw.cork();
    for (let i = 0; i < 50; i++) d.ws.send(Buffer.alloc(1024, i));
    d.ws.send(FIN);
    raw.uncork();
    await until(() => sock.got === total && sock.writableLength === 0 && sock.writableEnded, 5000, 'the whole upload, flushed');
    assert.equal(pauses, 1, 'paused once, and the fin came while it was');
    // The service works on its answer for well past the stall bound.
    await sleep(1000);
    assert.equal(d.closed, null);
    assert.deepEqual(logs, []);
    sock.push(Buffer.from('the answer'));
    sock.push(null);
    await until(() => bytesOf(d).toString() === 'the answer' && fins(d) === 1, 3000, 'the answer and its fin');
    await until(() => d.closed !== null, 3000, 'the close');
    assert.equal(d.closed, 1000);
  } finally {
    orch.close();
  }
});

test('a dial-back paused for a local socket that takes nothing for the stall bound is given up', async () => {
  const { orch, ws } = await wsPair();
  const logs = [];
  const sock = slowSocket(1);
  const set = new Set();
  pipeStream(ws, sock, { WebSocket, tunnels: set, stallMs: 300, pingMs: 50, log: (m) => logs.push(m) });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    sock.stuck = true;
    for (let i = 0; i < 64; i++) d.ws.send(Buffer.alloc(FRAME_MAX, 3));
    const started = Date.now();
    await until(() => d.closed !== null, 3000, 'the give-up');
    assert.equal(d.closed, 1011);
    assert.ok(Date.now() - started >= 300, 'not before the stall bound');
    assert.deepEqual(logs, ['[FORWARD] tunnel gave up: the local socket took nothing for 0s']);
    assert.equal(set.size, 0);
  } finally {
    orch.close();
  }
});

test('a 1000 after both fins leaves the local socket to flush what it holds; it is not destroyed', async () => {
  const { orch, ws } = await wsPair();
  // A local socket that takes writes but holds them, as a peer that stopped
  // reading; its buffer is big enough that write() never asks for a pause, so
  // the 1000 arrives while it still holds them.
  const held = [];
  let written = 0;
  const sock = new Duplex({
    allowHalfOpen: true,
    writableHighWaterMark: 64 * MiB,
    read() {},
    write(chunk, _enc, cb) { held.push(() => { written += chunk.length; cb(); }); },
    final(cb) { sock.finished = true; cb(); },
  });
  const set = new Set();
  pipeStream(ws, sock, { WebSocket, tunnels: set });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    sock.push(null); // the local peer is done first
    await until(() => fins(d) === 1, 3000, 'the agent\'s fin');
    for (let i = 0; i < 8; i++) d.ws.send(Buffer.alloc(FRAME_MAX, 5));
    d.ws.send(FIN);
    d.ws.close(1000);
    await until(() => set.size === 0, 3000, 'the dial-back closed');
    assert.equal(sock.destroyed, false, 'not destroyed: it still holds the CLI\'s last bytes');
    while (held.length) { held.shift()(); await sleep(1); }
    await until(() => sock.finished === true, 3000, 'the local write side ended after the flush');
    assert.equal(written, 8 * FRAME_MAX);
  } finally {
    orch.close();
  }
});

test('a normal end leaves no flush fallback armed once the local socket has closed', async () => {
  const FALLBACK_MS = 987_654; // distinctive, to pick its timer out
  const live = new Map(); // handle -> delay, for timers neither fired nor cleared
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = function patched(fn, ms, ...a) {
    const h = realSet(function fired() { live.delete(h); return fn.apply(this, arguments); }, ms, ...a);
    live.set(h, ms);
    return h;
  };
  global.clearTimeout = function patched(h) { live.delete(h); return realClear(h); };
  const fallbacks = () => [...live.values()].filter((ms) => ms === FALLBACK_MS).length;
  const { orch, ws } = await wsPair();
  // A local socket whose write side takes 50 ms to finish, as a flush to a
  // peer would: it closes just after the dial-back's normal close.
  const sock = new Duplex({
    allowHalfOpen: true,
    read() {},
    write(_chunk, _enc, cb) { cb(); },
    final(cb) { realSet(cb, 50); },
  });
  let sockClosed = false;
  sock.on('close', () => { sockClosed = true; });
  const set = new Set();
  pipeStream(ws, sock, { WebSocket, tunnels: set, closeTimeoutMs: FALLBACK_MS });
  try {
    await until(() => orch.dials.length === 1);
    const d = orch.dials[0];
    sock.push(null);
    await until(() => fins(d) === 1, 3000, 'the agent\'s fin');
    d.ws.send(Buffer.from('last'));
    d.ws.send(FIN);
    d.ws.close(1000);
    await until(() => set.size === 0, 3000, 'the dial-back closed');
    await until(() => sockClosed, 3000, 'the local socket closed');
    assert.equal(fallbacks(), 0, 'no ten-minute timer left holding the socket');
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
    for (const h of live.keys()) realClear(h);
    orch.close();
  }
});
