'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PORT_CHECK_TTL_MS, checkPort, clearPortCache } = require('./port-guard');

const ME = 1001;
const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const hexPort = (port) => port.toString(16).toUpperCase().padStart(4, '0');
let sl = 0;
const row = (addrHex, port, uid, inode, st = '0A') => `  ${sl++}: ${addrHex}:${hexPort(port)} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const V4 = { lo: '0100007F', lo2: '0200007F', any: '00000000', priv: '0501000A' };
const V6 = { lo: '00000000000000000000000001000000', any: '0'.repeat(32), mappedLo: '0000000000000000FFFF00000100007F' };

let tmp;
let home;
let outside;
let dockerSocket;
let dockerServer;
let containers = [];
let dockerAsked = 0;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'port-guard-'));
  home = path.join(tmp, 'home');
  outside = path.join(tmp, 'elsewhere');
  fs.mkdirSync(path.join(home, 'webapp', 'dev-stack'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'dev-stack'), { recursive: true });
  dockerSocket = path.join(tmp, 'docker.sock');
  dockerServer = http.createServer((req, res) => {
    dockerAsked++;
    const url = new URL(req.url, 'http://docker');
    if (url.pathname !== '/containers/json') { res.writeHead(404).end('{}'); return; }
    const filters = JSON.parse(url.searchParams.get('filters') || '{}');
    const wanted = Number((filters.publish || [])[0]);
    const list = containers.filter((c) => c.Ports.some((p) => p.PublicPort === wanted));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  });
  await new Promise((resolve) => dockerServer.listen(dockerSocket, resolve));
});

after(async () => {
  await new Promise((resolve) => dockerServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A /proc root holding these net/tcp and net/tcp6 rows, and checkPort's deps for it. */
function box({ tcp = '', tcp6 = '' } = {}, over = {}) {
  const procRoot = fs.mkdtempSync(path.join(tmp, 'proc-'));
  fs.mkdirSync(path.join(procRoot, 'net'));
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), header + tcp);
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp6'), header + tcp6);
  return { procRoot, uid: ME, home, dockerSocket, cache: new Map(), ...over };
}

const compose = (workingDir, ...ports) => ({
  Id: 'c', Labels: workingDir === null ? {} : { 'com.docker.compose.project.working_dir': workingDir },
  Ports: ports.map(([IP, PublicPort, Type = 'tcp']) => ({ IP, PrivatePort: 3000, PublicPort, Type })),
});

test('own uid on loopback is allowed, IPv4 dialing 127.0.0.1', async () => {
  containers = [];
  assert.deepEqual(await checkPort(5173, box({ tcp: row(V4.lo, 5173, ME, 11) })), { ok: true, dialHost: '127.0.0.1' });
  // An IPv4-mapped 127.0.0.1 in tcp6 is the same address.
  assert.deepEqual(await checkPort(5173, box({ tcp6: row(V6.mappedLo, 5173, ME, 12) })), { ok: true, dialHost: '127.0.0.1' });
});

test('own uid on a wildcard is allowed (Rspack on *:3002)', async () => {
  containers = [];
  assert.deepEqual(await checkPort(3002, box({ tcp: row(V4.any, 3002, ME, 21) })), { ok: true, dialHost: '127.0.0.1' });
  // A dual-stack `::` beside it doesn't take IPv4 from 0.0.0.0's socket.
  assert.deepEqual(await checkPort(3002, box({ tcp: row(V4.any, 3002, ME, 21), tcp6: row(V6.any, 3002, 1002, 22) })), { ok: true, dialHost: '127.0.0.1' });
});

test('another uid is refused, wherever it listens', async () => {
  containers = [];
  for (const rows of [{ tcp: row(V4.lo, 8080, 1002, 31) }, { tcp: row(V4.any, 8080, 1002, 31) }, { tcp6: row(V6.lo, 8080, 1002, 31) }]) {
    const r = await checkPort(8080, box(rows));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'port_refused');
    assert.match(r.reason, /uid 1002, not this user/);
  }
  // Every socket of the kind that takes the stream must pass: SO_REUSEPORT shares it out.
  const r = await checkPort(8080, box({ tcp: row(V4.lo, 8080, ME, 32) + row(V4.lo, 8080, 1002, 33) }));
  assert.equal(r.code, 'port_refused');
});

test('root that is not a Docker publish is refused', async () => {
  containers = [];
  let r = await checkPort(631, box({ tcp: row(V4.lo, 631, 0, 41) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /root listener on 127\.0\.0\.1:631 is not a Docker publish/);
  // Docker publishes the port, but on another address than the root socket's.
  containers = [compose(path.join(home, 'webapp', 'dev-stack'), ['127.0.0.2', 631])];
  r = await checkPort(631, box({ tcp: row(V4.lo, 631, 0, 41) }));
  assert.equal(r.code, 'port_refused');
  // Docker can't be asked: no proof the root socket is its.
  r = await checkPort(631, box({ tcp: row(V4.lo, 631, 0, 41) }, { dockerSocket: path.join(tmp, 'no-such.sock') }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /Docker can't be asked/);
});

test('a Docker publish from a compose project under home is allowed (varnish, the flag dev-server)', async () => {
  const devStack = path.join(home, 'webapp', 'dev-stack');
  containers = [compose(devStack, ['127.0.0.1', 80])];
  assert.deepEqual(await checkPort(80, box({ tcp: row(V4.lo, 80, 0, 51) })), { ok: true, dialHost: '127.0.0.1' });
  // A wildcard publish: docker-proxy holds 0.0.0.0 and ::.
  containers = [compose(devStack, ['0.0.0.0', 8765], ['::', 8765])];
  assert.deepEqual(await checkPort(8765, box({ tcp: row(V4.any, 8765, 0, 52), tcp6: row(V6.any, 8765, 0, 53) })), { ok: true, dialHost: '127.0.0.1' });
  // Only an IPv6 publish: dial ::1.
  containers = [compose(devStack, ['::', 8765])];
  assert.deepEqual(await checkPort(8765, box({ tcp6: row(V6.any, 8765, 0, 53) })), { ok: true, dialHost: '::1' });
});

test('a UDP-only publish from under home does not vouch for a root TCP listener on the port', async () => {
  const devStack = path.join(home, 'webapp', 'dev-stack');
  containers = [compose(devStack, ['0.0.0.0', 22, 'udp'])];
  let r = await checkPort(22, box({ tcp: row(V4.any, 22, 0, 121) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /root listener on 0\.0\.0\.0:22 is not a Docker publish/);
  // Docker lists a container's every binding: its UDP one on 127.0.0.1 doesn't count beside a TCP one elsewhere.
  containers = [compose(devStack, ['127.0.0.1', 631, 'udp'], ['127.0.0.2', 631])];
  assert.equal((await checkPort(631, box({ tcp: row(V4.lo, 631, 0, 122) }))).code, 'port_refused');
  // userland-proxy: false, nothing listening: a UDP publish is no TCP one either.
  containers = [compose(devStack, ['127.0.0.1', 7002, 'udp'])];
  assert.equal((await checkPort(7002, box())).code, 'port_closed');
  // The TCP publish is still allowed.
  containers = [compose(devStack, ['0.0.0.0', 22, 'udp'], ['0.0.0.0', 22])];
  assert.deepEqual(await checkPort(22, box({ tcp: row(V4.any, 22, 0, 121) })), { ok: true, dialHost: '127.0.0.1' });
});

test('a Docker publish from outside home, or without a compose project, is refused', async () => {
  containers = [compose(path.join(outside, 'dev-stack'), ['127.0.0.1', 80])];
  let r = await checkPort(80, box({ tcp: row(V4.lo, 80, 0, 61) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /outside this user's home/);
  // `home` as a prefix string isn't enough: /…/home-other is not inside /…/home.
  fs.mkdirSync(`${home}-other`, { recursive: true });
  containers = [compose(`${home}-other`, ['127.0.0.1', 80])];
  assert.equal((await checkPort(80, box({ tcp: row(V4.lo, 80, 0, 61) }))).code, 'port_refused');
  containers = [compose(null, ['127.0.0.1', 80])];
  r = await checkPort(80, box({ tcp: row(V4.lo, 80, 0, 61) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /not a compose project/);
});

test('127.0.0.2 and other addresses are refused', async () => {
  containers = [];
  let r = await checkPort(3012, box({ tcp: row(V4.lo2, 3012, ME, 71) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /listens only on 127\.0\.0\.2/);
  r = await checkPort(3012, box({ tcp: row(V4.priv, 3012, ME, 72) + row(V4.lo2, 3012, ME, 73) }));
  assert.match(r.reason, /listens only on 10\.0\.1\.5, 127\.0\.0\.2/);
  r = await checkPort(3012, box({ tcp6: row('B80D0120000000000000000001000000', 3012, ME, 74) }));
  assert.match(r.reason, /a non-loopback IPv6 address/);
  // Beside an own 127.0.0.1 socket, another slot's 127.0.0.2 never takes the stream.
  assert.deepEqual(await checkPort(3012, box({ tcp: row(V4.lo2, 3012, 1002, 75) + row(V4.lo, 3012, ME, 76) })), { ok: true, dialHost: '127.0.0.1' });
});

test('an IPv6-only listener dials ::1', async () => {
  containers = [];
  assert.deepEqual(await checkPort(4000, box({ tcp6: row(V6.lo, 4000, ME, 81) })), { ok: true, dialHost: '::1' });
  // A lone `::` may be IPv6-only; ::1 reaches it either way.
  assert.deepEqual(await checkPort(4000, box({ tcp6: row(V6.any, 4000, ME, 82) })), { ok: true, dialHost: '::1' });
  // ::1's own socket takes ::1 from a `::` one.
  assert.deepEqual(await checkPort(4000, box({ tcp6: row(V6.any, 4000, 1002, 83) + row(V6.lo, 4000, ME, 84) })), { ok: true, dialHost: '::1' });
  // Any IPv4 listener decides instead, and is dialed.
  assert.deepEqual(await checkPort(4000, box({ tcp: row(V4.lo, 4000, ME, 85), tcp6: row(V6.lo, 4000, ME, 86) })), { ok: true, dialHost: '127.0.0.1' });
});

test('no listener answers port_closed; a listening row in another state is none', async () => {
  containers = [];
  assert.deepEqual(await checkPort(9999, box({ tcp: row(V4.lo, 9999, ME, 91, '01') + row(V4.lo, 9998, ME, 92) })), { ok: false, code: 'port_closed', reason: 'nothing listens on port 9999' });
  // No kernel tables at all (not Linux): refused with a reason, never a
  // misleading port_closed.
  const noProc = path.join(tmp, 'nope');
  assert.deepEqual(await checkPort(9999, { procRoot: noProc, uid: ME, home, dockerSocket, cache: new Map() }), { ok: false, code: 'port_refused', reason: `this host has no ${noProc}/net/tcp to tell who listens on port 9999` });
  assert.equal((await checkPort(0, box())).code, 'port_refused');
  assert.equal((await checkPort(65536, box())).code, 'port_refused');
  assert.equal((await checkPort('80', box())).code, 'port_refused');
});

test('userland-proxy: false: a publish with no LISTEN row goes by the Docker rule', async () => {
  containers = [compose(path.join(home, 'webapp', 'dev-stack'), ['127.0.0.1', 7001])];
  assert.deepEqual(await checkPort(7001, box()), { ok: true, dialHost: '127.0.0.1' });
  containers = [compose(path.join(outside, 'dev-stack'), ['0.0.0.0', 7001])];
  assert.equal((await checkPort(7001, box())).code, 'port_refused');
  // Both addresses published: each container must pass.
  containers = [compose(path.join(home, 'webapp', 'dev-stack'), ['127.0.0.1', 7001]), compose(path.join(outside, 'dev-stack'), ['0.0.0.0', 7001])];
  assert.equal((await checkPort(7001, box())).code, 'port_refused');
  // Docker down, nothing listening: closed.
  assert.equal((await checkPort(7001, box({}, { dockerSocket: path.join(tmp, 'no-such.sock') }))).code, 'port_closed');
});

test('a more specific listener shadows a wildcard publish', async () => {
  const devStack = path.join(home, 'webapp', 'dev-stack');
  containers = [compose(devStack, ['0.0.0.0', 80])];
  // Someone else's socket on 127.0.0.1:80 takes the stream, not docker-proxy's 0.0.0.0.
  let r = await checkPort(80, box({ tcp: row(V4.any, 80, 0, 101) + row(V4.lo, 80, 1002, 102) }));
  assert.equal(r.code, 'port_refused');
  assert.match(r.reason, /127\.0\.0\.1:80 belongs to uid 1002/);
  // A root socket on 127.0.0.1 beside it isn't the publish either (Docker binds 0.0.0.0).
  r = await checkPort(80, box({ tcp: row(V4.any, 80, 0, 101) + row(V4.lo, 80, 0, 103) }));
  assert.match(r.reason, /root listener on 127\.0\.0\.1:80 is not a Docker publish/);
  // The user's own 127.0.0.1 socket is theirs to reach.
  assert.deepEqual(await checkPort(80, box({ tcp: row(V4.any, 80, 0, 101) + row(V4.lo, 80, ME, 104) })), { ok: true, dialHost: '127.0.0.1' });
  // The other way round: an own wildcard, and a publish from outside home on 127.0.0.1 that takes it.
  containers = [compose(path.join(outside, 'dev-stack'), ['127.0.0.1', 80])];
  r = await checkPort(80, box({ tcp: row(V4.any, 80, ME, 105) + row(V4.lo, 80, 0, 106) }));
  assert.match(r.reason, /outside this user's home/);
});

test('port_closed is never cached: a listener that appears right after is seen at once', async () => {
  containers = [];
  const now = 2_000_000;
  const deps = box({}, { now: () => now });
  const [a, b] = await Promise.all([checkPort(5174, deps), checkPort(5174, deps)]);
  assert.equal(a.code, 'port_closed');
  assert.equal(b, a, 'concurrent checks still share one look');
  assert.equal(deps.cache.has(5174), false);
  // The dev server starts, within the same millisecond: seen at once.
  fs.writeFileSync(path.join(deps.procRoot, 'net', 'tcp'), header + row(V4.lo, 5174, ME, 131));
  assert.deepEqual(await checkPort(5174, deps), { ok: true, dialHost: '127.0.0.1' });
  // And that allowed verdict is cached: the server stopping isn't seen until it expires or is cleared.
  fs.writeFileSync(path.join(deps.procRoot, 'net', 'tcp'), header);
  assert.equal((await checkPort(5174, deps)).ok, true);
  clearPortCache(5174, deps.cache);
  assert.equal((await checkPort(5174, deps)).code, 'port_closed');
  // A refused verdict is cached like an allowed one.
  fs.writeFileSync(path.join(deps.procRoot, 'net', 'tcp'), header + row(V4.lo, 5174, 1002, 132));
  assert.equal((await checkPort(5174, deps)).code, 'port_refused');
  fs.writeFileSync(path.join(deps.procRoot, 'net', 'tcp'), header + row(V4.lo, 5174, ME, 133));
  assert.equal((await checkPort(5174, deps)).code, 'port_refused', 'refused stays cached for 5 s');
});

test('the verdict is cached per port for 5 s, and can be cleared', async () => {
  const devStack = path.join(home, 'webapp', 'dev-stack');
  containers = [compose(devStack, ['127.0.0.1', 80])];
  let now = 1_000_000;
  const deps = box({ tcp: row(V4.lo, 80, 0, 111) }, { now: () => now });
  const asked = dockerAsked;
  const [a, b] = await Promise.all([checkPort(80, deps), checkPort(80, deps)]);
  assert.deepEqual(a, { ok: true, dialHost: '127.0.0.1' });
  assert.equal(b, a, 'concurrent checks share one look');
  assert.equal(dockerAsked, asked + 1);
  // The container goes; within 5 s the verdict stands.
  containers = [];
  now += PORT_CHECK_TTL_MS - 1;
  assert.deepEqual(await checkPort(80, deps), { ok: true, dialHost: '127.0.0.1' });
  assert.equal(dockerAsked, asked + 1);
  now += 1;
  assert.equal((await checkPort(80, deps)).code, 'port_refused', 'expired after 5 s');
  assert.equal(dockerAsked, asked + 2);
  // A clock going backwards doesn't keep an old verdict alive.
  containers = [compose(devStack, ['127.0.0.1', 80])];
  now -= 60_000;
  assert.equal((await checkPort(80, deps)).ok, true);
  // clearPortCache: one port, or all.
  containers = [];
  clearPortCache(80, deps.cache);
  assert.equal((await checkPort(80, deps)).ok, false);
  containers = [compose(devStack, ['127.0.0.1', 80])];
  clearPortCache(undefined, deps.cache);
  assert.equal(deps.cache.size, 0);
  assert.equal((await checkPort(80, deps)).ok, true);
  // The module's own cache, when none is given.
  const shared = { ...deps, cache: undefined };
  delete shared.cache;
  await checkPort(80, shared);
  containers = [];
  assert.equal((await checkPort(80, shared)).ok, true, 'cached in the module');
  clearPortCache(80);
  assert.equal((await checkPort(80, shared)).ok, false);
  clearPortCache();
});

test('canCheckPorts: whether the kernel tables the guard reads are there', () => {
  const { canCheckPorts } = require('./port-guard');
  assert.equal(canCheckPorts({ procRoot: box().procRoot }), true);
  const only6 = box();
  fs.rmSync(path.join(only6.procRoot, 'net', 'tcp'));
  assert.equal(canCheckPorts({ procRoot: only6.procRoot }), true, 'tcp6 alone will do');
  assert.equal(canCheckPorts({ procRoot: path.join(tmp, 'no-proc') }), false);
});
