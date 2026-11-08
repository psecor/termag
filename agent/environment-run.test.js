'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { chain, startChain, statePath, sessionName, locate, describeState } = require('./environment-run');
const { envKey } = require('./environment-file');

const sink = () => ({ text: '', write(c) { this.text += c; return true; } });

function checkout(files, url = 'https://github.com/acme/web.git') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envrun-'));
  const home = path.join(root, 'home');
  const dir = path.join(root, 'web');
  fs.mkdirSync(home);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { root, home, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const read = (home, dir) => JSON.parse(fs.readFileSync(statePath(home, envKey(dir)), 'utf8'));

test('setup runs in the checkout, is timed, and is not run again once it has succeeded', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'echo ran >> setup-count; echo set up' } });
  try {
    const out = sink();
    let s = await chain(c.dir, { projectId: 'p1' }, { home: c.home, out, env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.state, 'ready');
    assert.equal(s.setup.state, 'succeeded');
    assert.ok(Number.isFinite(s.setup.durationMs));
    assert.match(out.text, /set up/);
    assert.match(out.text, /setup took \d+s/);
    assert.equal(read(c.home, c.dir).projectId, 'p1');

    s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(fs.readFileSync(path.join(c.dir, 'setup-count'), 'utf8'), 'ran\n', 'once');
    assert.equal(s.projectId, 'p1', 'a later run keeps the project the agent started it for');

    await chain(c.dir, { again: true, only: 'setup' }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(fs.readFileSync(path.join(c.dir, 'setup-count'), 'utf8'), 'ran\nran\n', '--again reruns it');
  } finally { c.cleanup(); }
});

test('a map setup runs each repository\'s entry in its own checkout, in order, and stops at the first failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envrun-ws-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.termag-workspace'), 'marker\n');
  for (const [name, url] of [['frontend', 'https://github.com/acme/web'], ['api', 'https://github.com/acme/api']]) {
    execFileSync('git', ['init', '-q', path.join(ws, name)]);
    execFileSync('git', ['-C', path.join(ws, name), 'remote', 'add', 'origin', url]);
  }
  fs.mkdirSync(path.join(ws, 'frontend', '.termag', 'full'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'frontend', '.termag', 'full', 'environment.json'), JSON.stringify({
    setup: { 'acme/api': 'pwd > ../order; exit 0', 'acme/web': 'pwd >> ../order; exit 3', 'acme/other': 'true' },
  }));
  try {
    const s = await chain(ws, { fileRepo: 'acme/web', filePath: '.termag/full/environment.json' }, { home, out: sink(), env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(s.state, 'failed');
    assert.equal(s.setup.state, 'failed');
    assert.equal(s.setup.exitCode, 3);
    assert.deepEqual(fs.readFileSync(path.join(ws, 'order'), 'utf8').trim().split('\n').map(p => path.basename(p)), ['api', 'frontend']);
    assert.ok(s.warnings.some(w => /acme\/other/.test(w)));
    assert.equal(s.file, '.termag/full/environment.json');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('run starts every entry at once, waits for every port\'s health, then seeds; unresolved secrets are warnings', async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.url === '/health' ? 200 : 404; res.end('ok'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const c = checkout({ '.termag/environment.json': {
    run: 'make dev', seed: 'echo seeded > seeded',
    ports: [{ name: 'app', port, health: '/health', path: '/app/' }],
    secrets: ['APP_API_KEY', 'APP_SDK_KEY'],
  } });
  try {
    const started = [];
    let probes = 0;
    const s = await chain(c.dir, {}, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home, APP_API_KEY: 'box-token' }, pollMs: 5,
      startWindow: async (i, entry) => { started.push([i, entry.command]); return { ok: true }; },
      probe: async (p) => { probes += 1; return probes > 2 && p.port === port; },
      // The stand-in app is this test's own server, outside the checkout: ownership is another test's.
      portOwnership: async () => 'owned',
    });
    assert.equal(s.state, 'up');
    assert.deepEqual(started, [[0, 'make dev']]);
    assert.equal(s.run.state, 'succeeded');
    assert.deepEqual(s.ports.map(p => [p.name, p.healthy]), [['app', true]]);
    assert.equal(fs.readFileSync(path.join(c.dir, 'seeded'), 'utf8'), 'seeded\n');
    assert.deepEqual(s.secrets.resolved.map(r => r.name), ['APP_API_KEY']);
    assert.deepEqual(s.secrets.missing, ['APP_SDK_KEY']);
    assert.ok(s.warnings.some(w => /APP_SDK_KEY/.test(w)));
    // The window reads its command and the resolved values from a 0600 file, never from argv or the state.
    const exec = path.join(c.home, '.termag', 'env', `${envKey(c.dir)}.exec.json`);
    assert.equal(fs.statSync(exec).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(statePath(c.home, envKey(c.dir)), 'utf8').includes('box-token'));
  } finally { server.close(); c.cleanup(); }
});

test('a run whose ports never turn healthy fails at the timeout and says which', async () => {
  const c = checkout({ '.termag/environment.json': { run: 'sleep 100', ports: [{ name: 'web', port: 1 }] } });
  try {
    const s = await chain(c.dir, { timeoutS: 0.05 }, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH }, pollMs: 5,
      startWindow: async () => ({ ok: true }), probe: async () => false,
    });
    assert.equal(s.state, 'failed');
    assert.match(s.run.error, /web \(:1\) not healthy/);
  } finally { c.cleanup(); }
});

test('a checkout with no environment file is "none", not a failure', async () => {
  const c = checkout({});
  try {
    const s = await chain(c.dir, { projectId: 'p1' }, { home: c.home, out: sink() });
    assert.equal(s.state, 'none');
  } finally { c.cleanup(); }
});

test('startChain makes the session with the chain as window "up", and does not start a second while one runs', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    const calls = [];
    let has = false;
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') return { ok: has };
      if (args[0] === 'list-windows') return { ok: true, stdout: 'up 0\n' };
      return { ok: true, stdout: '' };
    };
    const first = await startChain(c.dir, { projectId: 'p1', instanceId: 'b1' }, { home: c.home, tmux });
    assert.equal(first.started, true);
    const made = calls.find(a => a[0] === 'new-session');
    assert.deepEqual(made.slice(0, 8), ['new-session', '-d', '-s', sessionName(envKey(c.dir)), '-n', 'up', '-c', c.dir]);
    assert.ok(made.includes('--project') && made.includes('p1'));
    assert.equal(read(c.home, c.dir).state, 'pending');

    has = true;
    const second = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.deepEqual([second.started, second.running], [false, true]);
  } finally { c.cleanup(); }
});

test('locate names the file in the file repository\'s checkout, and refuses a multi-repo root without one', () => {
  const c = checkout({});
  try {
    assert.equal(locate(c.dir).file, path.join(c.dir, '.termag', 'environment.json'));
    assert.equal(locate(c.dir, { filePath: '.termag/x/environment.json' }).relPath, '.termag/x/environment.json');
    fs.writeFileSync(path.join(c.root, '.termag-workspace'), '');
    execFileSync('git', ['init', '-q', path.join(c.root, 'api')]);
    execFileSync('git', ['-C', path.join(c.root, 'api'), 'remote', 'add', 'origin', 'https://github.com/acme/api']);
    assert.match(locate(c.root).error, /several checkouts/);
  } finally { c.cleanup(); }
});

test('describeState reads each phase with its time and each port with its health', () => {
  const lines = describeState({
    state: 'up', file: '.termag/environment.json', session: 'termag-env-web-1',
    setup: { state: 'succeeded', durationMs: 151000 }, run: { state: 'succeeded', durationMs: 42000 }, seed: { state: 'none' },
    ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }, { name: 'backend', port: 3040, path: '/', healthy: false }],
    warnings: ['APP_SDK_KEY is not something termag delivers, so the steps run without it'],
  });
  assert.deepEqual(lines, [
    'environment: up (.termag/environment.json), tmux session termag-env-web-1',
    '  setup: succeeded, 2m 31s',
    '  run: succeeded, 42s',
    '  healthy   frontend http://localhost:5174/termag/',
    '  unhealthy backend http://localhost:3040/',
    '  warning: APP_SDK_KEY is not something termag delivers, so the steps run without it',
  ]);
});

test('environment-up starts the chain for a project checkout, skips one with no file, and refuses a bad request', async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  const bare = checkout({});
  try {
    const tmux = async (args) => ({ ok: args[0] !== 'has-session', stdout: '' });
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: true }, { home: c.home, tmux }), { started: true, session: sessionName(envKey(c.dir)) });
    assert.equal(read(c.home, c.dir).projectId, 'p1');
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: bare.dir, trusted: true }, { home: bare.home, tmux }), { skipped: 'no-file' });
    assert.match((await handleEnvironmentUp({ projectId: '../x', instanceId: 'b1', dir: c.dir })).error, /projectId/);
    assert.match((await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: 'rel' })).error, /absolute/);
    assert.match((await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, filePath: '../../etc/x' })).error, /relative/);
  } finally { c.cleanup(); bare.cleanup(); }
});

test('the forwarder sends a project\'s state when it changes, and never a window\'s commands', () => {
  const { createEnvForwarder } = require('./environment-run');
  const files = {
    'web-1.json': JSON.stringify({ projectId: 'p1', state: 'setup', setup: { state: 'running' } }),
    'web-1.exec.json': JSON.stringify({ projectId: 'p1', run: [{ command: 'make dev' }], env: { APP_API_KEY: 'k' } }),
    'web-1.run-0.json': JSON.stringify({ projectId: 'p1', exitCode: 0 }),
    'ask-2.json': JSON.stringify({ projectId: null, state: 'up' }),
  };
  const sent = [];
  const f = createEnvForwarder({ readNames: () => Object.keys(files), readFile: n => files[n], send: x => sent.push(x), isOpen: () => true });
  assert.equal(f.tick(), true);
  assert.deepEqual(sent.map(x => [x.type, x.projectId, x.status.state]), [['environment-status', 'p1', 'setup']]);
  assert.equal(f.tick(), false, 'unchanged');
  files['web-1.json'] = JSON.stringify({ projectId: 'p1', state: 'up', setup: { state: 'succeeded', durationMs: 5 } });
  f.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].status.setup.durationMs, 5);
});

test("environment-up runs the file text the orchestrator sent, keeps it for later runs, and never reads the checkout's", async () => {
  const { handleEnvironmentUp, loadPlan, whereFrom } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'echo from-disk' } });
  try {
    const tmux = async (args) => ({ ok: args[0] !== 'has-session', stdout: '' });
    const fileText = JSON.stringify({ repos: [{ repo: 'acme/web' }], setup: 'echo from-orchestrator > marker' });
    assert.equal((await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, fileText, filePath: 'termag:main:.termag/x.json', trusted: true }, { home: c.home, tmux })).started, true);
    const st = read(c.home, c.dir);
    assert.equal(st.fileText, fileText);
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(c.dir, 'marker'), 'utf8'), 'from-orchestrator\n');
    // termag-env --file names a file on disk instead.
    assert.equal(loadPlan(c.dir, whereFrom({ filePath: '.termag/environment.json', fromCli: true }, st)).plan.setup[0].command, 'echo from-disk');
    assert.match((await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, fileText: 'x'.repeat(17 * 1024), trusted: true }, { home: c.home, tmux })).error, /at most/);
  } finally { c.cleanup(); }
});

// Bugbot on #998: a later run must replace the earlier run's windows, not stack a second app beside them.
test('a later run closes the run windows an earlier one left before it starts new ones', async () => {
  const c = checkout({ '.termag/environment.json': { run: { 'acme/web': 'make dev' }, ports: [{ name: 'web', port: 1 }] } });
  try {
    const calls = [];
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'list-windows') return { ok: true, stdout: '@1 up\n@2 run:web\n@3 run\n@4 notes\n' };
      return { ok: true, stdout: '' };
    };
    const started = [];
    let healthy = false;
    const deps = {
      home: c.home, out: sink(), env: { PATH: process.env.PATH }, pollMs: 5, tmux,
      startWindow: async (i) => { started.push(i); healthy = true; return { ok: true }; },
      probe: async () => healthy,
    };
    await chain(c.dir, {}, deps);
    const killed = calls.filter(a => a[0] === 'kill-window').map(a => a[2]);
    assert.deepEqual(killed, ['@2', '@3'], 'the run windows, never up or a window of the owner\'s');
    assert.ok(calls.findIndex(a => a[0] === 'kill-window') < calls.length, 'closed before the new windows');
    assert.deepEqual(started, [0]);
  } finally { c.cleanup(); }
});

// Bugbot on #998: seed is remembered as setup is, so a second up on a running app doesn't seed it again.
test('seed runs once for a run: an up on an app already up does not seed it again; --again or termag-env seed does', async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', seed: 'echo seeded >> seed-count', ports: [{ name: 'web', port: 1 }] } });
  try {
    const deps = { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }), startWindow: async () => ({ ok: true }), probe: async () => true, portOwnership: async () => 'owned' };
    await chain(c.dir, { again: true }, deps);
    assert.equal(fs.readFileSync(path.join(c.dir, 'seed-count'), 'utf8'), 'seeded\n');
    const s = await chain(c.dir, {}, deps);
    assert.equal(s.state, 'up');
    assert.equal(s.seed.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(c.dir, 'seed-count'), 'utf8'), 'seeded\n', 'not seeded again');
    await chain(c.dir, { only: 'seed' }, deps);
    assert.equal(fs.readFileSync(path.join(c.dir, 'seed-count'), 'utf8'), 'seeded\nseeded\n', 'termag-env seed reseeds');
  } finally { c.cleanup(); }
});

test("the file's ports are in the state from the start, so a turn told setup is running names them", async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'sleep 0.3', ports: [{ name: 'frontend', port: 5174, path: '/termag/' }] } });
  try {
    const running = chain(c.dir, { only: 'setup' }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    await new Promise(r => setTimeout(r, 150));
    const mid = read(c.home, c.dir);
    assert.equal(mid.state, 'setup');
    assert.deepEqual(mid.ports.map(p => [p.name, p.port, p.healthy]), [['frontend', 5174, false]]);
    await running;
  } finally { c.cleanup(); }
});

test('down runs stop before it closes the session; a failing stop is logged, the rest still run, and the session is closed', async () => {
  const { stopEnvironment } = require('./environment-run');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envrun-stop-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.termag-workspace'), '');
  for (const [name, url] of [['web', 'https://github.com/acme/web'], ['api', 'https://github.com/acme/api']]) {
    execFileSync('git', ['init', '-q', path.join(ws, name)]);
    execFileSync('git', ['-C', path.join(ws, name), 'remote', 'add', 'origin', url]);
  }
  fs.mkdirSync(path.join(ws, 'web', '.termag'));
  fs.writeFileSync(path.join(ws, 'web', '.termag', 'environment.json'), JSON.stringify({
    repos: [{ repo: 'acme/web' }, { repo: 'acme/api' }],
    stop: { 'acme/api': 'echo api >> ../stopped; exit 4', 'acme/web': 'echo web >> ../stopped' },
  }));
  try {
    const calls = [];
    const out = sink();
    const r = await stopEnvironment(ws, { fileRepo: 'acme/web' }, { home, out, env: { PATH: process.env.PATH, HOME: home }, tmux: async (args) => { calls.push(args); return { ok: true, stdout: '' }; } });
    assert.deepEqual(fs.readFileSync(path.join(ws, 'stopped'), 'utf8').trim().split('\n'), ['api', 'web'], 'in the order written, the second after the first failed');
    assert.equal(r.stop.state, 'failed');
    assert.match(r.stop.error, /exited 4/);
    assert.match(out.text, /stop: echo api .* exited 4/);
    assert.deepEqual(calls.map(a => a[0]), ['kill-session'], 'and the session is closed anyway, after stop');
    const st = JSON.parse(fs.readFileSync(statePath(home, envKey(ws)), 'utf8'));
    assert.equal(st.state, 'stopped');
    assert.equal(st.stop.state, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('down with no stop just closes the session', async () => {
  const { stopEnvironment } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { run: 'make dev' } });
  try {
    const calls = [];
    const r = await stopEnvironment(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH }, tmux: async (args) => { calls.push(args); return { ok: true, stdout: '' }; } });
    assert.equal(r.stop.state, 'none');
    assert.deepEqual(calls.map(a => a[0]), ['kill-session']);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (6f51c94c): a new up is a new app; the last down's stop is not its state.
test('a new up clears the stop phase the last down left', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'stopped', stop: { state: 'succeeded', durationMs: 1000 } }));
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.deepEqual(s.stop, { state: 'none' });
  } finally { c.cleanup(); }
});

// Bugbot on #998 (6f51c94c): down says when stop failed, with a non-zero exit, and what of the file was left out.
test('termag-env down exits 1 when stop failed and prints the file\'s warnings', async () => {
  const c = checkout({ '.termag/environment.json': { stop: 'exit 3', seed: 7 } });
  try {
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'environment-run.js'), 'down', c.dir], {
      env: { PATH: process.env.PATH, HOME: c.home, TMUX_TMPDIR: c.root }, encoding: 'utf8',
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /stop failed/);
    assert.match(r.stdout + r.stderr, /warning: "seed" is 7/);
    assert.doesNotMatch(r.stdout, /nothing was running/);
  } finally { c.cleanup(); }
});

// Security Agent on #998: the automatic start at claim runs only what the owner trusted.
test('environment-up refuses a request the orchestrator did not mark trusted', async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    const tmux = async () => ({ ok: true, stdout: '' });
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir }, { home: c.home, tmux }), { skipped: 'untrusted' });
    assert.equal(fs.existsSync(statePath(c.home, envKey(c.dir))), false, 'nothing started, nothing written');
    assert.equal((await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: true }, { home: c.home, tmux })).started, true);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (1b6aec08): a held environment's file is kept on the box, nothing starts, and termag-env up runs it.
test('environment-up with hold keeps the file for termag-env up and starts nothing', async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({});
  try {
    const calls = [];
    const tmux = async (args) => { calls.push(args); return { ok: true, stdout: '' }; };
    const fileText = JSON.stringify({ repos: [{ repo: 'acme/web' }], setup: 'echo ran > ran' });
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: true, hold: 'not-authored', fileText, filePath: "full-stack's file" }, { home: c.home, tmux }),
      { held: 'not-authored' });
    assert.deepEqual(calls, [], 'no tmux session, no chain');
    const st = read(c.home, c.dir);
    assert.equal(st.state, 'held');
    assert.equal(st.held, 'not-authored');
    assert.equal(st.fileText, fileText);
    assert.equal(st.projectId, 'p1');
    // The owner's own termag-env up runs the definition it kept.
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(c.dir, 'ran'), 'utf8'), 'ran\n');
    assert.equal(s.held, undefined, 'running it ends the hold');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (3590e3f7): an unpinned pointer is held whether or not its file is in the checkout, so the
// owner is told either way.
test('environment-up holds an unpinned pointer, with its file in the checkout or not', async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const tmux = async () => { throw new Error('nothing starts'); };
  const present = checkout({ '.termag/web.json': { setup: 'echo ran > ran' } });
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: present.dir, trusted: true, hold: 'unpinned', filePath: '.termag/web.json' }, { home: present.home, tmux }), { held: 'unpinned' });
    assert.equal(read(present.home, present.dir).state, 'held');
    assert.ok(!fs.existsSync(path.join(present.dir, 'ran')));
  } finally { present.cleanup(); }
  const absent = checkout({});
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: absent.dir, trusted: true, hold: 'unpinned', filePath: '.termag/web.json' }, { home: absent.home, tmux }), { held: 'unpinned' });
    const st = read(absent.home, absent.dir);
    assert.equal(st.state, 'held');
    assert.equal(st.held, 'unpinned');
    assert.match(st.warnings.join('\n'), /no \.termag\/web\.json in/);
  } finally { absent.cleanup(); }
});

// Security Agent on #998 (061f9184): a repository's own file is held, never run at claim; a checkout without one shows nothing.
test("environment-up holds a repository's own file, and skips a checkout with none", async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const tmux = async () => { throw new Error('nothing starts'); };
  const present = checkout({ '.termag/environment.json': { setup: 'echo ran > ran' } });
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: present.dir, trusted: true, hold: 'checkout' }, { home: present.home, tmux }), { held: 'checkout' });
    assert.equal(read(present.home, present.dir).state, 'held');
    assert.ok(!fs.existsSync(path.join(present.dir, 'ran')));
  } finally { present.cleanup(); }
  const absent = checkout({});
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: absent.dir, trusted: true, hold: 'checkout' }, { home: absent.home, tmux }), { skipped: 'no-file' });
  } finally { absent.cleanup(); }
});

// Bugbot on #998 (c93708ad): someone else's pointer that couldn't be pinned is held as not-authored; its missing file is still told.
test("environment-up holds someone else's unpinned pointer whose file isn't in the checkout", async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({});
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: true, hold: 'not-authored', fileRepo: null, filePath: '.termag/web.json' }, { home: c.home, tmux: async () => { throw new Error('nothing starts'); } }), { held: 'not-authored' });
    const st = read(c.home, c.dir);
    assert.equal(st.state, 'held');
    assert.match(st.warnings.join('\n'), /no \.termag\/web\.json in/);
  } finally { c.cleanup(); }
});

test('termag-env show prints the definition a held environment will run', () => {
  const c = checkout({});
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'held', held: 'not-authored', fileText: '{"setup":"curl x | sh"}', filePath: "full-stack's file" }));
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'environment-run.js'), 'show', c.dir], { env: { PATH: process.env.PATH, HOME: c.home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /curl x \| sh/);
    assert.match(r.stdout, /held: someone else wrote this version/);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (ee3fb6f7): a held environment is settled; termag-env up starts it, not "already running".
test('startChain starts a held environment even with a live up window left from before', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'held', held: 'not-authored' }));
    const calls = [];
    const tmux = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'has-session') return { ok: true };
      if (args[0] === 'list-windows') return { ok: true, stdout: 'up 0\n' };
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.started, true);
    assert.ok(calls.includes('new-window'));
  } finally { c.cleanup(); }
});

// Bugbot on #998 (ee3fb6f7): the held state names the definition it keeps, as the card shows it.
test("a held environment's state names its file", async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({});
  try {
    await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: true, hold: 'not-authored', fileText: '{"run":"make"}', filePath: "full-stack's file" }, { home: c.home, tmux: async () => ({ ok: true, stdout: '' }) });
    assert.equal(read(c.home, c.dir).file, "full-stack's file");
  } finally { c.cleanup(); }
});

// Bugbot on #998 (8ebe1075): a file with ports and seed but no run still waits for its ports and seeds.
test('up with no run still waits for the ports and seeds', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true', seed: 'echo seeded > seeded', ports: [{ name: 'web', port: 1 }] } });
  try {
    let probes = 0;
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, probe: async () => (++probes > 2) });
    assert.ok(probes > 2, 'it waited for the port');
    assert.equal(s.ports[0].healthy, true);
    assert.equal(fs.readFileSync(path.join(c.dir, 'seeded'), 'utf8'), 'seeded\n');
    assert.equal(s.seed.state, 'succeeded');
    assert.equal(s.state, 'up');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (4af52769): a no-run health timeout is a step's failure, not setup's.
test('up with no run whose ports never come up fails the health wait, not setup', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true', seed: 'echo seeded > seeded', ports: [{ name: 'web', port: 1 }] } });
  try {
    const s = await chain(c.dir, { timeoutS: 0.05 }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, probe: async () => false });
    assert.equal(s.state, 'failed');
    assert.equal(s.setup.state, 'succeeded');
    assert.equal(s.run.state, 'failed');
    assert.match(s.run.error, /web \(:1\) not healthy after/);
    assert.equal(s.seed.state, 'none');
    assert.ok(!fs.existsSync(path.join(c.dir, 'seeded')));
  } finally { c.cleanup(); }
});

// Bugbot on #998 (979a59ae): the next up that gets the ports up clears the last one's timeout.
test('up with no run clears an earlier health timeout, so a later seed failure is the seed', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true', seed: 'exit 3', ports: [{ name: 'web', port: 1 }] } });
  try {
    const deps = { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5 };
    const first = await chain(c.dir, { timeoutS: 0.05 }, { ...deps, probe: async () => false });
    assert.equal(first.run.state, 'failed');
    const s = await chain(c.dir, {}, { ...deps, probe: async () => true });
    assert.equal(s.state, 'failed');
    assert.equal(s.run.state, 'none');
    assert.equal(s.seed.state, 'failed');
  } finally { c.cleanup(); }
});

test('up with seed and no run and no ports seeds after setup', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true', seed: 'echo seeded > seeded' } });
  try {
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(fs.readFileSync(path.join(c.dir, 'seeded'), 'utf8'), 'seeded\n');
    assert.equal(s.state, 'ready');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (17a47647): healthy ports are this app only when its checkouts serve them, as Share preview checks.
test("up with a run doesn't take another app on its ports for this one, nor seed it", async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', seed: 'echo seeded > seeded', ports: [{ name: 'web', port: 1 }] } });
  try {
    let started = 0;
    const deps = { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => { started++; return { ok: true }; }, probe: async () => true };
    const s = await chain(c.dir, {}, { ...deps, portOwnership: async () => 'pid 9 runs outside the checkout' });
    assert.equal(s.state, 'failed');
    assert.equal(s.run.state, 'failed');
    assert.match(s.run.error, /web \(:1\) is served by something else: pid 9 runs outside the checkout/);
    assert.equal(started, 0, 'no second app on a held port');
    assert.ok(!fs.existsSync(path.join(c.dir, 'seeded')), 'never seeds another app');
    const own = await chain(c.dir, {}, { ...deps, portOwnership: async () => 'owned' });
    assert.equal(own.state, 'up');
    assert.equal(started, 0, 'its own app, already up, is not started again');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (17a47647): a tmux start that fails doesn't leave the environment pending forever.
test('startChain marks the environment failed when tmux cannot start it', async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    const tmux = async (args) => ({ ok: args[0] !== 'new-session' && args[0] !== 'new-window' && args[0] !== 'has-session', stdout: '' });
    const r = await startChain(c.dir, { projectId: 'p1', instanceId: 'b1' }, { home: c.home, tmux });
    assert.match(r.error, /could not start tmux session/);
    const st = read(c.home, c.dir);
    assert.equal(st.state, 'failed');
    assert.match(st.warnings.join('\n'), /could not start tmux session/);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (17a47647): a workstream's chat is told about the environment its project's checkout runs.
test("environmentNotice reads the project's state from a workstream's worktree", () => {
  const { environmentNotice } = require('./environment-run');
  const c = checkout({});
  try {
    const ws = path.join(c.dir, '.worktrees', 'fix');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.dirname(statePath(c.home, envKey(c.dir))), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), dir: c.dir, state: 'setup', setup: { state: 'running', startedAt: new Date().toISOString() }, ports: [] }));
    assert.match(environmentNotice(ws, {}, { home: c.home }).text || '', /still setting up/);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (378b4e38): `docker run -p` (or Docker's proxy) listens as root, so whose it is can't be told.
// That's not another app: up leaves it running, as before, and says it couldn't check.
test("up leaves an app whose listener it can't attribute running, rather than failing it", async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', ports: [{ name: 'web', port: 1 }] } });
  try {
    let started = 0;
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => { started++; return { ok: true }; }, probe: async () => true, portOwnership: async () => "its listener is not this user's" });
    assert.equal(s.state, 'up');
    assert.equal(started, 0);
    assert.match(s.warnings.join('\n'), /couldn't tell whose listener answers web \(:1\)/);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (28c3a2ee): up checks ownership against the file's repos, as Share preview does, never a sibling
// checkout; and an app found already up has a run that reads succeeded, not running.
test("up owns ports by the file's repos only, and an already-up run reads succeeded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envrun-own-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.termag-workspace'), '');
  for (const [name, url] of [['web', 'https://github.com/acme/web'], ['api', 'https://github.com/acme/api'], ['tools', 'https://github.com/acme/tools']]) {
    execFileSync('git', ['init', '-q', path.join(ws, name)]);
    execFileSync('git', ['-C', path.join(ws, name), 'remote', 'add', 'origin', url]);
  }
  fs.mkdirSync(path.join(ws, 'web', '.termag'));
  fs.writeFileSync(path.join(ws, 'web', '.termag', 'environment.json'), JSON.stringify({
    repos: [{ repo: 'acme/web' }, { repo: 'acme/api' }], run: { 'acme/web': 'make dev' }, ports: [{ name: 'web', port: 1 }],
  }));
  try {
    const seen = [];
    const s = await chain(ws, { fileRepo: 'acme/web' }, {
      home, out: sink(), env: { PATH: process.env.PATH, HOME: home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => ({ ok: true }), probe: async () => true,
      portOwnership: async (p, checkouts) => { seen.push(checkouts); return 'owned'; },
    });
    assert.deepEqual(seen[0].slice().sort(), [path.join(ws, 'api'), path.join(ws, 'web')], 'not the sibling acme/tools, nor the root');
    assert.equal(s.state, 'up');
    assert.equal(s.run.state, 'succeeded', 'its run is done, not in progress');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Bugbot on #998 (bea08d69): a held definition is kept even for a request that isn't trusted to run; nothing runs.
test('environment-up keeps a held definition without trust, and still refuses an untrusted start', async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({});
  try {
    const tmux = async () => { throw new Error('nothing starts'); };
    const fileText = JSON.stringify({ repos: [{ repo: 'acme/web' }], setup: 'echo ran > ran' });
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: false, hold: 'automation', fileText, filePath: "full-stack's file" }, { home: c.home, tmux }), { held: 'automation' });
    assert.equal(read(c.home, c.dir).fileText, fileText);
    assert.ok(!fs.existsSync(path.join(c.dir, 'ran')));
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: false, fileText }, { home: c.home, tmux }), { skipped: 'untrusted' });
  } finally { c.cleanup(); }
});

// Bugbot on #998 (bea08d69): health is probed on 127.0.0.1, else ::1, so ownership is asked of ::1 when
// nothing holds the port on 127.0.0.1: an IPv6-only stranger is not taken for this app, nor seeded.
test('up asks who serves ::1 when nothing listens on 127.0.0.1', async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', seed: 'echo seeded > seeded', ports: [{ name: 'web', port: 1 }] } });
  try {
    const asked = [];
    const s = await chain(c.dir, {}, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => ({ ok: true }), probe: async () => true,
      portOwnership: async (p, checkouts, ip) => { asked.push(ip); return ip === '::1' ? 'pid 9 runs outside the checkout' : 'none'; },
    });
    assert.deepEqual(asked, ['127.0.0.1', '::1']);
    assert.equal(s.state, 'failed');
    assert.match(s.run.error, /web \(:1\) is served by something else: pid 9/);
    assert.ok(!fs.existsSync(path.join(c.dir, 'seeded')));
  } finally { c.cleanup(); }
});

// Bugbot on #998 (9df5afe2): ::1 is tried only when nothing listens on 127.0.0.1, as ownership and Share do; an
// unhealthy answer on 127.0.0.1 is unhealthy. A ::1-only app says so, and its URLs name [::1].
test('probePort falls back to ::1 only when nothing listens on 127.0.0.1, and says which answered', async () => {
  const { probePort } = require('./environment-run');
  const http = require('node:http');
  const listen = (host, port, status) => new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => { res.statusCode = status; res.end(); });
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });
  const v4 = await listen('127.0.0.1', 0, 500);
  const port = v4.address().port;
  let v6;
  try { v6 = await listen('::1', port, 200); } catch { v4.close(); return; } // no IPv6 loopback here
  try {
    assert.deepEqual(await probePort({ port, health: '/' }), { ok: false, host: '127.0.0.1' }, "v4 answered 500: not the stranger on ::1");
    await new Promise(r => v4.close(r));
    assert.deepEqual(await probePort({ port, health: '/' }), { ok: true, host: '::1' });
  } finally { v4.close(); v6.close(); }
});

test("up records a port answered on ::1, and its URLs name [::1]", async () => {
  const { describeState } = require('./environment-run');
  const { turnNotice, frameFromEnvState } = require('./environment-file');
  const c = checkout({ '.termag/environment.json': { run: 'make dev', ports: [{ name: 'web', port: 1, path: '/app/' }] } });
  try {
    const s = await chain(c.dir, { again: true }, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => ({ ok: true }), probe: async () => ({ ok: true, host: '::1' }),
    });
    assert.equal(s.state, 'up');
    assert.equal(s.ports[0].host, '::1');
    assert.match(describeState(s).join('\n'), /http:\/\/\[::1\]:1\/app\//);
    assert.match(turnNotice({ ...s, updatedAt: 't' }, { told: true }).text, /web http:\/\/\[::1\]:1\/app\//);
    assert.equal(frameFromEnvState({ ...s, projectId: 'p1' }).status.ports[0].host, '::1');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (4b2ff70b): after a run starts, a healthy port is this app only when its checkouts serve it,
// as for an app found already up: a stranger on the port fails the run and is never seeded.
test("up's health wait after a run checks who serves the ports before it seeds", async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', seed: 'echo seeded > seeded', ports: [{ name: 'web', port: 1 }] } });
  try {
    let probes = 0;
    let started = 0;
    const deps = { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => { started++; return { ok: true }; }, probe: async () => (++probes > 1) };
    const s = await chain(c.dir, {}, { ...deps, portOwnership: async () => 'pid 9 runs outside the checkout' });
    assert.equal(started, 1, 'it did start its run (nothing was up)');
    assert.equal(s.state, 'failed');
    assert.equal(s.run.state, 'failed');
    assert.match(s.run.error, /web \(:1\) is served by something else: pid 9/);
    assert.ok(!fs.existsSync(path.join(c.dir, 'seeded')), 'never seeds a stranger');
    probes = 0;
    const own = await chain(c.dir, {}, { ...deps, portOwnership: async () => 'owned' });
    assert.equal(own.state, 'up');
    assert.equal(fs.readFileSync(path.join(c.dir, 'seeded'), 'utf8'), 'seeded\n');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (1426848a): a settled chain's session can hold only its kept-open `up` window. Killing that ends
// the session (tmux closes a session with no windows), so a retry starts a new session rather than a window in it.
test('startChain retries in a new session when killing the old up window ended it', async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'ready' }));
    let windows = ['up'];
    let session = true;
    const calls = [];
    const tmux = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'has-session') return { ok: session };
      if (args[0] === 'list-windows') return { ok: session, stdout: windows.map(w => `${w} 1`).join('\n') };
      if (args[0] === 'kill-window') { windows = windows.filter(w => !args[2].endsWith(`:${w}`)); if (!windows.length) session = false; return { ok: true, stdout: '' }; }
      if (args[0] === 'new-window') return { ok: session, stdout: '' };
      if (args[0] === 'new-session') { session = true; windows = ['up']; return { ok: true, stdout: '' }; }
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.started, true, JSON.stringify(r));
    assert.ok(calls.includes('new-session'), calls.join(' '));
    assert.equal(read(c.home, c.dir).state, 'pending');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (804b7062): a create that loses a race to another environment-up/termag-env up (whose session is
// now there) is that one's chain running, never a failure written over its state.
test('startChain that loses the session create to another up reports it running and leaves its state', async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    let session = false;
    const tmux = async (args) => {
      if (args[0] === 'has-session') return { ok: session };
      if (args[0] === 'list-windows') return { ok: session, stdout: 'up 0\n' };
      // The other up makes the session, and its chain finishes, between this one's check and its create.
      if (args[0] === 'new-session') {
        session = true;
        fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'up', setup: { state: 'succeeded' } }));
        return { ok: false, stdout: '' };
      }
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.running, true, JSON.stringify(r));
    assert.ok(!r.error);
    assert.equal(read(c.home, c.dir).state, 'up', 'the winner\'s state is kept');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (08ef466d): the winner settled before this up's `pending` write landed. Its kept-open `up` window
// writes nothing again, so the lost race must put back the state its pending replaced, never leave it pending.
test('startChain that loses the race after the winner settled puts the settled state back', async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    let session = false;
    let checks = 0;
    const tmux = async (args) => {
      if (args[0] === 'has-session') {
        // This up's first check: no session. The other up then makes it and its chain settles, all before this
        // up writes pending.
        if (++checks === 1) {
          fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'up', setup: { state: 'succeeded' } }));
          return { ok: false };
        }
        return { ok: session };
      }
      if (args[0] === 'list-windows') return { ok: session, stdout: 'up 0\n' };
      if (args[0] === 'new-session') { session = true; return { ok: false, stdout: '' }; }
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.running, true, JSON.stringify(r));
    const st = read(c.home, c.dir);
    assert.equal(st.state, 'up', 'not left pending');
    assert.equal(st.pendingId, undefined);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (04f6181a): a winner whose state carries this up's pendingId (chain copied it from the file) but
// has settled is the run's result, never rolled back.
test("startChain's lost race restores only an unsettled pending, not a settled winner carrying its token", async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'ready' }));
    let session = false;
    const tmux = async (args) => {
      if (args[0] === 'has-session') return { ok: session };
      if (args[0] === 'list-windows') return { ok: session, stdout: 'up 0\n' };
      if (args[0] === 'new-session') {
        // The other up's chain read this up's pending (token and all) and settled.
        const mine = JSON.parse(fs.readFileSync(statePath(c.home, envKey(c.dir)), 'utf8'));
        fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ ...mine, state: 'up' }));
        session = true;
        return { ok: false, stdout: '' };
      }
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.running, true);
    assert.equal(read(c.home, c.dir).state, 'up');
  } finally { c.cleanup(); }
});

test("chain doesn't carry a pending write's token into its own state", async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'pending', pendingId: 'abc' }));
    await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(read(c.home, c.dir).pendingId, undefined);
  } finally { c.cleanup(); }
});

// Devin on #998 (04f6181a): a run window gets the secrets that resolved from the caller's environment too, as setup does.
test("the run windows' exec file carries secrets resolved from the caller's environment", async () => {
  const { stateDir } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { run: 'node app.js', secrets: ['APP_TOKEN'] } });
  try {
    await chain(c.dir, { graceMs: 1 }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home, APP_TOKEN: 'abc123' },
      tmux: async () => ({ ok: true, stdout: '' }), startWindow: async () => ({ ok: true }), graceMs: 1 });
    const exec = JSON.parse(fs.readFileSync(path.join(stateDir(c.home), `${envKey(c.dir)}.exec.json`), 'utf8'));
    assert.equal(exec.env.APP_TOKEN, 'abc123');
  } finally { c.cleanup(); }
});

// Devin on #998 (04f6181a): a run with no ports that exits non-zero at once is a failed run, not an app up.
test('a portless run whose window exits non-zero at once fails', async () => {
  const { stateDir } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { run: 'exit 2' } });
  try {
    const s = await chain(c.dir, {}, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home }, tmux: async () => ({ ok: true, stdout: '' }), graceMs: 20,
      startWindow: async (i, entry) => {
        fs.writeFileSync(path.join(stateDir(c.home), `${envKey(c.dir)}.run-${i}.json`), JSON.stringify({ command: entry.command, exitCode: 2 }));
        return { ok: true };
      },
    });
    assert.equal(s.state, 'failed');
    assert.equal(s.run.state, 'failed');
    assert.match(s.run.error, /exit 2 exited 2/);
  } finally { c.cleanup(); }
});

// Review on #998: an app already serving before this up (the person started it, or trusted the project days after
// the claim) is never seeded automatically, first time or not: a non-idempotent seed would overwrite their data.
// Seed runs after a run this chain started, or on termag-env seed.
test("up doesn't seed an app that was already up before it, even one never seeded", async () => {
  const c = checkout({ '.termag/environment.json': { run: 'make dev', seed: 'echo seeded >> seed-count', ports: [{ name: 'web', port: 1 }] } });
  try {
    const out = sink();
    const deps = { home: c.home, out, env: { PATH: process.env.PATH, HOME: c.home }, pollMs: 5, tmux: async () => ({ ok: true, stdout: '' }),
      startWindow: async () => ({ ok: true }), probe: async () => true, portOwnership: async () => 'owned' };
    const s = await chain(c.dir, {}, deps);
    assert.equal(s.state, 'up');
    assert.ok(!fs.existsSync(path.join(c.dir, 'seed-count')), 'not seeded');
    assert.match(out.text, /already up before this up, so seed didn't run on it; termag-env seed runs it/);
    await chain(c.dir, { only: 'seed' }, deps);
    assert.equal(fs.readFileSync(path.join(c.dir, 'seed-count'), 'utf8'), 'seeded\n', 'termag-env seed still seeds it');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (926ff296): the pending write builds on the state read in the same step, not the snapshot taken
// before the tmux awaits, so a hold that landed in between keeps its pinned definition.
test("startChain's pending write keeps a held definition that landed during its tmux checks", async () => {
  const { startChain } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'echo checkout-file' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    const tmux = async (args) => {
      if (args[0] === 'has-session') {
        // environment-up's hold lands now, with the pinned definition.
        fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), state: 'held', held: 'pointer', fileText: '{"setup":"echo pinned"}', filePath: 'acme/web:main:e.json' }));
        return { ok: false };
      }
      return { ok: true, stdout: '' };
    };
    const r = await startChain(c.dir, {}, { home: c.home, tmux });
    assert.equal(r.started, true);
    const st = read(c.home, c.dir);
    assert.equal(st.state, 'pending');
    assert.equal(st.fileText, '{"setup":"echo pinned"}', 'the pinned definition, not the checkout file');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (926ff296): a chain whose window is gone (Ctrl-C, a reboot) is interrupted, not in
// progress for ever: the agent reconciles on connect, and termag-env status does too.
test('reconcileInterrupted marks an in-progress chain whose window is gone as interrupted, and leaves live and settled ones', async () => {
  const { reconcileInterrupted } = require('./environment-run');
  const c = checkout({});
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    const put = (name, s) => fs.writeFileSync(path.join(c.home, '.termag', 'env', `${name}.json`), JSON.stringify({ key: name, session: `termag-env-${name}`, ...s }));
    put('dead', { state: 'setup', setup: { state: 'running', startedAt: '2026-11-03T10:00:00Z' } });
    put('deadseed', { state: 'seeding', setup: { state: 'succeeded' }, seed: { state: 'running' } });
    put('live', { state: 'waiting', run: { state: 'running' } });
    // Settled: ready (an `up` whose session is gone is the reboot case, its own test).
    put('done', { state: 'ready', setup: { state: 'succeeded' } });
    const tmux = async (args) => {
      const live = args.includes('=termag-env-live');
      if (args[0] === 'has-session') return { ok: live };
      if (args[0] === 'list-windows') return { ok: live, stdout: live ? 'up 0\n' : '' };
      return { ok: true, stdout: '' };
    };
    const changed = await reconcileInterrupted(c.home, { tmux });
    assert.deepEqual(changed.sort(), ['dead', 'deadseed']);
    const get = (name) => JSON.parse(fs.readFileSync(path.join(c.home, '.termag', 'env', `${name}.json`), 'utf8'));
    assert.equal(get('dead').state, 'failed');
    assert.equal(get('dead').setup.state, 'failed');
    assert.match(get('dead').setup.error, /interrupted/);
    assert.equal(get('deadseed').seed.state, 'failed');
    assert.equal(get('live').state, 'waiting');
    assert.equal(get('done').state, 'ready');
  } finally { c.cleanup(); }
});

// A step that hangs is stopped and failed, never "Setting up" for ever.
test('a setup step that runs past its timeout is stopped and fails as timed out', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'sleep 30' } });
  try {
    const s = await chain(c.dir, { stepTimeoutS: 0.2 }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.state, 'failed');
    assert.equal(s.setup.state, 'failed');
    assert.match(s.setup.error, /timed out after/);
  } finally { c.cleanup(); }
});

// Devin on #998 (e1fbcadb): a timed-out step's whole process group is stopped, so a child holding its output can't
// keep the step (and so setup, seed or down) running; and a step that ran past its limit fails whatever it exits.
test('a timed-out step stops its children too, and fails even when it exits 0 on SIGTERM', async () => {
  for (const setup of ['(sleep 30) & wait', "trap 'exit 0' TERM; sleep 30 & wait"]) {
    const c = checkout({ '.termag/environment.json': { setup } });
    try {
      const t0 = Date.now();
      const s = await chain(c.dir, { stepTimeoutS: 0.2 }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
      assert.ok(Date.now() - t0 < 8000, `${setup}: took ${Date.now() - t0}ms`);
      assert.equal(s.setup.state, 'failed', setup);
      assert.match(s.setup.error, /timed out after/);
    } finally { c.cleanup(); }
  }
});

// Devin on #998 (e1fbcadb): a pending that another up wrote while tmux was asked is that up's, not the interrupted one.
test('reconcileInterrupted leaves a state another up rewrote while it checked', async () => {
  const { reconcileInterrupted } = require('./environment-run');
  const c = checkout({});
  try {
    const dir = path.join(c.home, '.termag', 'env');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'k.json');
    fs.writeFileSync(file, JSON.stringify({ key: 'k', session: 'termag-env-k', state: 'pending', updatedAt: 't1' }));
    const tmux = async (args) => {
      if (args[0] === 'has-session') {
        fs.writeFileSync(file, JSON.stringify({ key: 'k', session: 'termag-env-k', state: 'pending', updatedAt: 't2', pendingId: 'new' }));
        return { ok: false };
      }
      return { ok: false, stdout: '' };
    };
    assert.deepEqual(await reconcileInterrupted(c.home, { tmux }), []);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'pending');
  } finally { c.cleanup(); }
});

// Bugbot on #998 (e1fbcadb): after a reboot, an `up` whose session is gone has no app in its windows: stopped, its
// ports not healthy, so the card and Share don't offer an app nothing serves.
test('reconcileInterrupted stops an up whose session is gone and clears its ports', async () => {
  const { reconcileInterrupted } = require('./environment-run');
  const c = checkout({});
  try {
    const dir = path.join(c.home, '.termag', 'env');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'k.json'), JSON.stringify({ key: 'k', session: 'termag-env-k', state: 'up', ports: [{ name: 'web', port: 1, healthy: true, host: '::1' }] }));
    assert.deepEqual(await reconcileInterrupted(c.home, { tmux: async () => ({ ok: false, stdout: '' }) }), ['k']);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'k.json'), 'utf8'));
    assert.equal(st.state, 'stopped');
    assert.deepEqual(st.ports, [{ name: 'web', port: 1, healthy: false }]);
  } finally { c.cleanup(); }
});

// Bugbot on #998 (e1fbcadb): a probe that changes only checkedAt/updatedAt is not a change worth a frame.
test("the forwarder doesn't resend a state that changed only its check times", () => {
  const { createEnvForwarder } = require('./environment-run');
  let state = { projectId: 'p1', state: 'waiting', updatedAt: 't1', ports: [{ name: 'web', port: 1, healthy: false, checkedAt: 'a' }] };
  const sent = [];
  const f = createEnvForwarder({ readNames: () => ['k.json'], readFile: () => JSON.stringify(state), send: (fr) => sent.push(fr), isOpen: () => true });
  f.tick();
  state = { ...state, updatedAt: 't2', ports: [{ name: 'web', port: 1, healthy: false, checkedAt: 'b' }] };
  f.tick();
  assert.equal(sent.length, 1);
  state = { ...state, updatedAt: 't3', ports: [{ name: 'web', port: 1, healthy: true, checkedAt: 'c' }] };
  f.tick();
  assert.equal(sent.length, 2, 'a port turning healthy is sent');
});

// Bugbot on #998 (e1fbcadb): the agent's log line says a hold, not "undefined".
test('environmentUpLogLine names each answer, a hold included', () => {
  const { environmentUpLogLine } = require('./environment-run');
  assert.equal(environmentUpLogLine({ held: 'checkout' }), 'held (checkout): termag-env up runs it');
  assert.equal(environmentUpLogLine({ started: true, session: 's' }), 'started in s');
  assert.equal(environmentUpLogLine({ running: true }), 'already running');
  assert.equal(environmentUpLogLine({ skipped: 'no-file' }), 'skipped (no-file)');
  assert.equal(environmentUpLogLine({ error: 'boom' }), 'boom');
});

// Bugbot on #998 (e1fbcadb): state is keyed by path, so a new project cloned at the path of one archived there starts
// fresh: not that project's pinned definition, nor its succeeded setup.
test("environment-up for another project at the same path doesn't reuse the last one's state", async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'echo new' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), projectId: 'old', state: 'up', setup: { state: 'succeeded' }, fileText: '{"setup":"echo old"}' }));
    await handleEnvironmentUp({ projectId: 'new', instanceId: 'b1', dir: c.dir, trusted: true, hold: 'checkout' }, { home: c.home, tmux: async () => ({ ok: true, stdout: '' }) });
    const st = read(c.home, c.dir);
    assert.equal(st.projectId, 'new');
    assert.equal(st.fileText, undefined, "not the last project's pinned definition");
    assert.notEqual((st.setup || {}).state, 'succeeded', "not the last project's setup");
  } finally { c.cleanup(); }
});

// Bugbot / Devin on #998 (2bf6e84c): another project at a reused path also gets the old one's tmux session closed, so
// its app isn't taken for the new project's, and startChain doesn't see a live `up` window and stop there.
test("environment-up for another project at a reused path closes the last one's session too", async () => {
  const { handleEnvironmentUp, sessionName } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    fs.mkdirSync(path.join(c.home, '.termag', 'env'), { recursive: true });
    fs.writeFileSync(statePath(c.home, envKey(c.dir)), JSON.stringify({ key: envKey(c.dir), projectId: 'old', state: 'up' }));
    const calls = [];
    let live = true;
    const tmux = async (args) => {
      calls.push(args);
      if (args[0] === 'kill-session') { live = false; return { ok: true, stdout: '' }; }
      if (args[0] === 'has-session') return { ok: live };
      if (args[0] === 'list-windows') return { ok: live, stdout: live ? 'up 0\n' : '' };
      return { ok: true, stdout: '' };
    };
    const r = await handleEnvironmentUp({ projectId: 'new', instanceId: 'b1', dir: c.dir, trusted: true }, { home: c.home, tmux });
    assert.ok(calls.some(a => a[0] === 'kill-session' && a.includes(`=${sessionName(envKey(c.dir))}`)), JSON.stringify(calls));
    assert.equal(r.started, true, JSON.stringify(r));
  } finally { c.cleanup(); }
});

// Bugbot on #998 (2bf6e84c): a Ctrl-C (or a kill) of the chain stops its steps' process groups, a SIGKILL after a
// grace for one that ignores SIGTERM, before the chain exits.
test('an interrupted chain stops a step that ignores SIGTERM too', async () => {
  const { spawn } = require('node:child_process');
  const c = checkout({ '.termag/environment.json': { setup: "trap '' TERM; sleep 30 & echo $! > child.pid; wait" } });
  try {
    const proc = spawn(process.execPath, [path.join(__dirname, 'environment-run.js'), 'chain', c.dir], { env: { ...process.env, HOME: c.home, TMUX: '' }, stdio: 'ignore' });
    const pidFile = path.join(c.dir, 'child.pid');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    proc.kill('SIGINT');
    await new Promise(r => proc.once('exit', r));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 80 && alive(); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(alive(), false, 'the step\'s child is gone');
  } finally { c.cleanup(); }
});

// Review on #998: what started the chain, and whether setup ran again, reach the setup event; an untrusted
// project's hold is kept like any other, but a checkout with no file shows nothing.
test('the frame says why a hold is held, what started the chain, and whether setup reran', async () => {
  const { handleEnvironmentUp, startChain } = require('./environment-run');
  const { frameFromEnvState } = require('./environment-file');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: c.dir, trusted: false, hold: 'untrusted', trigger: 'claim' }, { home: c.home, tmux: async () => ({ ok: true, stdout: '' }) }), { held: 'untrusted' });
    let f = frameFromEnvState(read(c.home, c.dir));
    assert.equal(f.status.held, 'untrusted');
    // termag-env up from the CLI says so.
    await startChain(c.dir, {}, { home: c.home, tmux: async (a) => ({ ok: a[0] !== 'has-session', stdout: '' }) });
    assert.equal(read(c.home, c.dir).trigger, 'cli');
    // A setup run again after it succeeded is a rerun.
    let s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.notEqual(s.setup.rerun, true);
    s = await chain(c.dir, { again: true }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.rerun, true);
    f = frameFromEnvState({ ...s, projectId: 'p1' });
    assert.equal(f.status.setup.rerun, true);
    assert.equal(f.status.trigger, 'cli');
  } finally { c.cleanup(); }
  const none = checkout({});
  try {
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: none.dir, trusted: false, hold: 'untrusted' }, { home: none.home }), { skipped: 'no-file' });
  } finally { none.cleanup(); }
});

// Decision #58 on #998: a step's environment is an allowlist, not the agent's: PATH, HOME, the environment's own
// `env`, and the secrets it asks for.
test("a step's environment is PATH, HOME, the file's env and its secrets, nothing of the agent's", async () => {
  // seed's: setup gets no secrets at all (the next test but one and 'setup gets no secrets').
  const c = checkout({ '.termag/environment.json': { seed: 'env > envdump', env: { APP_MODE: 'dev' }, secrets: ['APP_TOKEN'] } });
  try {
    await chain(c.dir, {}, { home: c.home, out: sink(),
      env: { PATH: process.env.PATH, HOME: c.home, APP_TOKEN: 'abc', BASH_ENV: '/evil', TERMAG_AGENT_TOKEN: 'tmag_x', OTHER: 'y' } });
    const vars = Object.fromEntries(fs.readFileSync(path.join(c.dir, 'envdump'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(vars.APP_MODE, 'dev');
    assert.equal(vars.APP_TOKEN, 'abc');
    assert.equal(vars.HOME, c.home);
    for (const k of ['BASH_ENV', 'TERMAG_AGENT_TOKEN', 'OTHER']) assert.equal(vars[k], undefined, k);
  } finally { c.cleanup(); }
});

test("a run window's environment is the same allowlist, never the window's own", () => {
  const { windowEnv } = require('./environment-run');
  const env = windowEnv({ env: { APP_MODE: 'dev', APP_TOKEN: 'abc' } }, '/w/web', 'k', { PATH: '/usr/bin', HOME: '/home/u', BASH_ENV: '/evil', TMUX: 'x', SECRET: 's' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/u', APP_MODE: 'dev', APP_TOKEN: 'abc', TERMAG_ENV_DIR: '/w/web', TERMAG_ENV_KEY: 'k' });
});

test("the file's env is parsed: names checked, values text", () => {
  const { parseEnvironmentFile } = require('./environment-file');
  const p = parseEnvironmentFile(JSON.stringify({ env: { GOOD: 'x', 'bad-name': 'y', NUM: 3 } }), { checkouts: {}, root: '/w', multi: false });
  assert.deepEqual(p.env, { GOOD: 'x' });
  assert.equal(p.warnings.filter(w => /env/.test(w)).length, 2);
});

// Devin on #998 (1e3aaac4): a step's group is stopped while any member is left, not only while its shell runs: a
// backgrounded child that ignores SIGTERM and doesn't hold the step's output still gets SIGKILL before the chain exits.
test('an interrupted chain stops a backgrounded child that outlives its step shell', async () => {
  const { spawn } = require('node:child_process');
  const c = checkout({ '.termag/environment.json': { setup: "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > child.pid; wait" } });
  try {
    const proc = spawn(process.execPath, [path.join(__dirname, 'environment-run.js'), 'chain', c.dir], { env: { ...process.env, HOME: c.home, TMUX: '' }, stdio: 'ignore' });
    const pidFile = path.join(c.dir, 'child.pid');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    proc.kill('SIGINT');
    await new Promise(r => proc.once('exit', r));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 20 && alive(); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(alive(), false, 'the backgrounded child is gone by the time the chain has exited');
  } finally { c.cleanup(); }
});

// Environment pools, task B ("Secrets" and "setup reruns when the checkout moved").
const commit = (dir, file, text) => {
  fs.writeFileSync(path.join(dir, file), text);
  execFileSync('git', ['-C', dir, 'add', file]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', file]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
};

test('setup gets no secrets, even ones the file names; seed and run windows get them', async () => {
  const c = checkout({ '.termag/environment.json': {
    setup: 'env > setup-env', seed: 'env > seed-env', secrets: ['MY_TOKEN'], env: { PLAIN: 'yes' },
  } });
  try {
    const s = await chain(c.dir, {}, {
      home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home, MY_TOKEN: 'from-env' },
    });
    assert.equal(s.setup.state, 'succeeded');
    assert.equal(s.seed.state, 'succeeded');
    const setupEnv = fs.readFileSync(path.join(c.dir, 'setup-env'), 'utf8');
    const seedEnv = fs.readFileSync(path.join(c.dir, 'seed-env'), 'utf8');
    assert.doesNotMatch(setupEnv, /MY_TOKEN/);
    assert.match(setupEnv, /^PLAIN=yes$/m, "the file's own env still reaches setup");
    assert.match(setupEnv, /^TERMAG_ENV_KEY=/m);
    assert.match(seedEnv, /^MY_TOKEN=from-env$/m);
    // The run windows read theirs from the exec file, which still carries them.
    const exec = JSON.parse(fs.readFileSync(path.join(c.home, '.termag', 'env', `${envKey(c.dir)}.exec.json`), 'utf8'));
    assert.equal(exec.env.MY_TOKEN, 'from-env');
  } finally { c.cleanup(); }
});

test('setup records the commit it succeeded at, and reruns before the next up only when HEAD moved', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'echo ran >> ../setup-count' } });
  const deps = () => ({ home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
  const count = () => fs.readFileSync(path.join(c.root, 'setup-count'), 'utf8').split('\n').filter(Boolean).length;
  try {
    const first = commit(c.dir, 'a.txt', 'a');
    let s = await chain(c.dir, {}, deps());
    assert.deepEqual(s.setupCommit, { 'acme/web': first });
    assert.equal(count(), 1);

    // Nothing moved: setup is not run again.
    let out = sink();
    s = await chain(c.dir, {}, { ...deps(), out });
    assert.equal(count(), 1);
    assert.match(out.text, /setup already ran/);

    // A pull (here a commit) moves HEAD: the next up reruns setup first, and records the new commit.
    const second = commit(c.dir, 'b.txt', 'b');
    out = sink();
    s = await chain(c.dir, {}, { ...deps(), out });
    assert.equal(count(), 2);
    assert.match(out.text, new RegExp(`acme/web moved from ${first.slice(0, 7)} to ${second.slice(0, 7)}`));
    assert.equal(s.setup.rerun, true);
    assert.deepEqual(s.setupCommit, { 'acme/web': second });

    // termag-env run skips setup by asking, but says the checkout moved.
    commit(c.dir, 'c.txt', 'c');
    out = sink();
    s = await chain(c.dir, { skipSetup: true }, { ...deps(), out });
    assert.equal(count(), 2);
    assert.match(out.text, /acme\/web moved .*termag-env up reruns setup/);
  } finally { c.cleanup(); }
});

test('an environment with no setup still records the commits it was run past: a pool box reads them as prepared (Bugbot on #1453)', async () => {
  const c = checkout({ '.termag/environment.json': { run: 'true' } });
  try {
    const first = commit(c.dir, 'a.txt', 'a');
    const s = await chain(c.dir, { only: 'setup' }, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.state, 'none');
    assert.equal(s.state, 'ready');
    assert.deepEqual(s.setupCommit, { 'acme/web': first });
    // And the frame the orchestrator gets carries them.
    const { frameFromEnvState } = require('./environment-file');
    assert.deepEqual(frameFromEnvState({ ...s, projectId: 'pool' }).status.setupCommit, { 'acme/web': first });
  } finally { c.cleanup(); }
});

test('a failed setup records no commit, so the next up runs it again even with HEAD unchanged', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'test -f ok' } });
  try {
    commit(c.dir, 'a.txt', 'a');
    let s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.state, 'failed');
    assert.equal(s.setupCommit, undefined);
    fs.writeFileSync(path.join(c.dir, 'ok'), '');
    s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(s.setup.state, 'succeeded');
    assert.ok(s.setupCommit['acme/web']);
  } finally { c.cleanup(); }
});

test('a state from before setupCommit counts as moved: up reruns setup once and records it', async () => {
  const c = checkout({ '.termag/environment.json': { setup: 'echo ran >> ../setup-count' } });
  try {
    const sha = commit(c.dir, 'a.txt', 'a');
    await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    const file = statePath(c.home, envKey(c.dir));
    const { setupCommit: _drop, ...old } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(old));
    const s = await chain(c.dir, {}, { home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home } });
    assert.equal(fs.readFileSync(path.join(c.root, 'setup-count'), 'utf8'), 'ran\nran\n');
    assert.deepEqual(s.setupCommit, { 'acme/web': sha });
  } finally { c.cleanup(); }
});

test('describeState names the commit setup last succeeded at', () => {
  const lines = describeState({ state: 'up', session: 'termag-env-web-1', setup: { state: 'succeeded', durationMs: 2000 }, setupCommit: { 'acme/web': '0123456789abcdef' } });
  assert.ok(lines.includes('  setup commit: acme/web 0123456'));
});

test("environment-up keys the chain by the checkout's real path: a project directory linked to ~/code/<repo> is that checkout", async () => {
  const { handleEnvironmentUp } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': { setup: 'true' } });
  try {
    const real = fs.realpathSync(c.dir);
    const link = path.join(c.root, 'projects-widget');
    fs.symlinkSync(c.dir, link);
    const tmux = async (args) => ({ ok: args[0] !== 'has-session', stdout: '' });
    assert.deepEqual(await handleEnvironmentUp({ projectId: 'p1', instanceId: 'b1', dir: link, trusted: true }, { home: c.home, tmux }), { started: true, session: sessionName(envKey(real)) });
    assert.equal(read(c.home, real).dir, real);
    assert.equal(fs.existsSync(statePath(c.home, envKey(link))), false);
  } finally { c.cleanup(); }
});

test("setup can't read the run windows' secrets from disk: they're written after setup, and an earlier run's are removed first (Devin, #1462)", async () => {
  const c = checkout({ '.termag/environment.json': {
    setup: 'cat "$HOME"/.termag/env/*.exec.json > ../setup-saw 2>/dev/null; true', secrets: ['MY_TOKEN'],
  } });
  const deps = () => ({ home: c.home, out: sink(), env: { PATH: process.env.PATH, HOME: c.home, MY_TOKEN: 'tok-value' } });
  try {
    await chain(c.dir, {}, deps());
    assert.doesNotMatch(fs.readFileSync(path.join(c.root, 'setup-saw'), 'utf8'), /tok-value/);
    // The run windows still get theirs, once setup is done.
    const exec = path.join(c.home, '.termag', 'env', `${envKey(c.dir)}.exec.json`);
    assert.equal(JSON.parse(fs.readFileSync(exec, 'utf8')).env.MY_TOKEN, 'tok-value');
    // A rerun of setup: the earlier run's file is gone before it starts.
    await chain(c.dir, { again: true }, deps());
    assert.doesNotMatch(fs.readFileSync(path.join(c.root, 'setup-saw'), 'utf8'), /tok-value/);
    assert.equal(JSON.parse(fs.readFileSync(exec, 'utf8')).env.MY_TOKEN, 'tok-value');
  } finally { c.cleanup(); }
});

test('a named repository whose checkout is gone counts as moved: up reruns setup (Devin, #1462)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envrun-gone-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.termag-workspace'), 'marker\n');
  for (const [name, url] of [['web', 'https://github.com/acme/web'], ['api', 'https://github.com/acme/api']]) {
    execFileSync('git', ['init', '-q', path.join(ws, name)]);
    execFileSync('git', ['-C', path.join(ws, name), 'remote', 'add', 'origin', url]);
    commit(path.join(ws, name), 'a.txt', name);
  }
  const fileText = JSON.stringify({ repos: [{ repo: 'acme/web' }, { repo: 'acme/api' }], setup: { 'acme/web': 'echo ran >> ../../setup-count' } });
  const deps = () => ({ home, out: sink(), env: { PATH: process.env.PATH, HOME: home } });
  try {
    let s = await chain(ws, { fileText, fileRepo: 'acme/web' }, deps());
    assert.ok(s.setupCommit['acme/api']);
    fs.rmSync(path.join(ws, 'api'), { recursive: true, force: true });
    s = await chain(ws, {}, deps());
    assert.equal(fs.readFileSync(path.join(root, 'setup-count'), 'utf8'), 'ran\nran\n');
    assert.equal(s.setupCommit['acme/api'], null);
    // Still gone: nothing moved since, so no third run.
    await chain(ws, {}, deps());
    assert.equal(fs.readFileSync(path.join(root, 'setup-count'), 'utf8'), 'ran\nran\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('down after a failed setup rerun still gives stop its secrets, resolved then (Devin, #1462)', async () => {
  const { stopEnvironment } = require('./environment-run');
  const c = checkout({ '.termag/environment.json': {
    setup: 'test ! -f ../fail-setup', stop: 'echo "${MY_TOKEN:-unset}" > ../stop-saw', secrets: ['MY_TOKEN'],
  } });
  const env = { PATH: process.env.PATH, HOME: c.home, MY_TOKEN: 'tok-value' };
  try {
    assert.equal((await chain(c.dir, {}, { home: c.home, out: sink(), env })).setup.state, 'succeeded');
    fs.writeFileSync(path.join(c.root, 'fail-setup'), '');
    assert.equal((await chain(c.dir, { again: true }, { home: c.home, out: sink(), env })).setup.state, 'failed');
    const r = await stopEnvironment(c.dir, {}, { home: c.home, out: sink(), env, tmux: async () => ({ ok: true, stdout: '' }) });
    assert.equal(r.stop.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(c.root, 'stop-saw'), 'utf8'), 'tok-value\n');
  } finally { c.cleanup(); }
});
