import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./claude-auth.mjs', import.meta.url));

function run(args, { home, input, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

// The login fake writes the browser line, the URL, and the prompt as separate
// chunks. The first `data` event is often only the first line.
function waitFor(stream, read, pattern, ms = 2000) {
  if (pattern.test(read())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`timed out waiting for ${pattern}; saw ${JSON.stringify(read())}`));
    }, ms);
    function onData() {
      if (!pattern.test(read())) return;
      clearTimeout(timer);
      stream.off('data', onData);
      resolve();
    }
    stream.on('data', onData);
  });
}

test('status is logged out, gateway settings count as logged in, and a paste is not echoed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-auth-'));
  const loggedOut = await run(['auth', 'status'], { home });
  assert.equal(loggedOut.code, 1);
  assert.equal(JSON.parse(loggedOut.stdout).loggedIn, false);

  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'termag-credentials claude-token' }));
  const gateway = await run(['auth', 'status'], { home });
  assert.equal(gateway.code, 0);
  assert.equal(JSON.parse(gateway.stdout).authMethod, 'third_party');

  const fresh = mkdtempSync(join(tmpdir(), 'claude-auth-'));
  const bad = 'other-code#other-state\n';
  const child = spawn(process.execPath, [script, 'auth', 'login', '--claudeai', '--sso'], {
    env: { ...process.env, HOME: fresh },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  try {
    await waitFor(child.stdout, () => stdout, /https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    assert.match(stdout, /login_method=sso/);
    child.stdin.write(bad);
    await waitFor(child.stderr, () => stderr, /Invalid code/);
    assert.equal(stdout.includes('other-code'), false);
    assert.equal(stderr.includes('other-code'), false);
    child.stdin.end('e2e-login#e2e-state\n');
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 0);
  } finally {
    if (child.exitCode == null) child.kill();
  }
  assert.match(stdout, /Login successful/);
  const after = await run(['auth', 'status'], { home: fresh });
  assert.equal(JSON.parse(after.stdout).authMethod, 'claude.ai');
});
