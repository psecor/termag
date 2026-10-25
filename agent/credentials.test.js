const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyCredential, removeCredential, CAPABILITIES, configure,
} = require('./credentials');

const SENTINEL = 'sentinel-token-7f3e';

function stubScript(dir, body) {
  const script = path.join(dir, 'termag-credentials');
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return script;
}

test('advertises credentials-v1, the GitHub broker, telemetry and its launch settings', () => {
  assert.deepStrictEqual(CAPABILITIES, ['credentials-v1', 'github-broker-v1', 'telemetry-v1', 'telemetry-replay-v1', 'agent-telemetry-v1', 'mcp-broker-v1', 'fireworks-v1']);
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

test('unknown providers never reach the script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-cred-'));
  const script = stubScript(dir, `touch "${dir}/ran"`);
  await assert.rejects(applyCredential('../../bin/sh', {}, script), /unknown credential provider/);
  await assert.rejects(removeCredential('codex', script), /unknown credential provider/);
  assert.ok(!fs.existsSync(path.join(dir, 'ran')));
});
