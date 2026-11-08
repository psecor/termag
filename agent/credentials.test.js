const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyCredential, removeCredential, CAPABILITIES, configure, capabilitiesFor, MCP_AGENTS_MARKER, FIREWORKS_MENU_MARKER,
  FIREWORKS_PI_MENU_MARKER, FIREWORKS_PI_LAUNCHER_MARKER, installedDirs,
} = require('./credentials');

const SENTINEL = 'sentinel-token-7f3e';

function stubScript(dir, body) {
  const script = path.join(dir, 'termag-credentials');
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return script;
}

test('advertises credentials-v1, the GitHub broker, telemetry and its launch settings', () => {
  assert.deepStrictEqual(CAPABILITIES.slice(0, 7), ['credentials-v1', 'github-broker-v1', 'telemetry-v1', 'telemetry-replay-v1', 'agent-telemetry-v1', 'mcp-broker-v1', 'fireworks-v1']);
});

test('advertises mcp-broker-v2 only when the script carries its marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const old = stubScript(dir, 'exit 0');
  assert.ok(!capabilitiesFor(old).includes('mcp-broker-v2'));
  fs.writeFileSync(old, `#!/bin/sh
# ${MCP_AGENTS_MARKER}
`);
  assert.deepStrictEqual(capabilitiesFor(old).slice(-2), ['bazel-cache-v2', 'mcp-broker-v2']);
  assert.ok(!capabilitiesFor(path.join(dir, 'missing')).includes('mcp-broker-v2'));
});

test('advertises fireworks-menu-v1 only when the script takes --models, in the checkout and installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-bin-'));
  const old = stubScript(dir, 'exit 0');
  stubScript(bin, `# ${FIREWORKS_MENU_MARKER}`);
  assert.ok(!capabilitiesFor(old, undefined, bin).includes('fireworks-menu-v1'));
  fs.writeFileSync(old, `#!/bin/sh\n# ${FIREWORKS_MENU_MARKER}\n`);
  assert.deepStrictEqual(capabilitiesFor(old, undefined, bin).slice(-2), ['bazel-cache-v2', 'fireworks-menu-v1']);
  // A checkout pulled ahead of the installed copy the launch runs.
  fs.writeFileSync(path.join(bin, 'termag-credentials'), '#!/bin/sh\nexit 0\n');
  assert.ok(!capabilitiesFor(old, undefined, bin).includes('fireworks-menu-v1'));
  // Nothing installed at all.
  assert.ok(!capabilitiesFor(old, undefined, path.join(bin, 'missing')).includes('fireworks-menu-v1'));
  // The real script carries it.
  assert.ok(capabilitiesFor(undefined, undefined, path.join(__dirname, '..', 'deploy')).includes('fireworks-menu-v1'));
});

test('advertises fireworks-pi-menu-v1 only when both pi-model and termag-pi-fireworks take --models, in the checkout and installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-bin-'));
  const script = stubScript(dir, `# ${FIREWORKS_PI_MENU_MARKER}`);
  stubScript(bin, `# ${FIREWORKS_PI_MENU_MARKER}`);
  fs.writeFileSync(path.join(bin, 'termag-pi-fireworks'), `#!/bin/sh\n# ${FIREWORKS_PI_LAUNCHER_MARKER}\n`);
  // pi-model takes it, but an older launcher would hand --models to pi.
  assert.ok(!capabilitiesFor(script, undefined, bin).includes('fireworks-pi-menu-v1'));
  fs.writeFileSync(path.join(dir, 'termag-pi-fireworks'), `#!/bin/sh\n# ${FIREWORKS_PI_LAUNCHER_MARKER}\n`);
  assert.deepStrictEqual(capabilitiesFor(script, undefined, bin).slice(-2), ['bazel-cache-v2', 'fireworks-pi-menu-v1']);
  // The installed launcher predates it.
  fs.writeFileSync(path.join(bin, 'termag-pi-fireworks'), '#!/bin/sh\nexit 0\n');
  assert.ok(!capabilitiesFor(script, undefined, bin).includes('fireworks-pi-menu-v1'));
  fs.writeFileSync(path.join(bin, 'termag-pi-fireworks'), `#!/bin/sh\n# ${FIREWORKS_PI_LAUNCHER_MARKER}\n`);
  // The installed pi-model predates it.
  fs.writeFileSync(path.join(bin, 'termag-credentials'), '#!/bin/sh\nexit 0\n');
  assert.ok(!capabilitiesFor(script, undefined, bin).includes('fireworks-pi-menu-v1'));
  // A launcher that takes it, with an older pi-model that refuses it.
  stubScript(bin, `# ${FIREWORKS_PI_MENU_MARKER}`);
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
  assert.ok(!capabilitiesFor(script, undefined, bin).includes('fireworks-pi-menu-v1'));
  // The real scripts carry both.
  assert.ok(capabilitiesFor(undefined, undefined, path.join(__dirname, '..', 'deploy')).includes('fireworks-pi-menu-v1'));
});

// Bugbot on #1118: a host without ~/.local/bin copies runs the launch from
// whatever its PATH finds, so that copy is the one that counts.
test('reads the copy a launch would run: the first one on the search path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const localBin = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-bin-'));
  const onPath = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-path-'));
  const script = stubScript(dir, `# ${FIREWORKS_MENU_MARKER}`);
  // Nothing in ~/.local/bin; the PATH's copy carries the marker.
  stubScript(onPath, `# ${FIREWORKS_MENU_MARKER}`);
  assert.ok(capabilitiesFor(script, undefined, [localBin, onPath]).includes('fireworks-menu-v1'));
  // An older copy earlier on the path is the one the shell would run.
  stubScript(localBin, 'exit 0');
  assert.ok(!capabilitiesFor(script, undefined, [localBin, onPath]).includes('fireworks-menu-v1'));
  // None anywhere: the launch could not run termag-credentials at all.
  assert.ok(!capabilitiesFor(script, undefined, [path.join(localBin, 'none')]).includes('fireworks-menu-v1'));
});

test('searches ~/.local/bin first, then the agent\'s PATH', () => {
  const dirs = installedDirs({ HOME: '/home/ada', PATH: '/usr/local/bin:/home/ada/src/termag/deploy::/usr/bin' }, '/home/ada');
  assert.deepStrictEqual(dirs, ['/home/ada/.local/bin', '/usr/local/bin', '/home/ada/src/termag/deploy', '/usr/bin']);
});

test('the script is told where the agent config is, not given the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `cat >/dev/null; printf '%s' "$TERMAG_AGENT_CONFIG" > "${dir}/cfg"`);
  configure({ agentConfig: '/home/u/src/termag/agent/agent.config.json' });
  await applyCredential('github', { broker: 'https://b' }, script);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cfg'), 'utf8'), '/home/u/src/termag/agent/agent.config.json');
});

test('apply passes the payload on stdin, never on argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `printf '%s\\n' "$*" > "${dir}/argv"; cat > "${dir}/stdin"`);
  await applyCredential('github', { token: SENTINEL }, script);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'argv'), 'utf8'), 'apply github\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { token: SENTINEL });
});

test('a failing script surfaces its last stderr line, not the payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, 'cat >/dev/null; echo "termag-credentials: github payload is missing fields" >&2; exit 3');
  await assert.rejects(applyCredential('github', { token: SENTINEL }, script), (err) => {
    assert.match(err.message, /exited 3: termag-credentials: github payload is missing fields/);
    assert.ok(!err.message.includes(SENTINEL));
    return true;
  });
});

test("remove hands the orchestrator's reason to the script on stdin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `cat > "${dir}/stdin"`);
  await removeCredential('github', script, 'GitHub is not connected');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { reason: 'GitHub is not connected' });
});

test('advertises bazel-cache-v2, never the option-A drafts\' -v1, and takes the bazel-cache provider', () => {
  const { PROVIDERS } = require('./credentials');
  assert.ok(CAPABILITIES.includes('bazel-cache-v2'));
  assert.ok(!CAPABILITIES.includes('bazel-cache-v1'));
  assert.ok(PROVIDERS.includes('bazel-cache'));
  // The real script has the provider the capability promises.
  const real = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'termag-credentials'), 'utf8');
  assert.match(real, /'apply bazel-cache'\)/);
  assert.match(real, /'remove bazel-cache'\)/);
});

test('a bazel-cache apply passes the payload through like any provider\'s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `echo "$@" > "${dir}/argv"; cat > "${dir}/stdin"`);
  const payload = { seq: 1730646000123, url: 'https://termag-bazel-cache-1-us-east-2-an.s3.us-east-2.amazonaws.com/g/2026w45', flushGeneration: 0,
    remoteTimeoutSeconds: 5, remoteRetries: 1, jobs: 200, downloadOutputs: 'toplevel', goHostModcache: false };
  await applyCredential('bazel-cache', payload, script);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim(), 'apply bazel-cache');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), payload);
});

test('a bazel-cache remove passes reason, flushGeneration and seq on stdin; other removes only the reason', async () => {
  const { removeExtras } = require('./credentials');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `cat > "${dir}/stdin"`);
  const frame = { type: 'credentials-remove', provider: 'bazel-cache', reason: 'off for you', flushGeneration: 3, seq: 1730646000999, extra: 'x' };
  await removeCredential('bazel-cache', script, frame.reason, removeExtras(frame));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { reason: 'off for you', flushGeneration: 3, seq: 1730646000999 });
  // A remove from a backend that sends neither still just removes.
  await removeCredential('bazel-cache', script, 'off', removeExtras({ provider: 'bazel-cache', reason: 'off' }));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { reason: 'off' });
  // Values are passed as they came, for the script to validate.
  assert.deepStrictEqual(removeExtras({ provider: 'bazel-cache', flushGeneration: 'x', seq: -1 }), { flushGeneration: 'x', seq: -1 });
  // Another provider's frame never grows the fields.
  assert.deepStrictEqual(removeExtras({ provider: 'github', flushGeneration: 3, seq: 1 }), {});
  await removeCredential('github', script, 'gone', removeExtras({ provider: 'github', flushGeneration: 3 }));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { reason: 'gone' });
});

test('unknown providers never reach the script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `touch "${dir}/ran"`);
  await assert.rejects(applyCredential('../../bin/sh', {}, script), /unknown credential provider/);
  await assert.rejects(removeCredential('codex', script), /unknown credential provider/);
  assert.ok(!fs.existsSync(path.join(dir, 'ran')));
});
