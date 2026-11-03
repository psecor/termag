'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { childEnv, closingEvents, reportedExit, createLiveTracker, createMcpReloader, interruptLine, isMcpReloadReply, mcpReloadLine, pendingInbox, pendingInterrupts, runLive, sawResult, sessionIdFrom, userLine } = require('./chat-turn');

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

test('closing: a stopped pi turn ends as SIGINT, as a stopped Claude turn does, not with the SIGTERM it was stopped by', () => {
  for (const exit of [{ code: 143, signal: null }, { code: null, signal: 'SIGTERM' }, { code: null, signal: 'SIGKILL' }]) {
    assert.deepEqual(
      closingEvents({ ...exit, result: false, interrupted: true, engine: 'pi' }),
      [{ type: 'turn-end', exitCode: null, signal: 'SIGINT' }],
    );
    assert.deepEqual(reportedExit({ ...exit, interrupted: true, engine: 'pi' }), { code: null, signal: 'SIGINT' });
  }
  // pi's own clean exit before the stop landed is kept.
  assert.deepEqual(reportedExit({ code: 0, signal: null, interrupted: true, engine: 'pi' }), { code: 0, signal: null });
  // A pi turn that was not stopped keeps what it exited with, and says why.
  const died = closingEvents({ code: null, signal: 'SIGTERM', result: false, engine: 'pi' });
  assert.deepEqual(died.map(e => e.type), ['runner-error', 'turn-end']);
  assert.equal(died[1].signal, 'SIGTERM');
  // A Claude turn is reported as it exited.
  assert.deepEqual(reportedExit({ code: 0, signal: null, interrupted: true }), { code: 0, signal: null });
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
  const turn = childEnv({ HOME: '/h' }, '/p', null, { TERMAG_PROJECT_ID: 'proj1', TERMAG_WORKSTREAM: 'main', LD_PRELOAD: '/evil.so' });
  assert.equal(turn.TERMAG_PROJECT_ID, 'proj1');
  assert.equal(turn.TERMAG_WORKSTREAM, 'main');
  assert.equal(turn.LD_PRELOAD, undefined);
  // The turn's kind replaces one the agent's own environment carried.
  assert.equal(childEnv({ TERMAG_SESSION_KIND: 'interactive' }, '/p', null, { TERMAG_SESSION_KIND: 'chat' }).TERMAG_SESSION_KIND, 'chat');
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
  assert.equal(lines[0].live, false);
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

test('a hangup while a finished pi turn drains its stdout keeps pi\'s own exit, and stops what pi left behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-pi-drain-'));
  const bin = path.join(dir, 'pi');
  const left = path.join(dir, 'left.pid');
  // pi answers and exits 0, leaving a process that holds its stdout open.
  fs.writeFileSync(bin, `#!/bin/sh
cat ${JSON.stringify(path.join(__dirname, 'fixtures/pi/success.jsonl'))}
sleep 30 &
echo $! > ${JSON.stringify(left)}
exit 0
`, { mode: 0o755 });
  turnMeta(dir, bin);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, engine: 'pi' }));
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore' });
  const exited = new Promise(resolve => wrapper.once('exit', resolve));
  for (let i = 0; i < 100 && !fs.existsSync(left); i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 200)); // pi has exited; the wrapper is draining
  assert.ok(!fs.existsSync(path.join(dir, 'exit')), 'still draining');
  // chat-clear (signalStop) marks the turn interrupted and kills the session.
  fs.writeFileSync(path.join(dir, 'interrupted'), '');
  wrapper.kill('SIGHUP');
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'exit'), 'utf8')), { code: 0, signal: null });
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.type === 'result').length, 1);
  assert.deepEqual(events.at(-1), { type: 'turn-end', exitCode: 0, signal: null });
  const pid = Number(fs.readFileSync(left, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 20)); } catch { alive = false; } }
  assert.equal(alive, false, 'the leftover process was stopped');
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

test('live tracker: idle once the last message is answered and no background task is left', () => {
  const t = createLiveTracker({ graceMs: 0 });
  assert.equal(t.idle(), false);
  t.feed('{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1"}]}\n{"type":"res');
  t.feed('ult"}\n');
  assert.equal(t.idle(), false, 'a background task is still running');
  t.feed('{"type":"system","subtype":"background_tasks_changed","tasks":[]}\n');
  assert.equal(t.idle(), true);
  t.delivered();
  assert.equal(t.idle(), false, 'a message went in after that answer');
  t.feed('not json\n{"type":"result"}\n');
  assert.equal(t.idle(), true);
});

test('live tracker: idle only once Claude has looked done for the grace period', () => {
  let clock = 0;
  const t = createLiveTracker({ now: () => clock, graceMs: 1500 });
  t.feed('{"type":"result"}\n');
  assert.equal(t.idle(), false, 'just answered');
  clock = 1499;
  assert.equal(t.idle(), false);
  clock = 1500;
  assert.equal(t.idle(), true);
  t.feed('{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1"}]}\n');
  assert.equal(t.idle(), false);
  t.feed('{"type":"system","subtype":"background_tasks_changed","tasks":[]}\n');
  clock = 2000;
  assert.equal(t.idle(), false, 'the grace starts over');
  clock = 3500;
  assert.equal(t.idle(), true);
});

test('live tracker: a turn Claude starts after its answer is work until its own result', () => {
  let clock = 0;
  const t = createLiveTracker({ now: () => clock, graceMs: 0 });
  for (const line of ['{"type":"system","subtype":"init"}', '{"type":"assistant"}', '{"type":"stream_event"}']) {
    t.feed('{"type":"result"}\n');
    assert.equal(t.idle(), true);
    t.feed(`${line}\n`);
    assert.equal(t.idle(), false, line);
  }
  t.feed('{"type":"result"}\n');
  assert.equal(t.idle(), true);
});

test('live tracker: a task notification after the answer holds idle off for the turn it wakes, but not forever', () => {
  let clock = 0;
  const t = createLiveTracker({ now: () => clock, graceMs: 0, wakeMs: 30000 });
  t.feed('{"type":"result"}\n{"type":"system","subtype":"background_tasks_changed","tasks":[]}\n{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}\n');
  assert.equal(t.idle(), false, 'its turn has not begun yet');
  clock = 29999;
  assert.equal(t.idle(), false);
  // A killed task's notification wakes no turn.
  clock = 30000;
  assert.equal(t.idle(), true);
  // Claude Code's own order: the notification, then the task list empties, then the woken turn's init.
  t.feed('{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b3"}]}\n{"type":"result"}\n');
  t.feed('{"type":"system","subtype":"task_notification","task_id":"b3","status":"completed"}\n{"type":"system","subtype":"background_tasks_changed","tasks":[]}\n');
  clock = 31000;
  assert.equal(t.idle(), false, 'the task list is empty, but its notification has not been read yet');
  t.feed('{"type":"system","subtype":"init"}\n{"type":"result"}\n');
  assert.equal(t.idle(), true);
  // One that came before Claude's answer was read in that turn.
  t.feed('{"type":"system","subtype":"task_notification","task_id":"b2","status":"completed"}\n{"type":"result"}\n');
  assert.equal(t.idle(), true);
});

test('inbox: waiting messages oldest first, delivered and partial files left out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-inbox-'));
  for (const n of ['000010.json', '000002.json', '000001.sent', '000003.json.tmp']) fs.writeFileSync(path.join(dir, n), '{}');
  assert.deepEqual(pendingInbox(dir), ['000002.json', '000010.json']);
  assert.deepEqual(pendingInbox(path.join(dir, 'missing')), []);
  assert.deepEqual(JSON.parse(userLine('hi')), { type: 'user', message: { role: 'user', content: 'hi' } });
});

// A stand-in for claude -p in stream-json input mode: each message is replayed,
// then answered with a result; "bg" holds a background task for a moment first;
// "wake" answers, and its task's notification (after the task is gone) starts a turn with another task;
// "work" starts a background task and a slow foreground answer that an interrupt control request cuts short.
// It exits when stdin ends and no task is left, as Claude does.
const LIVE_CLAUDE = `#!/usr/bin/env node
const out = ev => process.stdout.write(JSON.stringify(ev) + '\\n');
let tasks = 0, ended = false, carry = '', working = null;
const maybeExit = () => { if (ended && tasks === 0) process.exit(0); };
out({ type: 'system', subtype: 'init', session_id: 'sess-live-0000' });
process.stdin.on('data', d => {
  const lines = (carry + d).split('\\n'); carry = lines.pop();
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      if (msg.request.subtype === 'interrupt' && working) { clearTimeout(working); working = null; out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted' }); }
      continue;
    }
    const text = msg.message.content;
    out({ type: 'user', message: { role: 'user', content: text }, isReplay: true });
    if (text === 'work') {
      tasks++; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] });
      setTimeout(() => { tasks--; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'result', result: 'bg done' }); maybeExit(); }, 1500);
      working = setTimeout(() => { working = null; out({ type: 'result', result: 'got: work' }); }, 4000);
      continue;
    }
    if (text === 'wake') {
      tasks++; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] });
      setTimeout(() => {
        tasks--; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        setTimeout(() => {
          out({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
          out({ type: 'system', subtype: 'init', session_id: 'sess-live-0000' });
          tasks++; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b2' }] });
          out({ type: 'result', result: 'woke' });
          setTimeout(() => { tasks--; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'result', result: 'b2 done' }); maybeExit(); }, 1500);
        }, 400);
      }, 300);
    }
    if (text === 'bg') {
      tasks++; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] });
      setTimeout(() => { tasks--; out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'result', result: 'bg done' }); maybeExit(); }, 1500);
    }
    out({ type: 'result', result: 'got: ' + text });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
`;

function liveTurn(prefix, text, { bin: fakeBin, args = [], env } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = fakeBin ?? path.join(dir, 'claude');
  if (!fakeBin) fs.writeFileSync(bin, LIVE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), text);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args, cwd: dir, path: process.env.PATH, text, live: true, stateFile: path.join(dir, 'state.json') }));
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore', env: { ...process.env, HOME: dir, ...env } });
  const exited = new Promise(resolve => wrapper.once('exit', resolve));
  const events = () => { try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  const until = async (pred, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (pred(events())) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`timed out; log: ${JSON.stringify(events().map(e => e.result || e.type))}`);
  };
  return { dir, events, until, exited };
}

test('a live turn: a message sent while a background task runs is answered in the same turn, which ends when Claude is idle', async () => {
  const { dir, events, until, exited } = liveTurn('chat-turn-live-', 'bg');
  await until(ev => ev.some(e => e.result === 'got: bg'));
  fs.mkdirSync(path.join(dir, 'inbox'));
  fs.writeFileSync(path.join(dir, 'inbox/000001.json'), JSON.stringify({ text: 'are you there?' }));
  await until(ev => ev.some(e => e.result === 'got: are you there?'));
  assert.ok(!events().some(e => e.result === 'bg done'), 'answered while the task still ran');
  assert.ok(!fs.existsSync(path.join(dir, 'exit')));
  assert.equal(await exited, 0);
  const ev = events();
  assert.deepEqual(ev.filter(e => e.type === 'user').map(e => e.message.content), ['bg', 'are you there?']);
  assert.deepEqual(ev.slice(-2).map(e => e.result || e.type), ['bg done', 'turn-end']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), ['000001.sent']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessionId, 'sess-live-0000');
});

test('a live turn whose finished task wakes Claude after its answer still takes messages, and ends when that turn is done', async () => {
  const { dir, events, until, exited } = liveTurn('chat-turn-live-wake-', 'wake');
  await until(ev => ev.some(e => e.result === 'woke'));
  assert.ok(!fs.existsSync(path.join(dir, 'stdin-ended')));
  fs.mkdirSync(path.join(dir, 'inbox'));
  fs.writeFileSync(path.join(dir, 'inbox/000001.json'), JSON.stringify({ text: 'still there?' }));
  await until(ev => ev.some(e => e.result === 'got: still there?'));
  assert.equal(await exited, 0);
  assert.deepEqual(events().filter(e => e.type === 'result').map(e => e.result), ['got: wake', 'woke', 'got: still there?', 'b2 done']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), ['000001.sent']);
  assert.ok(fs.existsSync(path.join(dir, 'stdin-ended')));
});

test('a live turn with nothing left to do ends after its answer', async () => {
  const { dir, events, exited } = liveTurn('chat-turn-live-idle-', 'hello');
  const t0 = Date.now();
  assert.equal(await exited, 0);
  assert.ok(Date.now() - t0 < 4000, 'stdin closed once Claude answered, after the grace');
  assert.ok(fs.existsSync(path.join(dir, 'stdin-ended')));
  assert.deepEqual(events().map(e => e.result || e.type), ['turn-start', 'system', 'user', 'got: hello', 'turn-end']);
  assert.equal(events()[0].live, true, 'its turn-start says the turn reads messages');
});

test('interrupt requests: oldest first, and the control line Claude takes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-inbox-int-'));
  for (const n of ['interrupt-20.json', 'interrupt-3.json', 'interrupt-1.sent', '000001.json', 'interrupt-4.json.tmp']) fs.writeFileSync(path.join(dir, n), '{}');
  assert.deepEqual(pendingInterrupts(dir), ['interrupt-3.json', 'interrupt-20.json']);
  assert.deepEqual(pendingInbox(dir), ['000001.json'], 'an interrupt is not a message');
  assert.deepEqual(JSON.parse(interruptLine(2)), { type: 'control_request', request_id: 'termag-interrupt-2', request: { subtype: 'interrupt' } });
});

test('a live turn: an interrupt stops Claude\'s current work, the turn stays open for its background task, then ends', async () => {
  const { dir, events, until, exited } = liveTurn('chat-turn-live-int-', 'work');
  await until(ev => ev.some(e => e.type === 'system' && e.subtype === 'background_tasks_changed'));
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbox/interrupt-1.json'), '{}');
  await until(ev => ev.some(e => e.result === 'interrupted'));
  assert.ok(!fs.existsSync(path.join(dir, 'exit')), 'the background task keeps the turn open');
  assert.equal(await exited, 0);
  const results = events().filter(e => e.type === 'result').map(e => e.result);
  assert.deepEqual(results, ['interrupted', 'bg done'], 'the slow answer never came; the background task finished');
  assert.equal(events().at(-1).type, 'turn-end');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), ['interrupt-1.sent']);
});

test('the e2e fake Claude takes an interrupt as Claude Code does: the work stops, the background tasks finish', async () => {
  const fake = path.join(__dirname, '../scripts/e2e/fakes/claude-stream.mjs');
  const { dir, events, until, exited } = liveTurn('chat-turn-fake-int-', 'long background', {
    bin: process.execPath,
    args: [fake, '--input-format', 'stream-json', '--permission-mode', 'bypassPermissions'],
    env: { E2E_STUB_DELAY_MS: '5', E2E_BACKGROUND_MS: '800' },
  });
  await until(ev => ev.some(e => e.subtype === 'background_tasks_changed' && e.tasks.length === 1));
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'inbox/interrupt-1.json'), '{}');
  await until(ev => ev.some(e => e.type === 'result'));
  assert.equal(await exited, 0);
  const ev = events();
  assert.ok(ev.some(e => e.type === 'control_response' && e.response.request_id === 'termag-interrupt-1'));
  assert.deepEqual(ev.filter(e => e.type === 'result').map(e => e.subtype), ['error_during_execution', 'success']);
  assert.ok(ev.some(e => e.type === 'user' && e.message.content[0]?.text === '[Request interrupted by user for tool use]'));
  assert.ok(!ev.some(e => e.type === 'assistant' && e.message.content[0]?.text?.startsWith('Here\'s what I found')), 'the answer never came');
  assert.deepEqual(ev.filter(e => e.subtype === 'background_tasks_changed').at(-1).tasks, []);
  assert.equal(ev.at(-1).type, 'turn-end');
});

test('mcp reloader: a version change reloads once it holds still, and only once', () => {
  let version = '1';
  let clock = 0;
  const r = createMcpReloader(() => version, () => clock, 3000);
  assert.equal(r.check(), false, 'the version the turn started with is no change');
  version = '2';
  assert.equal(r.check(), false, 'just changed');
  clock = 2999;
  assert.equal(r.check(), false, 'not settled yet');
  clock = 3000;
  assert.equal(r.check(), true);
  clock = 9000;
  assert.equal(r.check(), false, 'one reload per change');
  version = '3';
  r.check();
  clock = 10000;
  version = '4';
  assert.equal(r.check(), false, 'a burst keeps waiting');
  clock = 13000;
  assert.equal(r.check(), true, 'and reloads once');
  version = '5';
  r.check();
  version = '4';
  r.check();
  clock = 20000;
  assert.equal(r.check(), false, 'a change that went back is none');
});

test('mcp reloader: a version file that appears after the turn started reloads', () => {
  let version = '';
  let clock = 0;
  const r = createMcpReloader(() => version, () => clock, 3000);
  version = '7';
  r.check();
  clock = 3000;
  assert.equal(r.check(), true);
});

test('mcp reload: the control line Claude takes, and its answer is told apart from an interrupt\'s', () => {
  assert.deepEqual(JSON.parse(mcpReloadLine(3)), { type: 'control_request', request_id: 'termag-mcp-reload-3', request: { subtype: 'reload_plugins' } });
  assert.equal(isMcpReloadReply({ type: 'control_response', response: { subtype: 'success', request_id: 'termag-mcp-reload-3', response: { commands: [] } } }), true);
  assert.equal(isMcpReloadReply({ type: 'control_response', response: { subtype: 'success', request_id: 'termag-interrupt-1' } }), false);
  assert.equal(isMcpReloadReply({ type: 'result' }), false);
  assert.equal(isMcpReloadReply(null), false);
});

function fakeLiveChild() {
  const child = new EventEmitter();
  const writes = [];
  const stdin = { ended: false };
  child.stdin = { on() {}, write(line) { writes.push(JSON.parse(line)); }, end() { stdin.ended = true; } };
  return { child, writes, stdin };
}

const tickMs = () => new Promise(r => setTimeout(r, 300));

// The incident: Claude answers with one background task open; the task ends
// (tasks: []) and only then does its task_notification wake Claude into a turn
// of its own, which starts more background tasks and runs on. Closing stdin at
// tasks: [] left that turn deaf to every message sent after it.
test('a live turn keeps stdin open and the inbox read when a task notification wakes Claude after its answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-wake-'));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'hi');
  const events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(events, '');
  const log = (...evs) => fs.appendFileSync(events, evs.map(e => `${JSON.stringify(e)}\n`).join(''));
  const bg = ids => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(task_id => ({ task_id })) });
  let clock = 0;
  const { child, writes, stdin } = fakeLiveChild();
  runLive(dir, child, events, 0, { now: () => clock });
  try {
    log({ type: 'system', subtype: 'init' }, { type: 'assistant' }, bg(['b8z2bbxcj']), { type: 'result', result: 'answer 24' });
    await tickMs();
    log(bg([]));
    await tickMs();
    clock += 200;
    await tickMs();
    assert.equal(stdin.ended, false, 'Claude has only just looked done');
    log({ type: 'system', subtype: 'task_notification', task_id: 'b8z2bbxcj', status: 'completed' }, { type: 'system', subtype: 'init' });
    log({ type: 'assistant' }, bg(['t1', 't2', 't3', 't4', 't5', 't6']));
    await tickMs();
    clock += 60000;
    await tickMs();
    assert.equal(stdin.ended, false);
    fs.mkdirSync(path.join(dir, 'inbox'));
    fs.writeFileSync(path.join(dir, 'inbox/000025.json'), JSON.stringify({ text: "let's mark 748 ready" }));
    await tickMs();
    assert.deepEqual(writes.map(w => w.message.content), ['hi', "let's mark 748 ready"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox')), ['000025.sent']);
    assert.ok(!fs.existsSync(path.join(dir, 'stdin-ended')));
    log({ type: 'result', result: 'answer 25' }, bg([]), { type: 'result', result: 'woken turn done' });
    await tickMs();
    clock += 1500;
    await tickMs();
    assert.equal(stdin.ended, true, 'done once Claude is done');
    assert.ok(fs.existsSync(path.join(dir, 'stdin-ended')), 'and the agent is told it takes no more messages');
  } finally { child.emit('exit', 0, null); }
});

test('a live turn that loads MCP servers sends reload_plugins on stdin once the version file changes and settles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-mcp-'));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'hi');
  const events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(events, '');
  const versionFile = path.join(dir, 'mcp-connectors.version');
  fs.writeFileSync(versionFile, '1\n');
  let clock = 0;
  const { child, writes } = fakeLiveChild();
  runLive(dir, child, events, 0, { mcpVersionFile: versionFile, now: () => clock });
  try {
    await tickMs();
    assert.deepEqual(writes.map(w => w.type), ['user'], 'the message, no reload for the version it started with');
    fs.writeFileSync(versionFile, '2\n');
    await tickMs();
    clock += 3000;
    await tickMs();
    assert.deepEqual(writes.slice(1), [{ type: 'control_request', request_id: 'termag-mcp-reload-1', request: { subtype: 'reload_plugins' } }]);
    await tickMs();
    assert.equal(writes.length, 2, 'once');
  } finally { child.emit('exit', 0, null); }
});

test('a live turn without an MCP version file never reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-nomcp-'));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'hi');
  const events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(events, '');
  const { child, writes } = fakeLiveChild();
  runLive(dir, child, events, 0);
  try {
    await tickMs();
    assert.deepEqual(writes.map(w => w.type), ['user']);
  } finally { child.emit('exit', 0, null); }
});

test('turn-start: a compact turn says so, and any other says nothing', () => {
  const { turnStartEvent } = require('./chat-turn');
  assert.equal(turnStartEvent({ text: '/compact', resumed: true, compact: true }).compact, true);
  assert.equal('compact' in turnStartEvent({ text: 'hi' }), false);
  // Whether the runner asks Haiku for this turn's tool-group headings: the browser waits for one only then.
  assert.equal(turnStartEvent({ text: 'hi', headings: true }).headings, true);
  assert.equal('headings' in turnStartEvent({ text: 'hi' }), false);
  assert.equal('headings' in turnStartEvent({ text: 'hi', headings: true, ask: { runId: 'r' } }), false, 'an ask\'s turn is never headed');
});
