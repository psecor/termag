'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const {
  PROXY_PORT_FIRST, PROXY_PORT_LAST, MAX_ORIGINS, MIN_MEM_AVAILABLE_BYTES,
  canonicalOrigin, originOfUrl, connectOrigin, displayOrigin, GuestProxy, readDevStackOverride, webappSlotOrigins,
  publisherWorkingDir, resolveRecipe, canaryHtml, Canary, guestEnvironment, memAvailableBytes, checkoutState,
} = require('./browser-guest');

const listen = (server, host = '127.0.0.1') => new Promise((r) => server.listen(0, host, () => r(server.address().port)));

test('the proxy port range is the one the box egress rule allows (deploy/termag-guest-browser.nft)', () => {
  assert.equal(PROXY_PORT_FIRST, 47100);
  assert.equal(PROXY_PORT_LAST, 47131);
});

test('canonicalOrigin: loopback only, one spelling per address, explicit or default port', () => {
  const same = ['127.0.0.1:80', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.0.0.1./', 'localhost', 'http://LocalHost/x?y'];
  for (const s of same) assert.equal(canonicalOrigin(s), '127.0.0.1:80', s);
  assert.equal(canonicalOrigin('https://127.0.0.2/'), '127.0.0.2:443');
  assert.equal(canonicalOrigin('ws://127.0.0.2:3012/hmr'), '127.0.0.2:3012');
  assert.equal(canonicalOrigin('wss://127.0.0.2/'), '127.0.0.2:443');
  assert.equal(canonicalOrigin('[::1]:3000'), '[::1]:3000');
  assert.equal(canonicalOrigin('http://[::1]/'), '[::1]:80');
  for (const s of ['http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/', 'http://[::]/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://example.com/',
    'http://user:pw@127.0.0.1/', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://127.0.0.1/', 'http://127.0.0.1:0/', 'http://127.0.0.1:99999/', '', null, 42, 'x'.repeat(400)]) {
    assert.equal(canonicalOrigin(s), null, String(s));
  }
  // A grant's origin must name its port.
  assert.equal(canonicalOrigin('127.0.0.2', { requirePort: true }), null);
  assert.equal(canonicalOrigin('127.0.0.2:80', { requirePort: true }), '127.0.0.2:80');
  assert.equal(canonicalOrigin('http://127.0.0.2/', { requirePort: true }), '127.0.0.2:80', 'a URL carries its scheme default');
});

test('originOfUrl: about:blank is always fine; connectOrigin takes an authority, never a URL', () => {
  assert.equal(originOfUrl('about:blank'), '');
  assert.equal(originOfUrl('http://127.0.0.2:3012/x'), '127.0.0.2:3012');
  assert.equal(originOfUrl('http://example.com/'), null);
  assert.equal(connectOrigin('127.0.0.2:3012'), '127.0.0.2:3012');
  assert.equal(connectOrigin('[::1]:443'), '[::1]:443');
  for (const s of ['example.com:443', '127.0.0.1', 'http://127.0.0.1:80/', '/x', '127.0.0.1:80/x', '']) assert.equal(connectOrigin(s), null, s);
});

test('safeAtPath and urlAt: a link\'s at is a path on the share\'s first origin, nothing else', () => {
  const { safeAtPath, urlAt } = require('./browser-guest');
  assert.equal(safeAtPath('/default/production/features/my-flag'), '/default/production/features/my-flag');
  assert.equal(safeAtPath('/x?y=1#z'), '/x?y=1#z');
  for (const bad of ['//169.254.169.254/latest', '/\\169.254.169.254/x', '\\\\evil.example/x', '/\t/evil.example/x', 'https://example.com/', 'javascript:alert(1)',
    '%2F%2Fevil.example', '/%2F%2Fevil.example', '/%5Cevil.example', 'relative', '', null, '/x'.repeat(2000)]) {
    assert.equal(safeAtPath(bad), null, String(bad));
  }
  assert.equal(urlAt('http://127.0.0.2/', '/flags?x=1'), 'http://127.0.0.2/flags?x=1');
  assert.equal(urlAt('https://127.0.0.1:4443/', '/a'), 'https://127.0.0.1:4443/a');
  assert.equal(urlAt('http://127.0.0.2/', '//example.com/'), null);
  assert.equal(urlAt('http://127.0.0.2/', '/@example.com/'), 'http://127.0.0.2/@example.com/', 'userinfo can only appear before the host');
  assert.equal(urlAt('http://127.0.0.2/', null), null);
});

test('displayOrigin: a refused request is reported as host:port, never its path or query', () => {
  assert.equal(displayOrigin('http://clients2.google.com/time/1/current?cup2key=secret'), 'clients2.google.com:80');
  assert.equal(displayOrigin('www.google.com:443'), 'www.google.com:443');
  assert.equal(displayOrigin('https://unpkg.com/x'), 'unpkg.com:443');
  assert.equal(displayOrigin('::::'), 'unknown');
  assert.equal(displayOrigin(''), 'unknown');
  assert.equal(displayOrigin('/relative'), 'unknown', 'a path has no origin');
});

test('GuestProxy: forwards an allowed absolute-URI request to the matched origin, refuses the rest', async (t) => {
  const seen = [];
  const app = http.createServer((req, res) => { seen.push({ url: req.url, host: req.headers.host, proxy: req.headers['proxy-connection'] }); res.end(`hi ${req.url}`); });
  const appPort = await listen(app);
  const other = http.createServer((req, res) => res.end('other'));
  const otherPort = await listen(other);
  const blocked = [];
  const proxy = new GuestProxy({ origins: [`127.0.0.1:${appPort}`], onBlocked: (b) => blocked.push(b) });
  const port = await proxy.listen(47190, 47199);
  t.after(() => { proxy.close(); app.close(); other.close(); });
  assert.ok(port >= 47190 && port <= 47199);
  const viaProxy = (url, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
  // Allowed: the path and Host go through, the proxy's own headers don't.
  let r = await viaProxy(`http://127.0.0.1:${appPort}/a?b=1`, { host: `127.0.0.1:${appPort}`, 'proxy-connection': 'keep-alive' });
  assert.deepEqual([r.status, r.body], [200, 'hi /a?b=1']);
  assert.equal(seen[0].proxy, undefined);
  // localhost is the same origin, resolved without DNS.
  r = await viaProxy(`http://localhost:${appPort}/l`);
  assert.equal(r.status, 200);
  // A Host header naming another app changes nothing: the matched tuple is what is reached.
  r = await viaProxy(`http://127.0.0.1:${appPort}/h`, { host: `127.0.0.1:${otherPort}` });
  assert.deepEqual([r.status, r.body], [200, 'hi /h']);
  // Refused: another loopback port, IMDS, the internet, and origin-form requests.
  for (const url of [`http://127.0.0.1:${otherPort}/`, 'http://169.254.169.254/latest/meta-data/', 'http://example.com/', '/relative']) {
    r = await viaProxy(url);
    assert.equal(r.status, 403, url);
  }
  assert.deepEqual(blocked.map((b) => [b.origin, b.local]), [[`127.0.0.1:${otherPort}`, true], ['169.254.169.254:80', false], ['example.com:80', false], ['unknown', false]]);
  // Reported at most once per origin in a while, counted every time.
  await viaProxy(`http://127.0.0.1:${otherPort}/again`);
  assert.equal(blocked.length, 4);
  assert.equal(proxy.denials.get(`127.0.0.1:${otherPort}`), 2);
});

test('procAddress reads the kernel\'s hex addresses, IPv4, the IPv6 wildcard and IPv4-mapped', () => {
  const { procAddress } = require('./browser-guest');
  assert.equal(procAddress('0200007F'), '127.0.0.2');
  assert.equal(procAddress('00000000'), '0.0.0.0');
  assert.equal(procAddress('0'.repeat(32)), '::');
  assert.equal(procAddress('0000000000000000FFFF00000200007F'), '127.0.0.2');
  assert.equal(procAddress('B80D0120000000000000000001000000'), 'other-v6');
  assert.equal(procAddress('nope'), null);
});

test('listenersOn: the listening sockets on that address or a wildcard, with the process that holds each', () => {
  const { listenersOn } = require('./browser-guest');
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const row = (addr, port, st, inode) => `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1001        0 ${inode} 1 0\n`;
  const files = {
    '/proc/net/tcp': header + row('0200007F', 3012, '0A', '111') + row('0300007F', 3012, '0A', '222') + row('0200007F', 3012, '01', '333') + row('00000000', 9000, '0A', '444'),
    '/proc/net/tcp6': header + row('0'.repeat(32), 3012, '0A', '555'),
  };
  const fds = { 10: ['3'], 20: ['4'] };
  const links = { '/proc/10/fd/3': 'socket:[111]', '/proc/10/cwd': '/w/static', '/proc/20/fd/4': 'socket:[555]', '/proc/20/cwd': '/other' };
  const io = {
    readFileSync: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    readdirSync: (d) => { if (d === '/proc') return ['10', '20', '30', 'self']; const pid = d.split('/')[2]; if (!fds[pid]) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fds[pid]; },
    readlinkSync: (l) => { if (!(l in links)) throw new Error('ENOENT'); return links[l]; },
  };
  // 127.0.0.2:3012: its own socket takes the connection, so the unrelated `::` one beside it
  // doesn't count; nor do 127.0.0.3's or a connected one.
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io), [{ pid: 10, cwd: '/w/static' }]);
  // With nothing bound to the address itself, the wildcard that would take it: 0.0.0.0 before ::.
  files['/proc/net/tcp'] = header + row('00000000', 3012, '0A', '444') + row('0300007F', 3012, '0A', '222');
  links['/proc/10/fd/3'] = 'socket:[444]';
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io), [{ pid: 10, cwd: '/w/static' }]);
  files['/proc/net/tcp'] = header;
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io), [{ pid: 20, cwd: '/other' }], 'a lone :: counts: the tables don\'t show v6-only');
  // A socket on the address itself takes it from a 0.0.0.0 one too, and exactOnly asks for just those.
  files['/proc/net/tcp'] = header + row('00000000', 3012, '0A', '444') + row('0200007F', 3012, '0A', '111');
  links['/proc/10/fd/3'] = 'socket:[111]';
  links['/proc/20/fd/4'] = 'socket:[444]';
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io), [{ pid: 10, cwd: '/w/static' }], 'the address\'s own socket, not 0.0.0.0\'s');
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io, { exactOnly: true }), [{ pid: 10, cwd: '/w/static' }]);
  files['/proc/net/tcp'] = header + row('00000000', 3012, '0A', '444');
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io), [{ pid: 20, cwd: '/other' }]);
  assert.deepEqual(listenersOn('127.0.0.2', 3012, io, { exactOnly: true }), [], 'exactOnly: a wildcard alone is no such socket');
  links['/proc/20/fd/4'] = 'socket:[555]';
  files['/proc/net/tcp'] = header + row('0200007F', 3012, '0A', '111') + row('0300007F', 3012, '0A', '222') + row('0200007F', 3012, '01', '333') + row('00000000', 9000, '0A', '444');
  links['/proc/10/fd/3'] = 'socket:[111]';
  // A wildcard socket nobody this user can see holds.
  assert.deepEqual(listenersOn('127.0.0.2', 9000, io), [{ pid: null, cwd: null }]);
  assert.deepEqual(listenersOn('127.0.0.2', 8765, io), []);
});

test('ownedOrigins: only what this checkout serves; another\'s, or an owner it can\'t tell, is left out', async () => {
  const { ownedOrigins } = require('./browser-guest');
  const slot = { origins: ['127.0.0.2:80', '127.0.0.2:3012', '127.0.0.2:8765'], frontPort: 80 };
  const none = { workingDir: '', boundIp: null };
  const on8765 = (workingDir, boundIp = '127.0.0.2') => async (_h, p) => (p === 8765 ? { workingDir, boundIp } : none);
  const deps = (over) => ({ sameDir: (a, b) => a === b, insideDir: (c, d) => c === d || c.startsWith(`${d}/`), dockerPublisher: async () => none, listenersOn: () => [], ...over });
  // Nothing listening yet: kept; the front door is never asked again.
  assert.deepEqual(await ownedOrigins(slot, '/w', deps()), { origins: slot.origins, dropped: [] });
  // Docker: this checkout's stack kept, another's left out.
  let r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/other/dev-stack') }));
  assert.deepEqual(r.dropped, [{ origin: '127.0.0.2:8765', why: 'published by another checkout' }]);
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack') }));
  assert.deepEqual(r.dropped, []);
  // A publish on 0.0.0.0 loses the address's connections to a socket bound to it: that one must be ours.
  const exact = (who) => (_h, p, _io, opts) => (p === 8765 && opts && opts.exactOnly ? who : []);
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack', '0.0.0.0'), listenersOn: exact([{ pid: 9, cwd: '/w2' }]) }));
  assert.deepEqual(r.dropped, [{ origin: '127.0.0.2:8765', why: 'pid 9, outside the checkout, listens on 127.0.0.2' }]);
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack', '0.0.0.0'), listenersOn: exact([{ pid: null, cwd: null }]) }));
  assert.deepEqual(r.dropped, [{ origin: '127.0.0.2:8765', why: 'a listener on 127.0.0.2 that is not this user\'s takes it' }]);
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack', '0.0.0.0'), listenersOn: exact([{ pid: 9, cwd: '/w/static' }]) }));
  assert.deepEqual(r.dropped, [], 'a socket of the checkout\'s own is fine');
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack', '0.0.0.0') }));
  assert.deepEqual(r.dropped, [], 'nothing bound to the address itself');
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: on8765('/w/dev-stack'), listenersOn: exact([{ pid: null, cwd: null }]) }));
  assert.deepEqual(r.dropped, [], 'a publish on the address itself is that socket (docker\'s, not ours to see)');
  // Docker can't be asked: the listener decides, and a root-owned docker-proxy is one this user can't see.
  r = await ownedOrigins(slot, '/w', deps({ dockerPublisher: async () => null, listenersOn: (_h, p) => (p === 8765 ? [{ pid: null, cwd: null }] : []) }));
  assert.deepEqual(r, { origins: ['127.0.0.2:80', '127.0.0.2:3012'], dropped: [{ origin: '127.0.0.2:8765', why: 'its listener is not this user\'s' }] });
  // A process: inside the checkout kept; outside it, or one this user can't see, left out.
  r = await ownedOrigins(slot, '/w', deps({ listenersOn: (_h, p) => (p === 3012 ? [{ pid: 7, cwd: '/w/static' }] : []) }));
  assert.deepEqual(r.origins, slot.origins);
  r = await ownedOrigins(slot, '/w', deps({ listenersOn: (_h, p) => (p === 3012 ? [{ pid: 7, cwd: '/w/static' }, { pid: 8, cwd: '/w2' }] : []) }));
  assert.deepEqual(r, { origins: ['127.0.0.2:80', '127.0.0.2:8765'], dropped: [{ origin: '127.0.0.2:3012', why: 'pid 8 runs outside the checkout' }] });
  r = await ownedOrigins(slot, '/w', deps({ listenersOn: (_h, p) => (p === 3012 ? [{ pid: null, cwd: null }] : []) }));
  assert.deepEqual(r.dropped, [{ origin: '127.0.0.2:3012', why: 'its listener is not this user\'s' }]);
});

test('GuestProxy: Chromium\'s own service calls are refused and counted, never reported', () => {
  const blocked = [];
  const proxy = new GuestProxy({ origins: [], onBlocked: (b) => blocked.push(b) });
  for (const host of ['accounts.google.com:443', 'android.clients.google.com:443', 'clients2.google.com:443', 'optimizationguide-pa.googleapis.com:443', 'redirector.gvt1.com:80']) {
    proxy.deny(null, host);
  }
  assert.deepEqual(blocked, []);
  assert.equal(proxy.denials.get('accounts.google.com:443'), 1);
  // A page's own calls to Google are still reported: only these exact hosts are quiet.
  proxy.deny(null, 'fonts.googleapis.com:443');
  proxy.deny(null, 'evil.accounts.google.com:443');
  assert.deepEqual(blocked.map((b) => b.origin), ['fonts.googleapis.com:443', 'evil.accounts.google.com:443']);
});

test('GuestProxy: tunnels an allowed CONNECT, refuses any other, and allow/disallow change the set', async (t) => {
  const app = net.createServer((s) => { s.on('data', (d) => s.end(`echo:${d}`)); });
  const appPort = await listen(app);
  const proxy = new GuestProxy({ origins: [`127.0.0.1:${appPort}`] });
  const port = await proxy.listen(47190, 47199);
  t.after(() => { proxy.close(); app.close(); });
  const connect = (authority) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (/^HTTP\/1\.1 200/.test(buf) && !buf.includes('echo:') && buf.includes('\r\n\r\n')) s.write('ping');
      if (buf.includes('echo:') || /^HTTP\/1\.1 403/.test(buf)) { s.destroy(); resolve(buf); }
    });
    s.on('error', () => resolve(buf));
  });
  assert.match(await connect(`127.0.0.1:${appPort}`), /200 Connection Established[\s\S]*echo:ping/);
  assert.match(await connect('127.0.0.1:1'), /^HTTP\/1\.1 403/);
  assert.match(await connect('example.com:443'), /^HTTP\/1\.1 403/);
  proxy.disallow(`127.0.0.1:${appPort}`);
  assert.match(await connect(`127.0.0.1:${appPort}`), /^HTTP\/1\.1 403/);
  proxy.allow(`127.0.0.1:${appPort}`);
  assert.match(await connect(`127.0.0.1:${appPort}`), /echo:ping/);
});

test('GuestProxy: listen takes the next free port of its range, and fails when the range is full', async (t) => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(47195, '127.0.0.1', r));
  const proxy = new GuestProxy();
  const full = new GuestProxy();
  t.after(() => { proxy.close(); full.close(); busy.close(); });
  assert.equal(await proxy.listen(47195, 47196), 47196);
  await assert.rejects(full.listen(47195, 47196), /no free guest proxy port in 47195-47196/);
});

test('GuestProxy: an IPv6 loopback origin is reached at ::1', async (t) => {
  const app = http.createServer((req, res) => res.end('six'));
  try { await listen(app, '::1'); } catch { t.skip('no ::1 here'); return; }
  const appPort = app.address().port;
  const proxy = new GuestProxy({ origins: [`[::1]:${appPort}`] });
  const port = await proxy.listen(47190, 47199);
  t.after(() => { proxy.close(); app.close(); });
  const body = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `http://[::1]:${appPort}/`, agent: false }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); });
  });
  assert.equal(body, 'six');
});

test('readDevStackOverride keeps only the slot settings, never the rest of the file', () => {
  const text = 'EXAMPLE_API_KEY=tmag_secret\nEXAMPLE_BASE_URI=https://x\nDEV_INSTANCE=3\nDEV_VARNISH_PORT=8080\n';
  const got = readDevStackOverride('/p', () => text);
  assert.deepEqual(got, { DEV_INSTANCE: 3, DEV_VARNISH_PORT: 8080 });
  assert.equal(readDevStackOverride('/p', () => { throw new Error('ENOENT'); }), null);
  // CRLF lines, the first value of a key winning, and junk that matches nothing.
  assert.deepEqual(readDevStackOverride('/p', () => 'DEV_INSTANCE=3\r\nDEV_INSTANCE=4\r\nDEV_VARNISH_PORT=\r\n' + 'A'.repeat(100000)), { DEV_INSTANCE: 3 });
});

test('GuestProxy: dials the allowlist\'s own address for an origin, and allows only loopback origins', () => {
  const proxy = new GuestProxy({ origins: ['127.0.0.2:80', '[::1]:3000', 'example.com:80', 'http://10.0.0.1/'] });
  assert.deepEqual(proxy.upstreamFor('127.0.0.2:80'), { host: '127.0.0.2', port: 80 });
  assert.deepEqual(proxy.upstreamFor('[::1]:3000'), { host: '::1', port: 3000 });
  assert.equal(proxy.upstreamFor('example.com:80'), null, 'a non-loopback origin is never added');
  assert.equal(proxy.upstreamFor('10.0.0.1:80'), null);
  assert.equal(proxy.upstreamFor(null), null);
  proxy.disallow('127.0.0.2:80');
  assert.equal(proxy.allows('127.0.0.2:80'), false);
  assert.ok(Object.isFrozen(proxy.upstreamFor('[::1]:3000')));
});

test('webappSlotOrigins: the default slot is localhost, slot N is 127.0.0.N with its asset port, overrides win', () => {
  assert.deepEqual(webappSlotOrigins({}), { ip: '127.0.0.1', frontPort: 80, origins: ['127.0.0.1:80', '127.0.0.1:3002', '127.0.0.1:8765'], primaryUrl: 'http://localhost/' });
  assert.deepEqual(webappSlotOrigins({ DEV_INSTANCE: 2 }).origins, ['127.0.0.2:80', '127.0.0.2:3012', '127.0.0.2:8765']);
  assert.deepEqual(webappSlotOrigins({ DEV_INSTANCE: 3 }).origins, ['127.0.0.3:80', '127.0.0.3:3022', '127.0.0.3:8765']);
  const moved = webappSlotOrigins({ DEV_INSTANCE: 2, DEV_VARNISH_PORT: 8080, DEV_WEBAPP_DEVSERVER_PORT: 4000 });
  assert.deepEqual(moved.origins, ['127.0.0.2:8080', '127.0.0.2:4000', '127.0.0.2:8765']);
  assert.equal(moved.primaryUrl, 'http://127.0.0.2:8080/');
  assert.equal(webappSlotOrigins({ DEV_INSTANCE: 9 }), null);
  assert.equal(webappSlotOrigins({ DEV_INSTANCE: 1 }), null);
});

test('dockerPublisher / publisherWorkingDir: the container publishing ip:port, and the address it is bound to', async () => {
  const containers = [
    { Ports: [{ IP: '127.0.0.3', PublicPort: 80 }], Labels: { 'com.docker.compose.project.working_dir': '/other/dev-stack' } },
    { Ports: [{ IP: '127.0.0.2', PublicPort: 80 }], Labels: { 'com.docker.compose.project.working_dir': '/mine/dev-stack' } },
  ];
  const asked = [];
  const get = async (p) => { asked.push(p); return containers; };
  assert.equal(await publisherWorkingDir('127.0.0.2', 80, get), '/mine/dev-stack');
  assert.match(decodeURIComponent(asked[0]), /"publish":\["80"\]/);
  assert.equal(await publisherWorkingDir('127.0.0.4', 80, get), '', 'nobody publishes it');
  assert.equal(await publisherWorkingDir('127.0.0.2', 80, async () => null), null, 'Docker cannot be asked');
  assert.equal(await publisherWorkingDir('127.0.0.5', 80, async () => [{ Ports: [{ IP: '0.0.0.0', PublicPort: 80 }], Labels: {} }]), '', 'a container without the label');
  const { dockerPublisher } = require('./browser-guest');
  assert.deepEqual(await dockerPublisher('127.0.0.2', 80, get), { workingDir: '/mine/dev-stack', boundIp: '127.0.0.2' });
  assert.deepEqual(await dockerPublisher('127.0.0.4', 80, get), { workingDir: '', boundIp: null });
  assert.deepEqual(await dockerPublisher('127.0.0.6', 80, async () => [{ Ports: [{ IP: '0.0.0.0', PublicPort: 80 }], Labels: { 'com.docker.compose.project.working_dir': '/w/dev-stack' } }]), { workingDir: '/w/dev-stack', boundIp: '0.0.0.0' });
  assert.equal(await dockerPublisher('127.0.0.2', 80, async () => null), null);
});

test('resolveRecipe: manual origins are checked; a webapp slot only while its own stack serves it', async () => {
  const manual = await resolveRecipe({ kind: 'manual', origins: ['127.0.0.2:80', 'http://127.0.0.2/', '10.0.0.1:80', '127.0.0.2', 'localhost:3000'] });
  assert.deepEqual(manual, { ok: true, origins: ['127.0.0.2:80', '127.0.0.1:3000'], primaryUrl: 'http://127.0.0.2/' });
  const many = await resolveRecipe({ kind: 'manual', origins: Array.from({ length: 20 }, (_, i) => `127.0.0.1:${3000 + i}`) });
  assert.equal(many.origins.length, MAX_ORIGINS);
  assert.deepEqual(await resolveRecipe({ kind: 'manual', origins: ['example.com:80'] }), { ok: false, reason: 'no-origins' });
  // The first origin is opened with the scheme it was given.
  assert.equal((await resolveRecipe({ kind: 'manual', origins: ['https://127.0.0.1:4443/'] })).primaryUrl, 'https://127.0.0.1:4443/');
  assert.equal((await resolveRecipe({ kind: 'manual', origins: ['https://127.0.0.2/'] })).primaryUrl, 'https://127.0.0.2/');
  assert.equal((await resolveRecipe({ kind: 'manual', origins: ['127.0.0.2:80', 'https://127.0.0.2:4443/'] })).primaryUrl, 'http://127.0.0.2/');
  assert.deepEqual(await resolveRecipe({ kind: 'nope' }), { ok: false, reason: 'bad-recipe' });
  assert.deepEqual(await resolveRecipe(null), { ok: false, reason: 'bad-recipe' });

  const deps = (dir, override = 'DEV_INSTANCE=2\n', over = {}) => ({
    readFileSync: () => override, skipDirCheck: true,
    dockerPublisher: async () => (dir === null ? null : { workingDir: dir, boundIp: dir ? '127.0.0.2' : null }),
    sameDir: (a, b) => a === b, listenersOn: () => [], ...over,
  });
  const g = { kind: 'webapp-dev-stack' };
  assert.deepEqual(await resolveRecipe(g, null, deps('/w/dev-stack')), { ok: false, reason: 'no-checkout' });
  for (const bad of ['relative/w', '/w/../etc', '/w//x', '/w/./x', '/w\0x', '/']) {
    assert.deepEqual(await resolveRecipe(g, bad, deps('/w/dev-stack')), { ok: false, reason: 'no-checkout' }, JSON.stringify(bad));
  }
  assert.deepEqual(await resolveRecipe(g, '/w', deps('/w/dev-stack')), { ok: true, origins: ['127.0.0.2:80', '127.0.0.2:3012', '127.0.0.2:8765'], primaryUrl: 'http://127.0.0.2/' });
  assert.deepEqual(await resolveRecipe(g, '/w', deps('/other/dev-stack')), { ok: false, reason: 'other-workstream' });
  assert.deepEqual(await resolveRecipe(g, '/w', deps('')), { ok: false, reason: 'stack-not-running' });
  assert.deepEqual(await resolveRecipe(g, '/w', deps(null)), { ok: false, reason: 'unverifiable' });
  assert.deepEqual(await resolveRecipe(g, '/w', deps('/w/dev-stack', 'DEV_INSTANCE=12\n')), { ok: false, reason: 'not-a-dev-stack' });
  assert.deepEqual(await resolveRecipe(g, '/definitely/not/here', { dockerPublisher: async () => ({ workingDir: '/x', boundIp: '127.0.0.2' }) }), { ok: false, reason: 'not-a-dev-stack' });
  // The front door published on 0.0.0.0, with another's socket bound to the slot's address taking it.
  const wildFront = { dockerPublisher: async () => ({ workingDir: '/w/dev-stack', boundIp: '0.0.0.0' }), insideDir: (c, d) => c.startsWith(`${d}/`) };
  const shadow = (who) => (_h, p, _io, opts) => (p === 80 && opts && opts.exactOnly ? who : []);
  assert.deepEqual(await resolveRecipe(g, '/w', deps('/w/dev-stack', undefined, { ...wildFront, listenersOn: shadow([{ pid: 4, cwd: '/x' }]) })), { ok: false, reason: 'other-workstream' });
  assert.equal((await resolveRecipe(g, '/w', deps('/w/dev-stack', undefined, { ...wildFront, listenersOn: shadow([]) }))).ok, true);
});

test('the canary page tries TCP and WebRTC UDP to its canaries, then reports', () => {
  const html = canaryHtml(1111, 2222);
  assert.match(html, /fetch\('http:\/\/127\.0\.0\.1:1111\//);
  assert.match(html, /stun:127\.0\.0\.1:2222/);
  assert.match(html, /127\.0\.0\.1 2222 typ host/);
  assert.match(html, /fetch\('\/done', \{ method: 'POST'/);
});

test('Canary: passes only when the page ran, no canary was reached, and the proxy refused the TCP try', async () => {
  const run = async (act) => {
    const canary = new Canary();
    const page = await canary.start();
    const proxy = { denials: new Map() };
    await act({ canary, page, proxy });
    await canary.wait(300);
    const ok = canary.passed(proxy);
    canary.close();
    return ok;
  };
  const ran = (page) => new Promise((r) => { const req = http.request({ host: '127.0.0.1', port: Number(page.url.split(':')[2].replace('/', '')), path: '/done', method: 'POST' }, (res) => { res.resume(); res.on('end', r); }); req.end('ran'); });
  assert.equal(await run(async ({ page, proxy }) => { await ran(page); proxy.denials.set(page.tcpOrigin, 1); }), true, 'clean');
  assert.equal(await run(async ({ proxy, page }) => { proxy.denials.set(page.tcpOrigin, 1); }), false, 'the page never ran');
  assert.equal(await run(async ({ page }) => { await ran(page); }), false, 'the proxy never saw the TCP try');
  assert.equal(await run(async ({ canary, page, proxy }) => {
    await ran(page); proxy.denials.set(page.tcpOrigin, 1);
    await new Promise((r) => { const s = net.connect(canary.tcpPort, '127.0.0.1', () => { s.end(); setTimeout(r, 50); }); });
  }), false, 'the TCP canary was reached');
  assert.equal(await run(async ({ canary, page, proxy }) => {
    await ran(page); proxy.denials.set(page.tcpOrigin, 1);
    await new Promise((r) => { const u = dgram.createSocket('udp4'); u.send('x', canary.udpPort, '127.0.0.1', () => { u.close(); setTimeout(r, 50); }); });
  }), false, 'the UDP canary was reached');
});

test('Canary: a start that fails half way leaves nothing bound', async () => {
  const canary = new Canary();
  const realCreate = dgram.createSocket;
  dgram.createSocket = () => { const u = realCreate('udp4'); u.bind = (port, host, cb) => { u.emit('error', new Error('bind failed')); }; return u; };
  try { await assert.rejects(canary.start(), /bind failed/); } finally { dgram.createSocket = realCreate; }
  const tcpPort = canary.tcpPort;
  canary.close();
  await new Promise((r) => setTimeout(r, 20));
  // The TCP canary it had bound is gone: its port can be bound again.
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(tcpPort, '127.0.0.1', () => s.close(resolve)); });
});

test('guestEnvironment: needs the launcher, the guest user and passwordless sudo to it', () => {
  const run = (cmd) => { if (cmd === 'getent') return 'termag-guest:x:997:986::/home/termag-guest:/usr/sbin/nologin\n'; return ''; };
  assert.deepEqual(guestEnvironment({ existsSync: () => true, run }), { ok: true, home: '/home/termag-guest', profilesRoot: '/home/termag-guest/snap/chromium/common/termag-browser-pane/profiles' });
  assert.equal(guestEnvironment({ existsSync: () => false, run }).reason, 'no launcher');
  assert.match(guestEnvironment({ existsSync: () => true, run: (cmd) => { if (cmd === 'getent') throw new Error('2'); return ''; } }).reason, /no termag-guest user/);
  assert.match(guestEnvironment({ existsSync: () => true, run: (cmd, args) => { if (cmd === 'sudo') throw new Error('a password is required'); return run(cmd, args); } }).reason, /sudo -n -u termag-guest refused/);
});

test('memAvailableBytes reads /proc/meminfo; the guard leaves room for one more tab and 2 GiB', () => {
  assert.equal(memAvailableBytes(() => 'MemTotal: 100 kB\nMemAvailable:   2048 kB\n'), 2048 * 1024);
  assert.equal(memAvailableBytes(() => { throw new Error('x'); }), null);
  assert.ok(MIN_MEM_AVAILABLE_BYTES >= 3 * 1024 ** 3);
});

test('checkoutState: branch, head and the count of changed paths; null outside a checkout', async () => {
  const run = (cmd, args, opts, cb) => {
    const a = args.slice(2).join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') cb(null, 'feature-x\n');
    else if (a === 'rev-parse HEAD') cb(null, 'abc123\n');
    else if (a === 'status --porcelain') cb(null, ' M a.js\n?? b.js\n');
  };
  assert.deepEqual(await checkoutState('/w', run), { branch: 'feature-x', head: 'abc123', dirty: 2 });
  assert.equal(await checkoutState('/w', (c, a, o, cb) => cb(new Error('not a git repository'))), null);
  assert.equal(await checkoutState(null, run), null);
});
