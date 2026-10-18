'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { childEnv, closingEvents, sawResult, sessionIdFrom } = require('./chat-turn');

test('closing: a failure without a result says why, every turn ends with turn-end', () => {
  assert.deepEqual(closingEvents({ code: 0, signal: null, result: true }), [{ type: 'turn-end', exitCode: 0, signal: null }]);
  const failed = closingEvents({ code: 1, signal: null, result: false, stderrTail: 'boot\nError: not logged in\n' });
  assert.deepEqual(failed.map(e => e.type), ['runner-error', 'turn-end']);
  assert.match(failed[0].message, /exited 1: Error: not logged in/);
  assert.match(closingEvents({ code: null, signal: 'SIGINT', result: false })[0].message, /exited SIGINT/);
  assert.deepEqual(
    closingEvents({ code: null, signal: 'SIGINT', result: false, interrupted: true }),
    [{ type: 'turn-end', exitCode: null, signal: 'SIGINT' }],
  );
});

test('log reading: the session id from init, and whether a result came', () => {
  const log = '{"type":"turn-start"}\n{"type":"system","subtype":"init","session_id":"sess-1234-abcd"}\n{"type":"result","is_error":false}\n';
  assert.equal(sessionIdFrom(log), 'sess-1234-abcd');
  assert.equal(sawResult(log), true);
  assert.equal(sessionIdFrom('{"type":"system","subtype":"init","session_id":"x;rm"}'), null);
  assert.equal(sawResult('{"type":"assistant"}'), false);
});

test('child env: no tmux variables, the agent\'s PATH', () => {
  const env = childEnv({ TMUX: 's', TMUX_PANE: '%1', PATH: '/tmux/path', HOME: '/h' }, '/agent/path');
  assert.deepEqual(env, { PATH: '/agent/path', HOME: '/h' });
  assert.equal(childEnv({ HOME: '/h' }, '/agent/path', '/h/.termag/chat-config').CLAUDE_CONFIG_DIR, '/h/.termag/chat-config');
});

test('a real turn: prompt on stdin, the log framed, the session id kept, exit written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
read -r prompt
printf '{"type":"system","subtype":"init","session_id":"sess-9999-zzzz"}\\n'
printf '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"got: %s %s"}]}}\\n' "$prompt" "$TMUX"
printf '{"type":"result","is_error":false}\\n'
`, { mode: 0o755 });
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'hello there\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args: ['-p'], cwd: dir, path: process.env.PATH, text: 'hello there', resumed: false, stateFile: state }));
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { env: { ...process.env, TMUX: '/tmp/tmux,1,0' } });
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(e => e.type), ['turn-start', 'system', 'assistant', 'result', 'turn-end']);
  assert.equal(lines[0].text, 'hello there');
  assert.equal(lines[2].message.content[0].text.trim(), 'got: hello there');
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).sessionId, 'sess-9999-zzzz');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'exit'), 'utf8')), { code: 0, signal: null });
});

function turnMeta(dir, bin) {
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args: [], cwd: dir, path: process.env.PATH, text: 'x' }));
}

test('a hangup kills the child and the wrapper exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-hang-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\ntrap "exit 0" TERM\nsleep 30\n', { mode: 0o755 });
  turnMeta(dir, bin);
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore' });
  const pidFile = path.join(dir, 'claude.pid');
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(pidFile));
  wrapper.kill('SIGTERM');
  const code = await new Promise(resolve => wrapper.once('exit', resolve));
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'exit')));
});

test('a hangup escalates to SIGKILL when the child ignores SIGTERM, then the wrapper exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-kill-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\ntrap "" TERM\nsleep 30\n', { mode: 0o755 });
  turnMeta(dir, bin);
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore' });
  const pidFile = path.join(dir, 'claude.pid');
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
  wrapper.kill('SIGHUP');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrapper did not exit after SIGKILL')), 8000);
    wrapper.once('exit', c => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'exit'), 'utf8')).signal, 'SIGKILL');
});

test('a real turn that fails: the reason from stderr, then turn-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Error: not logged in" >&2\nexit 3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args: [], cwd: dir, text: 'x' }));
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir]);
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(e => e.type), ['turn-start', 'runner-error', 'turn-end']);
  assert.match(lines[1].message, /exited 3: Error: not logged in/);
});
