'use strict';
// The `preview-listeners` RPC: every reachable listening port, its holder and the preview guard's verdict.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { COMMAND_MAX, MAX_PORTS, previewListeners } = require('./preview-listeners');
const { canCheckPorts } = require('./port-guard');

const ME = typeof process.getuid === 'function' ? process.getuid() : 1001;
const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const hexPort = (port) => port.toString(16).toUpperCase().padStart(4, '0');
let sl = 0;
const row = (addrHex, port, uid, inode, st = '0A') => `  ${sl++}: ${addrHex}:${hexPort(port)} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-listeners-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('lists each reachable port once, lowest first, with its holder, the verdict, and whether it runs from the checkout', async () => {
  const procRoot = fs.mkdtempSync(path.join(tmp, 'proc-'));
  const checkout = path.join(tmp, 'termag', 'projects', 'app');
  fs.mkdirSync(path.join(checkout, 'web'), { recursive: true });
  fs.mkdirSync(path.join(procRoot, 'net'));
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), header
    + row('0100007F', 9229, ME, '11')
    + row('0100007F', 5173, ME, '12')
    + row('00000000', 5173, ME, '13')
    + row('3500007F', 53, 991, '14') // 127.0.0.53: systemd-resolved, never reachable from the relay
    + row('0100007F', 6006, ME, '15', '01') // ESTABLISHED, not a listener
    + row('00000000', 22, 0, '16'));
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp6'), header + row('00000000000000000000000001000000', 8080, ME, '17'));
  const proc = (pid, argv, cwd, inodes) => {
    fs.mkdirSync(path.join(procRoot, String(pid), 'fd'), { recursive: true });
    fs.writeFileSync(path.join(procRoot, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    fs.symlinkSync(cwd, path.join(procRoot, String(pid), 'cwd'));
    inodes.forEach((ino, i) => fs.symlinkSync(`socket:[${ino}]`, path.join(procRoot, String(pid), 'fd', String(3 + i))));
  };
  proc(100, ['node', '--inspect=9229', 'server.js'], tmp, ['11']);
  proc(101, ['node', `${checkout}/node_modules/.bin/vite`, '--host', '--port', '5173', ...Array(20).fill('--long-option')], path.join(checkout, 'web'), ['12', '13']);
  proc(102, ['python3', '-m', 'http.server', '8080'], '/', ['17']);
  const verdicts = {
    22: { ok: false, code: 'port_refused', reason: 'a root listener on 0.0.0.0:22 is not a Docker publish' },
    5173: { ok: true, dialHost: '127.0.0.1' },
    8080: { ok: true, dialHost: '::1' },
    9229: { ok: false, code: 'port_refused', reason: 'debugger or shell: the Node inspector (--inspect) holds port 9229' },
  };
  const asked = [];
  const probed = [];
  const { listeners } = await previewListeners({ cwd: checkout }, {
    procRoot,
    checkPreviewListener: async (p, seen) => { asked.push([p, seen]); return verdicts[p]; },
    checkPreviewPort: async (p) => { probed.push(p); return verdicts[p]; },
  });
  assert.deepEqual(asked.map(([p]) => p), [22, 5173, 8080, 9229]);
  // Each check gets the one read of the tables and walk of /proc, not its own.
  const [, first] = asked[0];
  assert.ok(asked.every(([, s]) => s.owners === first.owners && s.allRows === first.allRows));
  assert.equal(first.owners.get('12').pid, 101);
  assert.ok(first.allRows.some((r) => r.port === 22));
  // The list never probes: no /json/version to the user's listeners.
  assert.deepEqual(probed, []);
  assert.deepEqual(listeners.map((l) => [l.port, l.pid, l.verdict.ok, l.inCheckout]), [[22, null, false, false], [5173, 101, true, true], [8080, 102, true, false], [9229, 100, false, false]]);
  assert.equal(listeners[1].command.length, COMMAND_MAX);
  assert.equal(listeners[1].command, `node ${checkout}/node_modules/.bin/vite --host --port 5173 ${Array(20).fill('--long-option').join(' ')}`.slice(0, COMMAND_MAX));
  assert.equal(listeners[2].command, 'python3 -m http.server 8080');
  assert.equal(listeners[0].command, null);
  assert.deepEqual(listeners[3].verdict, { ok: false, code: 'port_refused', reason: verdicts[9229].reason });
  // Without a checkout, nothing is in it.
  const bare = await previewListeners({}, { procRoot, checkPreviewListener: async (p) => verdicts[p], checkPreviewPort: async () => assert.fail('probed') });
  assert.ok(bare.listeners.every((l) => !l.inCheckout));
  // A publish's port gets the full check, probe included; the others still don't.
  // A publish's port: that one alone, with the full check (probe included), and nothing else looked at.
  const forPublish = [];
  const listed = [];
  const published = await previewListeners({ port: 5173 }, { procRoot, checkPreviewListener: async (p) => { listed.push(p); return verdicts[p]; }, checkPreviewPort: async (p) => { forPublish.push(p); return verdicts[p]; } });
  assert.deepEqual(forPublish, [5173]);
  assert.deepEqual(listed, []);
  assert.deepEqual(published.listeners.map((l) => [l.port, l.pid, l.verdict.ok]), [[5173, 101, true]]);
  // A port nobody listens on yet has no entry, so it may be published (U5).
  const closed = await previewListeners({ port: 4999 }, { procRoot, checkPreviewPort: async () => ({ ok: false, code: 'port_closed', reason: 'nothing listens on port 4999' }) });
  assert.deepEqual(closed.listeners, []);
});

test("finds this process's own server on the box's real tables", { skip: !canCheckPorts() && 'needs /proc/net/tcp (Linux)' }, async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { listeners } = await previewListeners({ cwd: process.cwd() });
    const mine = listeners.find((l) => l.port === port);
    assert.ok(mine, 'listed');
    assert.equal(mine.pid, process.pid);
    assert.equal(mine.inCheckout, true);
    assert.deepEqual(mine.verdict, { ok: true });
  } finally {
    server.close();
  }
});

test("a publish's port is checked even past the list's cap, so a refused listener there can't publish", async () => {
  const procRoot = fs.mkdtempSync(path.join(tmp, 'proc-many-'));
  fs.mkdirSync(path.join(procRoot, 'net'));
  let tcp = header;
  for (let p = 2000; p < 2000 + MAX_PORTS + 50; p++) tcp += row('0100007F', p, ME, String(50000 + p));
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), tcp);
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp6'), header);
  const last = 2000 + MAX_PORTS + 49;
  const refused = { ok: false, code: 'port_refused', reason: 'debugger or shell: the Node inspector (--inspect) holds port ' + last };
  const list = await previewListeners({}, { procRoot, checkPreviewListener: async () => ({ ok: true }) });
  assert.equal(list.listeners.length, MAX_PORTS);
  assert.ok(!list.listeners.some((l) => l.port === last), 'past the cap, the list leaves it out');
  const forPublish = await previewListeners({ port: last }, { procRoot, checkPreviewPort: async (p) => (p === last ? refused : assert.fail('only the named port')) });
  assert.deepEqual(forPublish.listeners.map((l) => [l.port, l.verdict]), [[last, { ok: false, code: refused.code, reason: refused.reason }]]);
});
