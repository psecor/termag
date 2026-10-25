'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  LOGIN_TTL_MS, authorizeUrlFrom, codeError, createClaudeLogin, fixedError, scrubLoginOutput,
} = require('./claude-login');

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user&code_challenge=e2e-challenge&code_challenge_method=S256&state=e2e-state&login_method=sso';
const GOOD = 'good-code#good-state';

function statusJson(loggedIn, extra = {}) {
  return JSON.stringify({
    loggedIn,
    authMethod: loggedIn ? 'claude.ai' : 'none',
    apiProvider: 'firstParty',
    ...extra,
  });
}

function harness({ gateway = false } = {}) {
  const state = { signedIn: false, gateway, spawns: 0, writes: [], env: null };
  async function execFile(_bin, args) {
    assert.deepEqual(args, ['auth', 'status']);
    if (state.gateway) {
      return { stdout: statusJson(true, { authMethod: 'third_party', apiProvider: 'bedrock' }) };
    }
    if (state.signedIn) return { stdout: statusJson(true) };
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl(_bin, args, opts) {
    state.spawns += 1;
    state.env = opts.env;
    assert.deepEqual(args.slice(0, 4), ['auth', 'login', '--claudeai', '--sso']);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin.on('data', chunk => {
      const line = String(chunk);
      state.writes.push(line);
      const code = line.trim();
      if (code === GOOD) {
        state.signedIn = true;
        child.stdout.write('Login successful.\n');
        setImmediate(() => child.kill());
      } else {
        child.stderr.write(`Invalid code. Please make sure the full code was copied. ${code}\n`);
      }
    });
    setImmediate(() => {
      child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `);
    });
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/tmp/scratch', DISPLAY: ':1', BROWSER: 'echo' },
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 200,
  });
  return { login, state };
}

test('a paste is code#state, and a token is refused without being repeated', () => {
  assert.equal(codeError(GOOD), null);
  assert.equal(codeError(`  ${GOOD}\n`), null);
  const token = 'sk-ant-oat01-abcdefghijklmnop#statevalue';
  const reason = codeError(token);
  assert.match(reason, /not a token/);
  assert.equal(reason.includes(token), false);
  assert.equal(reason.includes('sk-ant'), false);
  assert.match(codeError('short#no'), /including the #/);
  assert.equal(fixedError(`Invalid code. ${GOOD}`).includes(GOOD), false);
});

test('only the SSO authorize URL is accepted', () => {
  assert.equal(authorizeUrlFrom(`visit: ${URL}`), URL);
  assert.equal(authorizeUrlFrom(URL.replace('login_method=sso', 'login_method=cli')), null);
  assert.equal(authorizeUrlFrom(URL.replace('https://claude.com', 'http://claude.com')), null);
  assert.equal(authorizeUrlFrom('https://evil.example/cai/oauth/authorize?code_challenge=x&login_method=sso'), null);
});

test('two overlapping starts share one login process', async () => {
  const children = [];
  async function execFile() {
    await new Promise(resolve => setImmediate(resolve));
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    children.push(child);
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 200,
  });
  const [first, second] = await Promise.all([login.start(), login.start()]);
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, undefined);
  assert.equal(first.phase, 'needs-code');
  assert.equal(second.url, first.url);
  assert.equal(second.phase, 'needs-code');
});

test('two overlapping pastes write one line and both see the sign-in', async () => {
  const writes = [];
  let child;
  let signedIn = false;
  const other = 'other-code#other-state';
  async function execFile() {
    if (signedIn) return { stdout: statusJson(true) };
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin.on('data', chunk => { writes.push(String(chunk)); });
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 400,
  });
  const open = await login.start();
  assert.equal(open.phase, 'needs-code');
  const first = login.submit(GOOD);
  const second = login.submit(other);
  const deadline = Date.now() + 200;
  while (writes.length === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [`${GOOD}\n`]);
  signedIn = true;
  child.stdout.write('Login successful.\n');
  setImmediate(() => child.kill());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.phase, 'ready');
  assert.equal(a.loggedIn, true);
  assert.equal(b.phase, 'ready');
  assert.equal(b.loggedIn, true);
  assert.deepEqual(writes, [`${GOOD}\n`]);
  assert.equal(JSON.stringify(a).includes(GOOD), false);
  assert.equal(JSON.stringify(b).includes(other), false);
});

test('a gateway box is left alone and no login process starts', async () => {
  const { login, state } = harness({ gateway: true });
  const view = await login.start('person@example.invalid');
  assert.equal(view.phase, 'ready');
  assert.equal(view.loggedIn, true);
  assert.equal(view.authMethod, 'third_party');
  assert.equal(view.url, undefined);
  assert.equal(state.spawns, 0);
});

test('start prints a link, a bad paste is not kept, and a good paste signs in once', async () => {
  const { login, state } = harness();
  const started = await login.start('person@example.invalid');
  assert.equal(started.phase, 'needs-code');
  assert.equal(started.url, URL);
  assert.equal(state.spawns, 1);
  assert.equal(state.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(state.env.DISPLAY, undefined);
  assert.equal(state.env.BROWSER, undefined);
  assert.equal(state.env.HOME, '/tmp/claude-login-test');
  assert.deepEqual(state.env && Object.keys(state.env).includes('CLAUDE_CONFIG_DIR'), false);

  const token = 'sk-ant-oat01-abcdefghijklmnop#statevalue';
  const rejected = await login.submit(token);
  assert.match(rejected.error, /not a token/);
  assert.equal(JSON.stringify(rejected).includes(token), false);
  assert.equal(JSON.stringify(rejected).includes('sk-ant'), false);
  assert.equal(state.writes.length, 0);

  const bad = 'other-code#other-state';
  const invalid = await login.submit(bad);
  assert.equal(invalid.phase, 'needs-code');
  assert.match(invalid.error, /not accepted/);
  assert.equal(JSON.stringify(invalid).includes(bad), false);
  assert.equal(state.writes.length, 1);
  assert.equal(state.spawns, 1);

  const ok = await login.submit(GOOD);
  assert.equal(ok.phase, 'ready');
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.url, undefined);
  assert.equal(JSON.stringify(ok).includes(GOOD), false);
  assert.equal(state.signedIn, true);
});

test('a sign-in that never offers a link fails closed, and an old one expires', async () => {
  let now = 1_000;
  const calls = { spawns: 0 };
  async function execFile() {
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    calls.spawns += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    now: () => now,
    urlWaitMs: 20,
    resultWaitMs: 20,
  });
  const failed = await login.start();
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error, /did not offer a sign-in link/);
  assert.equal(failed.url, undefined);

  function hanging() {
    calls.spawns += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.emit('exit', 0); };
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const second = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl: hanging,
    execFile,
    claudeBin: '/usr/bin/claude',
    now: () => now,
    urlWaitMs: 50,
    resultWaitMs: 20,
  });
  const open = await second.start();
  assert.equal(open.phase, 'needs-code');
  now += LOGIN_TTL_MS + 5;
  const expired = await second.status();
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.url, undefined);
});

test('an opening line does not drop the waiter for the authorize URL', async () => {
  async function execFile() {
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.emit('exit', 0); };
    setImmediate(() => {
      child.stdout.write('Opening browser to sign in…\n');
      setImmediate(() => child.stdout.write(`If the browser didn't open, visit: ${URL}\n`));
    });
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 500,
    resultWaitMs: 50,
  });
  const started = Date.now();
  const view = await login.start();
  assert.equal(view.phase, 'needs-code');
  assert.equal(view.url, URL);
  assert.ok(Date.now() - started < 400, 'start waited out the URL timeout');
});

test('an echoed paste does not drop the waiter for the login result', async () => {
  const state = { writes: [] };
  async function execFile() {
    if (state.signedIn) return { stdout: statusJson(true) };
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin.on('data', chunk => {
      state.writes.push(String(chunk));
      setImmediate(() => {
        child.stdout.write(chunk);
        setImmediate(() => {
          state.signedIn = true;
          child.stdout.write('Login successful.\n');
          setImmediate(() => child.kill());
        });
      });
    });
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 500,
  });
  const started = await login.start();
  assert.equal(started.phase, 'needs-code');
  const t0 = Date.now();
  const done = await login.submit(GOOD);
  assert.equal(done.phase, 'ready');
  assert.equal(done.loggedIn, true);
  assert.equal(JSON.stringify(done).includes(GOOD), false);
  assert.ok(Date.now() - t0 < 400, 'submit waited out the result timeout');
  assert.equal(state.writes.length, 1);
});

function loggedOutError() {
  const err = new Error('exit 1');
  err.stdout = statusJson(false);
  return err;
}

test('a status poll during submit does not reset a finished sign-in', async () => {
  let n = 0;
  let releasePoll;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  let pollEntered;
  const pollEnteredGate = new Promise(resolve => { pollEntered = resolve; });
  let releaseConfirm;
  const confirmGate = new Promise(resolve => { releaseConfirm = resolve; });
  let confirmEntered;
  const confirmEnteredGate = new Promise(resolve => { confirmEntered = resolve; });
  async function execFile() {
    n += 1;
    if (n < 3) throw loggedOutError();
    if (n === 3) {
      confirmEntered();
      await confirmGate;
      return { stdout: statusJson(true) };
    }
    if (n === 4) throw loggedOutError();
    if (n === 5) {
      pollEntered();
      await pollGate;
      throw loggedOutError();
    }
    throw loggedOutError();
  }
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin.on('data', () => {
      child.stdout.write('Login successful.\n');
      setImmediate(() => child.kill());
    });
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 200,
  });
  const open = await login.start();
  assert.equal(open.phase, 'needs-code');

  const submitP = login.submit(GOOD);
  await confirmEnteredGate;
  const pending = await login.status();
  assert.equal(pending.phase, 'submitting');
  assert.equal(JSON.stringify(pending).includes(GOOD), false);

  const statusP = login.status();
  await pollEnteredGate;
  releaseConfirm();
  const done = await submitP;
  assert.equal(done.phase, 'ready');
  assert.equal(done.loggedIn, true);
  releasePoll();
  const polled = await statusP;
  assert.equal(polled.phase, 'ready');
  assert.equal(polled.loggedIn, true);
  assert.equal(polled.url, undefined);

  const loggedOut = await login.status();
  assert.equal(loggedOut.phase, 'needed');
  assert.equal(loggedOut.loggedIn, false);
});

test('a paste echoed inside a prompt line is scrubbed', () => {
  const echoed = `Paste code here if prompted > ${GOOD}`;
  const cleaned = scrubLoginOutput(echoed);
  assert.equal(cleaned.includes(GOOD), false);
  assert.equal(cleaned.includes('#'), false);
  const token = 'prefix sk-ant-oat01-abcdefghijklmnop suffix';
  const stripped = scrubLoginOutput(token);
  assert.equal(stripped.includes('sk-ant'), false);
  assert.match(stripped, /prefix/);
  assert.match(stripped, /suffix/);
});

test('cancel wakes a start that is still waiting for the link', async () => {
  let child;
  async function execFile() {
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 400,
    resultWaitMs: 400,
  });
  const pending = login.start();
  const deadline = Date.now() + 200;
  while (!child && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(child, 'login did not spawn');
  const t0 = Date.now();
  login.cancel();
  await pending;
  assert.ok(Date.now() - t0 < 200, 'start sat out the URL wait after cancel');
  assert.equal(child.killed, true);
});

test('cancel wakes a submit that is still waiting for the result', async () => {
  async function execFile() {
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 400,
  });
  const open = await login.start();
  assert.equal(open.phase, 'needs-code');
  const pending = login.submit(GOOD);
  await new Promise(resolve => setImmediate(resolve));
  const t0 = Date.now();
  login.cancel();
  const view = await pending;
  assert.ok(Date.now() - t0 < 200, 'submit sat out the result wait after cancel');
  assert.equal(JSON.stringify(view).includes(GOOD), false);
});

test('a sign-in expires on its own when nobody asks again', async () => {
  let child;
  async function execFile() {
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    now: () => Date.now(),
    ttlMs: 30,
    urlWaitMs: 200,
    resultWaitMs: 50,
  });
  const open = await login.start();
  assert.equal(open.phase, 'needs-code');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(child.killed, true);
  const expired = await login.status();
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.url, undefined);
});

test('a failed status read keeps an open sign-in and is unavailable with none', async () => {
  let failStatus = false;
  let child;
  let spawns = 0;
  async function execFile() {
    if (failStatus) throw new Error('ENOENT');
    const err = new Error('exit 1');
    err.stdout = statusJson(false);
    throw err;
  }
  function spawnImpl() {
    spawns += 1;
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => child.stdout.write(`visit: ${URL}\n`));
    return child;
  }
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    spawnImpl,
    execFile,
    claudeBin: '/usr/bin/claude',
    urlWaitMs: 200,
    resultWaitMs: 200,
  });
  const open = await login.start();
  assert.equal(open.phase, 'needs-code');
  assert.equal(open.url, URL);
  failStatus = true;
  const again = await login.status();
  assert.equal(again.phase, 'needs-code');
  assert.equal(again.url, URL);
  assert.equal(child.killed, false);
  const joined = await login.start();
  assert.equal(joined.phase, 'needs-code');
  assert.equal(joined.url, URL);
  assert.equal(spawns, 1);

  const idle = createClaudeLogin({
    home: '/tmp/claude-login-test',
    claudeBin: '/usr/bin/claude',
    execFile: async () => { throw new Error('ENOENT'); },
    spawnImpl: () => { throw new Error('should not spawn'); },
  });
  assert.equal((await idle.status()).phase, 'unavailable');
  assert.equal((await idle.start()).phase, 'unavailable');
});

test('claude missing is unavailable, not a crash', async () => {
  const login = createClaudeLogin({
    home: '/tmp/claude-login-test',
    claudeBin: '/usr/bin/claude',
    execFile: async () => { throw new Error('ENOENT'); },
    spawnImpl: () => { throw new Error('should not spawn'); },
  });
  const view = await login.status();
  assert.equal(view.phase, 'unavailable');
  assert.equal(view.loggedIn, false);
});
