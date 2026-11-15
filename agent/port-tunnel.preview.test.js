'use strict';
// A preview link's tunnel (port-tunnel.js openPreviewTunnel): the `preview`
// target, the preview guard (SR6) on the way in, a confined target refused
// unless `termag preview run` vouches for its listener, and a plain byte pipe the orchestrator
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

test('a confined target is refused unless `termag preview run` vouches for the listener, before any look at the port', async () => {
  const orch = await fakeOrchestrator();
  try {
    // An agent with no run registry (the default) vouches for nothing.
    const { t, checked } = tunnels(orch);
    const r = await t.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'port_refused');
    assert.ok(r.reason.startsWith(CONFINE_REASON), r.reason);
    // The registry's own reason, named after it.
    const asked = [];
    const { t: t2 } = tunnels(orch, { listenerConfined: (port, checkout) => { asked.push([port, checkout]); return { ok: false, reason: 'pid 42 on port 5173 wasn\'t started by termag preview run' }; } });
    assert.deepEqual(await t2.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } }),
      { ok: false, code: 'port_refused', reason: `${CONFINE_REASON} (pid 42 on port 5173 wasn't started by termag preview run)` });
    assert.deepEqual(asked, [[5173, '/home/a/termag/projects/x']]);
    assert.deepEqual(checked, []);
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

// Pinning (Bugbot, #1520): a confined target with nothing listening yet (the app still binding) is port_closed, so
// the viewer is told the app isn't running rather than that the port can't be shared.
test('a confined target with nothing listening yet is closed, not refused (Bugbot, #1520)', async () => {
  const orch = await fakeOrchestrator();
  try {
    const closed = () => ({ ok: false, closed: true, reason: 'nothing listens on port 5173' });
    const { t, checked } = tunnels(orch, { listenerConfined: closed, dockerBindings: async () => [] });
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } }),
      { ok: false, code: 'port_closed', reason: 'nothing listens on port 5173' });
    assert.deepEqual(checked, []);
    // A DNAT-only Docker publish has no host row but runs, unconfined: refused, not closed (Devin, #1520). So is a
    // port Docker can't be asked about.
    const { t: t2 } = tunnels(orch, { listenerConfined: closed, dockerBindings: async () => [{ ip: '0.0.0.0' }] });
    const docker = await t2.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } });
    assert.equal(docker.code, 'port_refused');
    assert.match(docker.reason, /Docker publishes port 5173/);
    // A publish only on another address can't take the relay's loopback dial: closed (Devin, #1520).
    const { t: t4 } = tunnels(orch, { listenerConfined: closed, dockerBindings: async () => [{ ip: '192.168.1.10' }] });
    assert.equal((await t4.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } })).code, 'port_closed');
    const { t: t5 } = tunnels(orch, { listenerConfined: closed, dockerBindings: async () => [{ ip: '::' }] });
    assert.equal((await t5.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } })).code, 'port_refused');
    const { t: t3 } = tunnels(orch, { listenerConfined: closed, dockerBindings: async () => null });
    assert.equal((await t3.openPreviewTunnel({ tunnelId: newId(), port: 5173, confine: { checkout: '/home/a/termag/projects/x' } })).code, 'port_refused');
    assert.equal(orch.dials.length, 0);
  } finally {
    orch.close();
  }
});

test('listenerConfined: nothing on the port is closed; a listener it can\'t vouch for isn\'t', () => {
  const { listenerConfined } = require('./preview-runs');
  const header = 'sl local rem st tx rx tr tm retr uid timeout inode\n';
  const empty = { readFileSync: (f) => { if (f.endsWith('/net/tcp') || f.endsWith('/net/tcp6')) return header; throw new Error('ENOENT'); }, readdirSync: () => [], readlinkSync: () => '' };
  assert.equal(listenerConfined(5173, '/c', new Map(), empty).closed, true);
  const row = '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 91 1 0\n';
  const held = { ...empty, readFileSync: (f) => { if (f.endsWith('/net/tcp')) return header + row; if (f.endsWith('/net/tcp6')) return header; throw new Error('ENOENT'); } };
  const r = listenerConfined(5173, '/c', new Map(), held);
  assert.equal(r.ok, false);
  assert.equal(r.closed, undefined);
});

// Pinning (#1520): Docker is asked on every confined open, not only when nothing listens. With userland-proxy
// off a publish binds no host port, so the confined app's listener passes the check while Docker's DNAT takes the
// relay's loopback dial to the container. Fixtures stand in for Docker's answers: this box's Docker runs with
// userland-proxy on, which can't be turned off without restarting the daemon under the owner's containers.
test('a Docker publish the loopback dial could reach refuses a confined port, even with a confined listener on it (#1520)', async () => {
  const orch = await fakeOrchestrator();
  const confine = { checkout: '/home/a/termag/projects/x' };
  const vouched = () => ({ ok: true });
  try {
    for (const [ip, why] of [['0.0.0.0', 'the IPv4 wildcard'], ['', 'no address (all)'], ['::', 'the IPv6 wildcard'], ['127.0.0.1', 'loopback'], ['::1', 'IPv6 loopback']]) {
      const { t, checked } = tunnels(orch, { listenerConfined: vouched, dockerBindings: async () => [{ ip }] });
      const r = await t.openPreviewTunnel({ tunnelId: newId(), port: 3000, confine });
      assert.equal(r.code, 'port_refused', `a publish on ${why}`);
      assert.match(r.reason, /Docker publishes port 3000, where the relay's loopback dial could reach the container/);
      assert.deepEqual(checked, [], 'refused before any look at the port');
    }
    // Userland-proxy on: docker-proxy holds a host socket the agent can't vouch for, and the publish refuses too.
    const { t: proxied } = tunnels(orch, { listenerConfined: () => ({ ok: false, reason: 'a socket on port 3000 (inode 9) has no holder this user can see' }), dockerBindings: async () => [{ ip: '0.0.0.0' }] });
    assert.equal((await proxied.openPreviewTunnel({ tunnelId: newId(), port: 3000, confine })).code, 'port_refused');
    // A Docker that can't be asked: refused, whatever listens.
    const { t: blind } = tunnels(orch, { listenerConfined: vouched, dockerBindings: async () => null });
    assert.match((await blind.openPreviewTunnel({ tunnelId: newId(), port: 3000, confine })).reason, /Docker can't be asked whether it publishes port 3000/);
    // A publish only on another address doesn't take the loopback dial; no publish at all: the confined listener is
    // vouched for, and the open goes on to the guard.
    for (const bindings of [[{ ip: '192.168.1.10' }], []]) {
      const { t, checked } = tunnels(orch, { listenerConfined: vouched, dockerBindings: async () => bindings });
      await t.openPreviewTunnel({ tunnelId: newId(), port: 3000, confine }).catch(() => {});
      assert.deepEqual(checked, [3000], `bindings ${JSON.stringify(bindings)}: on to the guard`);
    }
  } finally {
    orch.close();
  }
});

// Pinning (#1520): who accepted the relay's dial is checked after the connect, not only who listened before
// it: an app that exits, or a process that takes the port by SO_REUSEPORT in between, gets the dial closed.
test('a dial accepted by a process that is not a vouched run is closed and refused (#1520)', async () => {
  const orch = await fakeOrchestrator();
  const app = http.createServer((req, res) => res.end('hi'));
  const port = await listen(app);
  const asked = [];
  try {
    const { t } = tunnels(orch, { listenerConfined: () => ({ ok: true }), dockerBindings: async () => [], acceptedConfined: async (dial, checkout) => { asked.push([dial.port, typeof dial.peerPort, dial.host, dial.peerHost, checkout]); return { ok: false, reason: 'the connection to port ' + dial.port + " was accepted by a process that isn't a vouched termag preview run of this checkout" }; } });
    const r = await t.openPreviewTunnel({ tunnelId: newId(), port, confine: { checkout: '/home/a/termag/projects/x' } });
    assert.equal(r.code, 'port_refused');
    assert.match(r.reason, /accepted by a process that isn't a vouched termag preview run/);
    // The relay's own connection, as the accepting side sees it: its whole 4-tuple (Bugbot and Devin, #1667).
    assert.deepEqual(asked, [[port, 'number', '127.0.0.1', '127.0.0.1', '/home/a/termag/projects/x']]);
    assert.equal(orch.dials.length, 0, 'no dial back for a refused tunnel');
  } finally {
    app.close();
    orch.close();
  }
});

// Pinning (#1667): a vouched run that never accepted in time isn't told to start with termag preview run.
test('a dial a vouched run was too slow to accept is refused as a failed tunnel, not as unconfined (#1667)', async () => {
  const orch = await fakeOrchestrator();
  const app = http.createServer((req, res) => res.end('hi'));
  const port = await listen(app);
  try {
    const { t } = tunnels(orch, { listenerConfined: () => ({ ok: true }), dockerBindings: async () => [], acceptedConfined: async () => ({ ok: false, slow: true, reason: `the app on port ${port} didn't accept the connection within 10 s` }) });
    const r = await t.openPreviewTunnel({ tunnelId: newId(), port, confine: { checkout: '/home/a/termag/projects/x' } });
    assert.equal(r.code, 'tunnel_failed');
    assert.match(r.reason, /didn't accept the connection within 10 s/);
    assert.doesNotMatch(r.reason, /termag preview run/);
    assert.equal(orch.dials.length, 0);
  } finally {
    app.close();
    orch.close();
  }
});

// Pinning (Bugbot, #1667): the orchestrator drops a tunnel's id after its 15 s TTL, and the dial back comes after the
// post-connect check, so the check gets only what's left of the open's budget, the time before it spent included.
test('the accept wait gets what is left of the open budget, leaving the dial back its time under the 15 s TTL (Bugbot, #1667)', async () => {
  const { ACCEPT_BUDGET_MS } = require('./port-tunnel');
  assert.ok(ACCEPT_BUDGET_MS <= 15_000 - 5_000, `budget ${ACCEPT_BUDGET_MS} ms leaves the dial back at least 5 s`);
  const orch = await fakeOrchestrator();
  const app = http.createServer((req, res) => res.end('ok'));
  const port = await listen(app);
  let clock = 1_000_000;
  const waits = [];
  try {
    // The probe before the dial took 3 s (a blocked loop): the wait gets the rest.
    const { t } = tunnels(orch, { now: () => clock, checkPreviewPort: async () => { clock += 3000; return { ok: true, dialHost: '127.0.0.1' }; }, listenerConfined: () => ({ ok: true }), dockerBindings: async () => [], acceptedConfined: async (_d, _c, opts) => { waits.push(opts.waitMs); return { ok: true }; } });
    await t.openPreviewTunnel({ tunnelId: newId(), port, confine: { checkout: '/home/a/termag/projects/x' } });
    assert.deepEqual(waits, [ACCEPT_BUDGET_MS - 3000]);
  } finally {
    app.close();
    orch.close();
  }
});

test('a confined target the registry vouches for still goes through the guard (SR6), then dials back', async () => {
  const orch = await fakeOrchestrator();
  const app = http.createServer((req, res) => res.end('ok'));
  const port = await listen(app);
  try {
    const { t, checked } = tunnels(orch, { listenerConfined: () => ({ ok: true }), acceptedConfined: async () => ({ ok: true }) });
    assert.deepEqual(await t.openPreviewTunnel({ tunnelId: newId(), port, confine: { checkout: '/home/a/termag/projects/x' } }), { ok: true, port, dialHost: '127.0.0.1' });
    assert.deepEqual(checked, [port]);
    assert.equal(orch.dials.length, 1);
  } finally {
    app.close();
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
