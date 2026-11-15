'use strict';
// agent/preview-runs.js and preview-socket.js on the real kernel: the launcher
// (built from preview-launcher/) starts a node server confined to a checkout,
// and the tunnel-open check (listenerConfined) tells it from every unconfined
// listener. Needs Linux, Go, Landlock ABI 4 and a writable cgroup of this
// process's own: a box. Skipped elsewhere (CI), with the reason.
//
// Pinning (tech spec, "Confining the app", SR9): a sandboxed static server
// doesn't serve a checkout symlink to a file outside it; an unconfined
// listener is refused for a confined target, including one inside a hand-made
// termag-preview-*.scope and one sharing the port by SO_REUSEPORT; a run's end
// kills every process and removes its directory; a restarted agent's sweep
// ends what the previous one left.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { PreviewRuns } = require('./preview-runs');
const { serve, peerCred } = require('./preview-socket');

const home = os.homedir();
const tag = crypto.randomBytes(4).toString('hex');
const base = path.join(home, '.cache', `termag-preview-kernel-test-${tag}`);
const checkout = path.join(base, 'app');
const other = path.join(base, 'other');
const stateDir = path.join(home, '.local/state', `termag-preview-test-${tag}`);
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-preview-bin-'));
const launcher = path.join(binDir, 'termag-preview');
let cgroupParent = null;
let skip = null;

// A static server like sirv: it follows symlinks after a lexical check. `reuse` listens with SO_REUSEPORT.
const SERVER = `
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const want = Number(process.argv[2] || 0); const reuse = process.argv[3] === 'reuse';
const s = http.createServer((req, res) => {
  const p = path.join(process.cwd(), decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, b) => { if (err) { res.statusCode = 500; res.end(err.code); } else res.end(b); });
});
s.listen({ port: want, host: '127.0.0.1', reusePort: reuse }, () => console.log('PORT=' + s.address().port));
`;

function ownCgroup() {
  const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
  return line ? path.join('/sys/fs/cgroup', line.slice(3)) : null;
}

before(() => {
  if (process.platform !== 'linux') { skip = 'not Linux'; return; }
  try { execFileSync('go', ['build', '-o', launcher, '.'], { cwd: path.join(__dirname, '../preview-launcher'), stdio: 'pipe' }); } catch (e) { skip = `no launcher build (${e.message.split('\n')[0]})`; return; }
  const abi = Number(execFileSync(launcher, ['abi']).toString().trim());
  if (abi < 4) { skip = `Landlock ABI ${abi}, need 4`; return; }
  const own = ownCgroup();
  try { cgroupParent = path.join(own, `termag-preview-test-${tag}`); fs.mkdirSync(cgroupParent); } catch (e) { skip = `no writable cgroup (${e.code})`; return; }
  fs.mkdirSync(path.join(checkout, 'public'), { recursive: true });
  fs.writeFileSync(path.join(base, 'secret'), 'aws_secret_access_key=planted');
  fs.writeFileSync(path.join(checkout, 'server.js'), SERVER);
  fs.writeFileSync(path.join(checkout, 'public/index.html'), '<h1>hello</h1>');
  fs.symlinkSync(path.join(base, 'secret'), path.join(checkout, 'public/leak'));
  execFileSync('git', ['init', '-q', checkout]);
  execFileSync('git', ['-C', checkout, 'add', '-A']);
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
});

after(async () => {
  // Each run's cgroup goes a moment after its end; then the test's own.
  for (let i = 0; cgroupParent && fs.existsSync(cgroupParent) && i < 50; i++) {
    for (const d of fs.readdirSync(cgroupParent, { withFileTypes: true })) if (d.isDirectory()) { try { fs.rmdirSync(path.join(cgroupParent, d.name)); } catch { /* busy */ } }
    try { fs.rmdirSync(cgroupParent); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

// `features`: the loopback rule the vouching needs is the next row's launcher (5b); these tests are about the vouching.
function newRuns() {
  return new PreviewRuns({ launcher, home, stateDir, cgroupParent, usable: () => ({ ok: true }), features: ['tcp-allowlist'] });
}

async function portOf(logPath, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const m = /PORT=(\d+)/.exec(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
    if (m) return Number(m[1]);
    if (Date.now() > deadline) throw new Error(`no PORT in ${logPath}:\n${fs.readFileSync(logPath, 'utf8')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

/** An unconfined copy of the server, as the owner's shell would start it; the port it listens on. */
async function unconfined(args = [], wrap = []) {
  const argv = [...wrap, process.execPath, path.join(checkout, 'server.js'), ...args];
  const child = spawn(argv[0], argv.slice(1), { cwd: path.join(checkout, 'public'), stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /PORT=(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  return { child, port };
}

test('a confined static server: serves the checkout\'s copy, not a symlink out of it; only its listener is confined', async (t) => {
  if (skip) { t.skip(skip); return; }
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['node', 'server.js'] });
  try {
    const port = await portOf(run.logPath);
    assert.equal(run.checkout, fs.realpathSync(checkout));
    assert.equal((await get(port, '/public/index.html')).body, '<h1>hello</h1>');
    // The symlink is copied as a symlink; Landlock refuses its target, so the server can't read it.
    assert.deepEqual(await get(port, '/public/leak'), { status: 500, body: 'EACCES' });
    assert.ok(!(await get(port, '/public/leak')).body.includes('planted'));

    assert.deepEqual(runs.listenerConfined(port, checkout), { ok: true });
    const wrong = runs.listenerConfined(port, other);
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /runs another checkout/);
    assert.deepEqual([...runs.confinedPorts([port, 1], checkout)], [port]);

    // An unconfined listener of the same checkout is refused.
    const plain = await unconfined();
    t.after(() => plain.child.kill('SIGKILL'));
    const r = runs.listenerConfined(plain.port, checkout);
    assert.equal(r.ok, false);
    assert.match(r.reason, /wasn't started by termag preview run/);
    // So is one inside a hand-made scope named like a run's: names prove nothing.
    try {
      execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--unit', `termag-preview-fake-${tag}`, 'true'], { stdio: 'pipe' });
      const scoped = await unconfined([], ['systemd-run', '--user', '--scope', '--quiet', '--unit', `termag-preview-${tag}`]);
      t.after(() => scoped.child.kill('SIGKILL'));
      assert.match(runs.listenerConfined(scoped.port, checkout).reason, /wasn't started by termag preview run/);
    } catch (e) {
      if (e.code !== 'ENOENT' && !/Failed to connect|not been booted/.test(String(e.stderr || e.message))) throw e;
      t.diagnostic(`no user systemd here, the scope case not tried: ${e.message}`);
    }
  } finally {
    runs.stop(run.id);
  }
});

test('SO_REUSEPORT: an unconfined listener sharing a confined one\'s port makes the port unconfined', async (t) => {
  if (skip) { t.skip(skip); return; }
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['node', 'server.js', '0', 'reuse'] });
  try {
    const port = await portOf(run.logPath);
    assert.deepEqual(runs.listenerConfined(port, checkout), { ok: true });
    const twin = await unconfined([String(port), 'reuse']);
    t.after(() => twin.child.kill('SIGKILL'));
    assert.equal(twin.port, port);
    assert.match(runs.listenerConfined(port, checkout).reason, /wasn't started by termag preview run/);
  } finally {
    runs.stop(run.id);
  }
});

test('without the launcher\'s loopback rule, no listener is vouched for a wider audience (Cursor Security Agent, #1520)', async (t) => {
  if (skip) { t.skip(skip); return; }
  // An older launcher's features: no tcp-allowlist (this tree's has it; see the next test).
  const runs = new PreviewRuns({ launcher, home, stateDir, cgroupParent, usable: () => ({ ok: true }), features: [] });
  const run = await runs.start({ checkout, command: ['node', 'server.js'] });
  try {
    const port = await portOf(run.logPath);
    assert.match(runs.listenerConfined(port, checkout).reason, /runs under a launcher that didn't refuse loopback connects when it started/);
    assert.deepEqual([...runs.confinedPorts([port], checkout)], []);
  } finally {
    runs.stop(run.id);
  }
});

// Pinning (#1520): a run is judged by the launcher it started under, recorded then. A box update that swaps in
// a launcher with the loopback rule while the agent runs vouches for the runs started after it, never for one started
// before, which can still reach the owner's loopback ports.
test('a run started under a launcher without the loopback rule stays unvouched after the launcher is swapped (#1520)', async (t) => {
  if (skip) { t.skip(skip); return; }
  // A launcher that is this tree's, but answers `features` as told: first nothing, as today's does.
  const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-preview-wrap-'));
  const wrap = path.join(wrapDir, 'termag-preview');
  const install = (features) => {
    const next = `${wrap}.new`;
    fs.writeFileSync(next, `#!/bin/sh\n[ "$1" = features ] && { printf '%s\\n' '${features}'; exit 0; }\nexec ${launcher} "$@"\n`, { mode: 0o755 });
    fs.renameSync(next, wrap); // a new binary, as a box update installs one: a new inode
  };
  install('');
  const runs = new PreviewRuns({ launcher: wrap, home, stateDir, cgroupParent, usable: () => ({ ok: true }) });
  const old = await runs.start({ checkout, command: ['node', 'server.js'] });
  let fresh = null;
  try {
    const oldPort = await portOf(old.logPath);
    assert.match(runs.listenerConfined(oldPort, checkout).reason, /didn't refuse loopback connects when it started/);
    // The box update: a launcher with the loopback rule, while this agent keeps running.
    install('tcp-allowlist');
    assert.equal(runs.loopbackRule(), true, 'the new binary says it has the rule');
    assert.match(runs.listenerConfined(oldPort, checkout).reason, /didn't refuse loopback connects when it started/, 'the old run is still refused');
    assert.deepEqual([...runs.confinedPorts([oldPort], checkout)], []);
    // A run started after it is vouched for.
    fresh = await runs.start({ checkout, command: ['node', 'server.js'] });
    const freshPort = await portOf(fresh.logPath);
    assert.deepEqual(runs.listenerConfined(freshPort, checkout), { ok: true });
    assert.deepEqual([...runs.confinedPorts([oldPort, freshPort], checkout)], [freshPort]);
  } finally {
    runs.stop(old.id);
    if (fresh) runs.stop(fresh.id);
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(wrapDir, { recursive: true, force: true });
  }
});

test('this launcher reports the loopback rule, so the agent asks it and vouches without being told', async (t) => {
  if (skip) { t.skip(skip); return; }
  const runs = new PreviewRuns({ launcher, home, stateDir, cgroupParent, usable: () => ({ ok: true }) });
  assert.equal(runs.loopbackRule(), true);
});

// Pinning (#1520), on the real kernel: the socket that accepted a dial is a confined run's, or the dial is
// refused; an ordinary server of the same user's isn't one.
test('acceptedConfined: a dial accepted by the confined run passes; one accepted by an unconfined server is refused (#1520)', async (t) => {
  if (skip) { t.skip(skip); return; }
  const net = require('node:net');
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['node', 'server.js'] });
  const plain = net.createServer(() => {});
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const dial = async (port) => { const c = net.connect(port, '127.0.0.1'); await new Promise((r) => c.on('connect', r)); return c; };
  try {
    const port = await portOf(run.logPath);
    const a = await dial(port);
    const tuple = (c, p) => ({ host: c.remoteAddress, port: p, peerHost: c.localAddress, peerPort: c.localPort });
    assert.deepEqual(await runs.acceptedConfined(tuple(a, port), checkout), { ok: true });
    a.destroy();
    const b = await dial(plain.address().port);
    assert.match((await runs.acceptedConfined(tuple(b, plain.address().port), checkout)).reason, /isn't a vouched termag preview run of this checkout/);
    b.destroy();
  } finally {
    plain.close();
    runs.stop(run.id);
  }
});

// Pinning (#1667), on the real kernel: a confined run whose event loop is blocked for 3 s (stopped, as
// a cold compile would hold it) accepts late, and the dial is still vouched for, not refused.
test('acceptedConfined: a confined run that accepts 3 s late is waited for, not refused', async (t) => {
  if (skip) { t.skip(skip); return; }
  const net = require('node:net');
  const { holdersOf } = require('./preview-runs');
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['node', 'server.js'] });
  let pid = null;
  try {
    const port = await portOf(run.logPath);
    // The listener's pid, from its LISTEN socket.
    const inodes = new Set();
    for (const table of ['tcp', 'tcp6']) {
      for (const line of fs.readFileSync(`/proc/net/${table}`, 'utf8').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 10 && f[3] === '0A' && parseInt(f[1].split(':')[1], 16) === port) inodes.add(f[9]);
      }
    }
    [pid] = [...holdersOf(inodes).values()].flat();
    assert.ok(pid, 'found the listener');
    process.kill(pid, 'SIGSTOP');
    const c = net.connect(port, '127.0.0.1');
    await new Promise((r) => c.on('connect', r));
    const started = Date.now();
    const resume = setTimeout(() => { process.kill(pid, 'SIGCONT'); pid = null; }, 3000);
    try {
      const r = await runs.acceptedConfined({ host: c.remoteAddress, port, peerHost: c.localAddress, peerPort: c.localPort }, checkout);
      assert.deepEqual(r, { ok: true });
      assert.ok(Date.now() - started >= 2900, `vouched only after the accept: ${Date.now() - started} ms`);
    } finally {
      clearTimeout(resume);
      c.destroy();
    }
  } finally {
    if (pid) process.kill(pid, 'SIGCONT');
    runs.stop(run.id);
  }
});

test('a run\'s end kills all of it and removes its directory; status says it ended', async (t) => {
  if (skip) { t.skip(skip); return; }
  const runs = newRuns();
  // The app double-forks a sleeper away from the root: cgroup.kill still ends it.
  const run = await runs.start({ checkout, command: ['/bin/sh', '-c', 'setsid sleep 300 & echo PORT=1; exec sleep 300'] });
  await portOf(run.logPath);
  const runDir = path.join(stateDir, run.id);
  const cg = path.join(cgroupParent, run.id);
  const pids = fs.readFileSync(path.join(cg, 'cgroup.procs'), 'utf8').trim().split('\n').map(Number);
  assert.ok(pids.length >= 2, `the run's processes: ${pids}`);
  assert.equal(runs.status(run.id).state, 'running');
  assert.equal(runs.stop(run.id), true);
  const deadline = Date.now() + 5000;
  while ((fs.existsSync(runDir) || fs.existsSync(cg)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(runDir), 'run directory removed');
  assert.ok(!fs.existsSync(cg), 'cgroup removed');
  for (const pid of pids) assert.ok(!fs.existsSync(`/proc/${pid}`) || /^[^ ]+ \([^)]*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')), `pid ${pid} still runs`);
  assert.equal(runs.status(run.id).state, 'ended');
  assert.equal(runs.status(run.id).exit, 'stopped');
});

test('a run whose sync helper stops ends too, rather than serve a copy that no longer follows the checkout (Devin, #1520)', async (t) => {
  if (skip) { t.skip(skip); return; }
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['/bin/sh', '-c', 'echo PORT=1; exec sleep 300'] });
  await portOf(run.logPath);
  process.kill(runs.roots.get(run.id).sync.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (runs.status(run.id)?.state !== 'ended' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs.status(run.id).state, 'ended');
  assert.equal(runs.status(run.id).exit, 'sync stopped (SIGKILL)');
});

test('a restarted agent\'s sweep ends the runs the previous one left, and cleans their directories', async (t) => {
  if (skip) { t.skip(skip); return; }
  const old = newRuns();
  const run = await old.start({ checkout, command: ['/bin/sh', '-c', 'echo PORT=1; exec sleep 300'] });
  await portOf(run.logPath);
  const pid = run.pid;
  // The sync helper is in the run's cgroup too, so the sweep ends its watch (Bugbot, #1520).
  const syncPid = old.roots.get(run.id).sync.pid;
  assert.ok(fs.readFileSync(path.join(cgroupParent, run.id, 'cgroup.procs'), 'utf8').split('\n').includes(String(syncPid)), 'the sync helper is in the run cgroup');
  // The old agent is gone without stopping it; a new one starts.
  const fresh = newRuns();
  assert.equal(fresh.sweep(), 1);
  const deadline = Date.now() + 5000;
  while (fs.existsSync(path.join(stateDir, run.id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(stateDir, run.id)));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.existsSync(`/proc/${pid}`) || /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')), 'the old run\'s app was killed');
  assert.ok(!fs.existsSync(`/proc/${syncPid}`) || /\) Z /.test(fs.readFileSync(`/proc/${syncPid}/stat`, 'utf8')), 'the old run\'s sync helper was killed');
  old.roots.clear();
});

test('the local socket: 0600 in a 0700 directory, the caller\'s pid and uid from SO_PEERCRED, a confined caller refused', async (t) => {
  if (skip) { t.skip(skip); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-sock-'));
  const at = path.join(dir, 'termag', 'agent.sock');
  const runs = newRuns();
  let seen = null;
  const server = serve({ runs, launcher, at, peer: async (l, s) => { seen = await peerCred(l, s); return seen; } });
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((r) => server.on('listening', r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.statSync(path.dirname(at)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(at).mode & 0o777, 0o600);
  const ask = (body) => new Promise((resolve, reject) => {
    const c = net.connect(at);
    let out = '';
    c.on('connect', () => c.write(`${JSON.stringify(body)}\n`));
    c.on('data', (b) => { out += b; });
    c.on('end', () => resolve(JSON.parse(out)));
    c.on('error', reject);
  });
  assert.deepEqual(await ask({ op: 'preview-list' }), { runs: [] });
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.uid, process.getuid());
  assert.match((await ask({ op: 'nope' })).error, /unknown op/);
  // A caller descending from a confined root (a stand-in: this process registered as one).
  runs.roots.set('fake', { id: 'fake', pid: process.pid, startTime: fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19], checkout, launcher: { features: ['tcp-allowlist'] } });
  assert.match((await ask({ op: 'preview-list' })).error, /runs under termag preview run/);
  runs.roots.delete('fake');
});

test('loopback is denied except the --allow ports (SR9), and the refusals are named for the owner', async (t) => {
  if (skip) { t.skip(skip); return; }
  const listen = () => new Promise((resolve) => { const s = net.createServer((c) => { c.on('error', () => {}); c.end('hi'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const declared = await listen();
  const undeclared = await listen();
  t.after(() => { declared.close(); undeclared.close(); });
  const dp = declared.address().port;
  const up = undeclared.address().port;
  fs.writeFileSync(path.join(checkout, 'probe.js'), `
const net = require('node:net');
const one = (p) => new Promise((r) => { const c = net.connect(p, '127.0.0.1'); c.on('connect', () => { console.log('PROBE', p, 'ok'); c.destroy(); r(); }); c.on('error', (e) => { console.log('PROBE', p, e.code); console.error(String(e)); r(); }); });
(async () => { for (const p of process.argv.slice(2)) await one(Number(p)); console.log('PORT=1'); setTimeout(() => {}, 300000); })();
`);
  const runs = newRuns();
  const run = await runs.start({ checkout, command: ['node', 'probe.js', String(dp), String(up), '80'], allow: [dp] });
  try {
    assert.deepEqual(run.allowed, [443, dp].sort((a, b) => a - b));
    await portOf(run.logPath);
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, new RegExp(`PROBE ${dp} ok`));
    assert.match(log, new RegExp(`PROBE ${up} EACCES`));
    assert.match(log, /PROBE 80 EACCES/);
  } finally {
    runs.stop(run.id);
  }
  // Named once the run has ended, as the CLI shows them.
  const named = runs.status(run.id).diagnosis.map((d) => [d.code, d.port]);
  assert.deepEqual(named.sort(), [['loopback_refused', up], ['port80_refused', 80]].sort());
});

test('--allow refuses a debugger on any address: one bound only to the box\'s own address, or found by the DevTools probe (Bugbot, #1521)', async (t) => {
  if (skip) { t.skip(skip); return; }
  const { debuggerOnPort } = require('./preview-runs');
  const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!ip) { t.skip('no non-loopback IPv4 address'); return; }
  const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const started = (child, re) => new Promise((resolve, reject) => {
    let out = '';
    const on = (b) => { out += b; if (re.test(out)) resolve(); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (c) => reject(new Error(`exited ${c}: ${out}`)));
  });
  // A Node inspector on the box's address only: port-guard's forward rules stop before they look at it.
  const ip1 = await free();
  const insp = spawn(process.execPath, [`--inspect=${ip}:${ip1}`, '-e', 'setInterval(() => {}, 1e6)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => insp.kill('SIGKILL'));
  await started(insp, /Debugger listening/);
  assert.match((await debuggerOnPort(ip1)).reason, /^debugger or shell: the Node inspector \(--inspect\) holds port/);
  // Something the command line doesn't give away, answering the DevTools protocol there.
  const ip2 = await free();
  const fake = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end(JSON.stringify({ Browser: 'x', 'Protocol-Version': '1.3' }))).listen(${ip2}, '${ip}', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => fake.kill('SIGKILL'));
  await started(fake, /up/);
  assert.match((await debuggerOnPort(ip2)).reason, new RegExp(`answers the DevTools protocol \\(/json/version\\) on ${ip.replace(/\./g, '\\.')}`));
  // An inspector opened from code (no --inspect to see) on IPv6 loopback: only the probe finds it.
  const ip4 = await free();
  const v6 = spawn(process.execPath, ['-e', `require('inspector').open(${ip4}, '::1'); console.log('up'); setInterval(() => {}, 1e6)`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => v6.kill('SIGKILL'));
  await started(v6, /up/);
  assert.match((await debuggerOnPort(ip4)).reason, /answers the DevTools protocol \(\/json\/version\) on 0:0:0:0:0:0:0:1/);
  // An ordinary server there is fine.
  const ip3 = await free();
  const plain = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('hi')).listen(${ip3}, '${ip}', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => plain.kill('SIGKILL'));
  await started(plain, /up/);
  assert.deepEqual(await debuggerOnPort(ip3), { ok: true });
});
