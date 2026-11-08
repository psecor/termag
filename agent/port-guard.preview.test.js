'use strict';
// Preview links' guard (port-guard.js checkPreviewPort): the forward's rules
// plus SR6, which refuses a debugger, shell or notebook by its command line
// or by answering the DevTools protocol. The pinning test is the real Node
// inspector, started with --inspect and with inspector.open(), refused both
// ways on this box's own /proc.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PORT_CHECK_TTL_MS, canCheckPorts, checkPreviewListener, checkPreviewPort, probeDevtools, shellCommand } = require('./port-guard');

const ME = typeof process.getuid === 'function' ? process.getuid() : 1001;
const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const hexPort = (port) => port.toString(16).toUpperCase().padStart(4, '0');
let sl = 0;
const row = (addrHex, port, uid, inode) => `  ${sl++}: ${addrHex}:${hexPort(port)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const LO = '0100007F';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'port-guard-preview-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * A /proc root: net/tcp with one loopback listener per process given, each
 * process's cmdline, and an fd symlink to its socket. checkPreviewPort's deps
 * for it, with the probe answering `probe`.
 */
function fakeBox(procs, { probe = false } = {}) {
  const procRoot = fs.mkdtempSync(path.join(tmp, 'proc-'));
  fs.mkdirSync(path.join(procRoot, 'net'));
  let tcp = '';
  for (const [i, p] of procs.entries()) {
    const pid = 4000 + i;
    const inode = String(9000 + i);
    tcp += row(LO, p.port, p.uid ?? ME, inode);
    fs.mkdirSync(path.join(procRoot, String(pid), 'fd'), { recursive: true });
    fs.writeFileSync(path.join(procRoot, String(pid), 'cmdline'), `${p.argv.join('\0')}\0`);
    fs.symlinkSync(`socket:[${inode}]`, path.join(procRoot, String(pid), 'fd', '3'));
  }
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp'), header + tcp);
  fs.writeFileSync(path.join(procRoot, 'net', 'tcp6'), header);
  let probes = 0;
  return {
    deps: { procRoot, uid: ME, home: tmp, cache: new Map(), previewCache: new Map(), probe: async () => { probes++; return probe; } },
    probes: () => probes,
  };
}

test('shellCommand knows the debuggers, shells and notebooks SR6 lists, and not a dev server', () => {
  const refused = [
    [['node', '--inspect', 'server.js'], 'the Node inspector (--inspect)'],
    [['node', '--inspect=0.0.0.0:9229', 'server.js'], 'the Node inspector (--inspect)'],
    [['/usr/bin/node', '--inspect-brk=9230', 'x.js'], 'the Node inspector (--inspect)'],
    [['node', '--inspect-wait', 'x.js'], 'the Node inspector (--inspect)'],
    [['node', '--inspect-brk', 'x.js'], 'the Node inspector (--inspect)'],
    [['/opt/google/chrome/chrome', '--headless', '--remote-debugging-port=9222'], 'a browser debugging port (--remote-debugging-port)'],
    [['/usr/bin/python3', '/home/a/.local/bin/jupyter-lab', '--no-browser'], 'Jupyter'],
    [['/usr/bin/python3', '/home/a/.local/bin/jupyter', 'notebook'], 'Jupyter'],
    [['python', '-m', 'jupyterlab'], 'Jupyter'],
    [['python', '-m', 'ipykernel_launcher', '-f', 'k.json'], 'Jupyter'],
    [['/usr/lib/code-server/lib/node', '/usr/lib/code-server', '--bind-addr', '127.0.0.1:8080'], 'code-server'],
    [['code-server', '--auth', 'none'], 'code-server'],
    [['ttyd', '-p', '7681', 'bash'], 'ttyd'],
    [['python', '-m', 'debugpy', '--listen', '5678', 'app.py'], 'debugpy'],
    [['/usr/bin/python3', '/home/a/.venv/lib/python3.12/site-packages/debugpy/adapter'], 'debugpy'],
    [['rdbg', '--open', '--port', '12345', 'app.rb'], 'rdbg'],
    [['/usr/bin/python3', '/usr/local/bin/jupyterhub', '-f', 'jupyterhub_config.py'], 'JupyterHub'],
    [['/opt/conda/bin/python', '/opt/conda/bin/jupyterhub-singleuser', '--ip=0.0.0.0'], 'JupyterHub'],
    [['python', '-m', 'jupyterhub'], 'JupyterHub'],
    [['python3', '-m', 'jupyterhub.singleuser', '--port', '8888'], 'JupyterHub'],
    [['python', '-m', 'notebook', "--NotebookApp.token=''"], 'Jupyter'],
    [['python3', '-mnotebook'], 'Jupyter'],
    [['python3', '/usr/lib/python3/dist-packages/notebook/__main__.py'], 'Jupyter'],
    [['/home/a/.openvscode-server/bin/openvscode-server', '--without-connection-token', '--port', '3000'], 'openvscode-server'],
    [['/home/workspace/.openvscode-server/node', '/home/workspace/openvscode-server/out/server-main.js', '--without-connection-token'], 'openvscode-server'],
    // As the launcher leaves it: the bundled node under the install, never the launcher's own name.
    [['/home/a/.openvscode-server/node', '/home/a/.openvscode-server/out/server-main.js', '--host', '127.0.0.1'], 'openvscode-server'],
    [['/opt/openvscode-server-v1.86.0-linux-x64/node', '/opt/openvscode-server-v1.86.0-linux-x64/out/server-main.js', '--without-connection-token'], 'openvscode-server'],
    [['/home/a/.local/lib/code-server-4.20.0/lib/node', '/home/a/.local/lib/code-server-4.20.0', '--bind-addr', '127.0.0.1:8080'], 'code-server'],
    [['/usr/lib/code-server-4.20.0-linux-amd64/lib/node', '/usr/lib/code-server-4.20.0-linux-amd64/out/node/entry.js'], 'code-server'],
  ];
  for (const [argv, what] of refused) assert.equal(shellCommand(argv), what, argv.join(' '));
  const allowed = [
    ['node', '/home/a/app/node_modules/.bin/vite', '--port', '5173'],
    ['next-server (v15.0.0)'],
    ['node', 'storybook', 'dev', '-p', '6006'],
    ['python', 'manage.py', 'runserver'],
    ['ruby', 'bin/rails', 'server'],
    ['node', 'inspector-ui.js'],
    ['node', 'server.js', '--inspector-port-free'],
    ['python', 'notebook_utils.py'],
    ['python', '-m', 'notebooks_site'],
    ['node', 'docs/notebook/index.js'],
    ['node', 'vscode-server-mock.js'],
    ['node', 'tools/code-server-mock.js'],
    // A dev server in a project whose name looks like an editor install (Devin, on a0eadbf6).
    ['node', '/home/a/termag/projects/code-server-2/node_modules/vite/bin/vite.js', '--port', '5173'],
    ['node', '/home/a/termag/projects/code-server/node_modules/.bin/vite'],
    ['node', '/home/a/termag/projects/openvscode-server-v2/server.js'],
    ['node', '/home/a/my-openvscode-server-notes/index.js'],
    // How node --test starts each test file: the inspector configured, not open.
    ['node', '--inspect-publish-uid=stderr,http', '--inspect-port=127.0.0.1:9229', 'x.test.js'],
  ];
  for (const argv of allowed) assert.equal(shellCommand(argv), null, argv.join(' '));
  assert.equal(shellCommand(null), null);
});

test('a listener started as a debugger, shell or notebook is refused for a preview: port_refused, "debugger or shell"', async () => {
  for (const argv of [['node', '--inspect=9229', 'server.js'], ['jupyter-lab'], ['ttyd', 'bash']]) {
    const { deps } = fakeBox([{ port: 9229, argv }]);
    const v = await checkPreviewPort(9229, deps);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'port_refused');
    assert.match(v.reason, /^debugger or shell: /);
  }
});

test('a listener answering the DevTools protocol is refused, whatever its command line', async () => {
  const { deps, probes } = fakeBox([{ port: 3000, argv: ['node', 'server.js'] }], { probe: true });
  assert.deepEqual(await checkPreviewPort(3000, deps), { ok: false, code: 'port_refused', reason: 'debugger or shell: port 3000 answers the DevTools protocol (/json/version)' });
  assert.equal(probes(), 1);
});

test("a dev server passes, as the forward's verdict", async () => {
  const { deps } = fakeBox([{ port: 5173, argv: ['node', 'node_modules/.bin/vite'] }]);
  assert.deepEqual(await checkPreviewPort(5173, deps), { ok: true, dialHost: '127.0.0.1' });
});

test("the forward's refusals come first: another user's port is refused before any probe", async () => {
  const { deps, probes } = fakeBox([{ port: 8080, uid: ME + 1, argv: ['node', 'x.js'] }], { probe: true });
  const v = await checkPreviewPort(8080, deps);
  assert.equal(v.code, 'port_refused');
  assert.match(v.reason, /belongs to uid/);
  assert.equal(probes(), 0);
  assert.equal((await checkPreviewPort(8081, deps)).code, 'port_closed');
});

test('the preview verdict is cached per port as the guard\'s is; port_closed never', async () => {
  let now = 1_000_000;
  const box = fakeBox([{ port: 5173, argv: ['node', 'vite'] }]);
  const deps = { ...box.deps, now: () => now };
  await checkPreviewPort(5173, deps);
  await checkPreviewPort(5173, deps);
  assert.equal(box.probes(), 1);
  now += PORT_CHECK_TTL_MS;
  deps.cache.clear();
  await checkPreviewPort(5173, deps);
  assert.equal(box.probes(), 2);
  await checkPreviewPort(5999, deps);
  assert.equal(deps.previewCache.has(5999), false);
  assert.equal((await checkPreviewPort(0, deps)).code, 'port_refused');
});

/** An HTTP server on loopback answering every request with `body`; its port. */
async function serve(body, onReq = () => {}) {
  const server = http.createServer((req, res) => { onReq(req); res.writeHead(200, { 'content-type': 'application/json' }).end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('probeDevtools: a DevTools /json/version answer is one; any other answer, a non-HTTP server or nothing is not', async () => {
  const seen = [];
  const chrome = await serve(JSON.stringify({ Browser: 'HeadlessChrome/120', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://localhost/devtools/browser/x' }), (req) => seen.push(req));
  // Node 24's inspector answers only these two.
  const nodeInspector = await serve(JSON.stringify({ Browser: 'node.js/v24.22.1', 'Protocol-Version': '1.1' }));
  const app = await serve(JSON.stringify({ hello: 'world' }));
  const html = await serve('<!doctype html>');
  const raw = net.createServer((c) => c.end('+PONG\r\n'));
  await new Promise((r) => raw.listen(0, '127.0.0.1', r));
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await probeDevtools('127.0.0.1', chrome.port), true);
    assert.equal(seen[0].url, '/json/version');
    // Sent as the relay sends Host, the one an inspector's rebinding check lets through.
    assert.equal(seen[0].headers.host, `localhost:${chrome.port}`);
    assert.equal(await probeDevtools('127.0.0.1', nodeInspector.port), true);
    assert.equal(await probeDevtools('127.0.0.1', app.port), false);
    assert.equal(await probeDevtools('127.0.0.1', html.port), false);
    assert.equal(await probeDevtools('127.0.0.1', raw.address().port), false);
    assert.equal(await probeDevtools('127.0.0.1', silent.address().port, { timeoutMs: 100 }), false);
    const free = net.createServer();
    await new Promise((r) => free.listen(0, '127.0.0.1', r));
    const closedPort = free.address().port;
    await new Promise((r) => free.close(r));
    assert.equal(await probeDevtools('127.0.0.1', closedPort), false);
  } finally {
    for (const s of [chrome.server, nodeInspector.server, app.server, html.server, raw, silent]) { s.closeAllConnections?.(); s.close(); }
  }
});

/** A node child with the inspector on an ephemeral port: its port, from the "Debugger listening on" line. */
async function inspectorChild(args) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no inspector line: ${err}`)), 10_000);
    child.stderr.on('data', (c) => {
      err += c;
      const m = /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${err}`)); });
  });
  return { child, port };
}

const noKernelTables = !canCheckPorts() && 'needs /proc/net/tcp (Linux)';

// SR6's pinning test, on this box's own kernel tables: a published Node inspector is refused.
test('a real Node inspector is refused for a preview, by --inspect and by the probe alone', { skip: noKernelTables }, async () => {
  const flagged = await inspectorChild(['--inspect=127.0.0.1:0', '-e', 'setInterval(() => {}, 1000)']);
  const opened = await inspectorChild(['-e', "require('inspector').open(0, '127.0.0.1'); setInterval(() => {}, 1000)"]);
  try {
    const byFlag = await checkPreviewPort(flagged.port, { cache: new Map(), previewCache: new Map() });
    assert.equal(byFlag.ok, false);
    assert.equal(byFlag.code, 'port_refused');
    assert.match(byFlag.reason, /^debugger or shell: the Node inspector/);
    const byProbe = await checkPreviewPort(opened.port, { cache: new Map(), previewCache: new Map() });
    assert.deepEqual(byProbe, { ok: false, code: 'port_refused', reason: `debugger or shell: port ${opened.port} answers the DevTools protocol (/json/version)` });
  } finally {
    flagged.child.kill();
    opened.child.kill();
  }
});

test('a real dev server of this user passes', { skip: noKernelTables }, async () => {
  const app = await serve('{}');
  try {
    assert.deepEqual(await checkPreviewPort(app.port, { cache: new Map(), previewCache: new Map() }), { ok: true, dialHost: '127.0.0.1' });
  } finally {
    app.server.close();
  }
});

test("the dialog's list goes by command line alone: no probe, and its verdicts never stand in for a probed one", async () => {
  const { deps, probes } = fakeBox([{ port: 3000, argv: ['node', 'server.js'] }, { port: 9229, argv: ['node', '--inspect', 'x.js'] }], { probe: true });
  const listCache = new Map();
  assert.deepEqual(await checkPreviewListener(3000, { ...deps, previewCache: listCache }), { ok: true, dialHost: '127.0.0.1' });
  assert.equal(probes(), 0);
  // The command-line mark still refuses, without a probe.
  assert.match((await checkPreviewListener(9229, { ...deps, previewCache: listCache })).reason, /^debugger or shell: the Node inspector/);
  assert.equal(probes(), 0);
  // At publish and tunnel open the probe runs, whatever the list said.
  assert.equal((await checkPreviewPort(3000, deps)).code, 'port_refused');
  assert.equal(probes(), 1);
});

test("a list's check reuses the tables and socket owners it is given: no read of net/tcp, no walk of /proc", async () => {
  const { deps } = fakeBox([{ port: 3000, argv: ['node', 'server.js'] }, { port: 9229, argv: ['node', '--inspect', 'x.js'] }]);
  const { allListenRows, socketOwners } = require('./local-listeners');
  const allRows = allListenRows(fs.readFileSync, deps.procRoot);
  const owners = socketOwners(allRows.map((r) => r.inode), { readdirSync: fs.readdirSync, readlinkSync: fs.readlinkSync }, deps.procRoot);
  const looked = [];
  const seen = {
    ...deps,
    allRows,
    owners,
    readFileSync: (p, enc) => { if (/\/net\/tcp6?$/.test(p)) looked.push(p); return fs.readFileSync(p, enc); },
    readdirSync: (p) => { looked.push(p); return fs.readdirSync(p); },
  };
  assert.deepEqual(await checkPreviewListener(3000, seen), { ok: true, dialHost: '127.0.0.1' });
  assert.match((await checkPreviewListener(9229, seen)).reason, /^debugger or shell: the Node inspector/);
  assert.deepEqual(looked, []);
});

test('a real Node inspector opened by inspector.open() shows in the list as allowed, and is refused at publish and tunnel open', { skip: noKernelTables }, async () => {
  const opened = await inspectorChild(['-e', "require('inspector').open(0, '127.0.0.1'); setInterval(() => {}, 1000)"]);
  try {
    assert.equal((await checkPreviewListener(opened.port, { cache: new Map(), previewCache: new Map() })).ok, true);
    assert.equal((await checkPreviewPort(opened.port, { cache: new Map(), previewCache: new Map() })).code, 'port_refused');
  } finally {
    opened.child.kill();
  }
});

/** A fake Docker Engine on a unix socket, answering /containers/json with `containers`. */
async function fakeDocker(containers) {
  const socketPath = path.join(fs.mkdtempSync(path.join(tmp, 'docker-')), 'docker.sock');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://docker');
    const wanted = Number((JSON.parse(url.searchParams.get('filters') || '{}').publish || [])[0]);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(containers.filter((c) => c.Ports.some((p) => p.PublicPort === wanted))));
  });
  await new Promise((r) => server.listen(socketPath, r));
  return { socketPath, close: () => server.close() };
}

test('a Docker-published notebook, shell or debugger is refused by its container command or image, though root holds the socket', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const stack = path.join(home, 'stack');
  fs.mkdirSync(stack);
  const ports = (port) => [{ IP: '127.0.0.1', PrivatePort: 8888, PublicPort: port, Type: 'tcp' }];
  const labels = { 'com.docker.compose.project.working_dir': stack };
  const docker = await fakeDocker([
    { Command: 'tini -g -- start-notebook.py', Image: 'quay.io/jupyter/base-notebook:latest', Ports: ports(8888), Labels: labels },
    { Command: 'ttyd -p 7681 bash', Image: 'example/tools', Ports: ports(7681), Labels: labels },
    { Command: 'python -m debugpy --listen 0.0.0.0:5678 app.py', Image: 'python:3.12', Ports: ports(5678), Labels: labels },
    { Command: '/usr/bin/entrypoint.sh --bind-addr 0.0.0.0:8080 .', Image: 'codercom/code-server:4', Ports: ports(8443), Labels: labels },
    { Command: 'npm run dev', Image: 'node:22', Ports: ports(3000), Labels: labels },
  ]);
  try {
    // Root's docker-proxy holds each port: nothing of the user's to read in /proc.
    const procs = [8888, 7681, 5678, 8443, 3000].map((port) => ({ port, uid: 0, argv: ['/usr/bin/docker-proxy'] }));
    const { deps } = fakeBox(procs);
    const d = { ...deps, home, dockerSocket: docker.socketPath };
    for (const [port, what] of [[8888, 'quay.io/jupyter/base-notebook:latest'], [7681, 'ttyd'], [5678, 'debugpy'], [8443, 'codercom/code-server:4']]) {
      const v = await checkPreviewPort(port, d);
      assert.equal(v.code, 'port_refused', String(port));
      assert.match(v.reason, new RegExp(`^debugger or shell: .*${what.replace(/[.:/]/g, '.')}.* publishes port ${port}$`), v.reason);
    }
    assert.deepEqual(await checkPreviewPort(3000, d), { ok: true, dialHost: '127.0.0.1' });
    // The dialog's list refuses them too, without the probe.
    assert.equal((await checkPreviewListener(7681, { ...d, previewCache: new Map() })).code, 'port_refused');
  } finally {
    docker.close();
  }
});
