'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  checkoutReady, completeLines, createChatRunner, entriesBeforeTurn, findTranscript, historyEntries, isChatKey,
  parseEvent, prepareChatConfigDir, readTail, rehomeTranscript, resolveClaude, slugForCwd, splitLines, turnArgs,
  turnEnv, turnSessionName,
} = require('./chat-runner');

test('turn argv: headless stream-json with partial messages in dontAsk, never bypass; resume once there is a session', () => {
  const first = turnArgs(null);
  assert.deepEqual(first.slice(0, 1), ['-p']);
  for (const want of ['stream-json', '--include-partial-messages', '--verbose']) assert.ok(first.includes(want), want);
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!first.join(' ').includes('bypassPermissions'));
  assert.ok(!first.includes('--resume'));
  assert.deepEqual(turnArgs('abc-12345678').slice(-2), ['--resume', 'abc-12345678']);
});

test('turn argv: read-only built-ins only, no MCP server, no hooks, no project or local settings', () => {
  const args = turnArgs('abc-12345678');
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--tools'), 'Read,Grep,Glob');
  for (const tool of ['Bash', 'Edit', 'Write', 'Skill', 'WebFetch', 'Task']) assert.ok(!value('--tools').split(',').includes(tool), tool);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(value('--settings')), { disableAllHooks: true });
  // Only the box user's settings (termag's gateway helper): the checkout's
  // .claude/settings*.json would run its apiKeyHelper and apply its env.
  assert.equal(value('--setting-sources'), 'user');
  assert.equal(args.filter(a => a === '--setting-sources').length, 1);
  // Every flag that takes a value has one, and the session comes last.
  for (const flag of ['--permission-mode', '--tools', '--mcp-config', '--setting-sources', '--settings']) assert.ok(!value(flag).startsWith('--'), flag);
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-12345678']);
});

test('runner: a request for bypass (or any mode but dontAsk) is refused and starts nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const b = box(home);
  const runner = createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', send: () => true,
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
  });
  await assert.rejects(runner.sendMessage({ chatKey: 'k', cwd: '/w', text: 'x', permissionMode: 'bypassPermissions' }), /only runs dontAsk/);
  await assert.rejects(runner.sendMessage({ chatKey: 'k', cwd: '/w', text: 'x', permissionMode: 'acceptEdits' }), /only runs dontAsk/);
  assert.equal(b.procs.size, 0);
  await runner.sendMessage({ chatKey: 'k', cwd: '/w', text: 'x', permissionMode: 'dontAsk' });
  await runner.sendMessage({ chatKey: 'k2', cwd: '/w', text: 'x' });
  assert.equal(b.procs.size, 2);
  for (const p of b.procs.values()) {
    assert.equal(p.meta.args[p.meta.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(p.meta.args[p.meta.args.indexOf('--setting-sources') + 1], 'user');
    assert.equal(p.meta.configDir, path.join(home, '.termag/chat-config'));
  }
});

test('lines: complete lines out, the unfinished tail carried', () => {
  const a = splitLines('', '{"type":"a"}\n{"type":"b"');
  assert.deepEqual(a.lines, ['{"type":"a"}']);
  const b = splitLines(a.rest, '}\n\n');
  assert.deepEqual(b.lines, ['{"type":"b"}']);
  assert.equal(b.rest, '');
});

test('events: JSON objects with a type, nothing else', () => {
  assert.deepEqual(parseEvent('{"type":"result","is_error":false}'), { type: 'result', is_error: false });
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent('[1,2]'), null);
  assert.equal(parseEvent('{"no":"type"}'), null);
});

test('chat keys: a flat file name, never a path', () => {
  assert.ok(isChatKey('cmva5ktbm000cjuwdffqdnfnm--main'));
  assert.ok(!isChatKey('../x'));
  assert.ok(!isChatKey('a/b'));
  assert.ok(!isChatKey(''));
});

test('claude binary: native install, then PATH, then the newest nvm global', () => {
  const have = new Set(['/h/.nvm/versions/node/v20.1.0/bin/claude', '/h/.nvm/versions/node/v22.3.0/bin/claude']);
  const exists = p => have.has(p);
  const readdir = () => ['v20.1.0', 'v22.3.0'];
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/h/.nvm/versions/node/v22.3.0/bin/claude');
  have.add('/usr/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/usr/bin/claude');
  have.add('/h/.local/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { PATH: '/usr/bin' }, exists, readdir }), '/h/.local/bin/claude');
  assert.equal(resolveClaude({ home: '/h', env: { TERMAG_CHAT_CLAUDE: '/x/claude' }, exists, readdir }), '/x/claude');
});

test('turn env: no tmux variables, the binary\'s directory on PATH', () => {
  const env = turnEnv({ TMUX: '/tmp/s,1,0', TMUX_PANE: '%1', PATH: '/usr/bin', HOME: '/h' }, '/h/.nvm/versions/node/v22/bin/claude');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.PATH, '/h/.nvm/versions/node/v22/bin:/usr/bin');
  assert.equal(turnEnv({ PATH: '/usr/bin' }, 'claude').PATH, '/usr/bin');
});

test('history: main-thread user and assistant messages from the transcript, meta and sidechains left out', () => {
  const jsonl = [
    { type: 'summary', summary: 'x' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    { type: 'assistant', isSidechain: true, message: { id: 'msg_2', role: 'assistant', content: [] } },
    'not json',
  ].map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  const out = historyEntries(jsonl);
  assert.deepEqual(out.map(e => e.uuid), ['u1', 'a1']);
  assert.deepEqual(out[1].message, { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] });
  assert.equal(historyEntries(jsonl, 1).length, 1);
});

test('transcript: found under any project dir by session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runner-'));
  const dir = path.join(home, '.claude/projects/-home-u-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-12345678.jsonl'), '');
  assert.equal(findTranscript(home, 'sess-12345678'), path.join(dir, 'sess-12345678.jsonl'));
  assert.equal(findTranscript(home, 'missing-1234'), null);
  assert.equal(findTranscript(home, '../etc'), null);
});

test('checkout: ready once HEAD is a commit', async () => {
  const calls = [];
  const ok = (cmd, args) => { calls.push([cmd, ...args]); return Promise.resolve({ stdout: 'abc\n' }); };
  assert.equal(await checkoutReady('/w/p', ok), true);
  assert.deepEqual(calls[0].slice(0, 4), ['git', '-C', '/w/p', 'rev-parse']);
  const none = () => Promise.reject(Object.assign(new Error('fatal: Needed a single revision'), { code: 1 }));
  assert.equal(await checkoutReady('/w/p', none), false);
});

test('checkout: a real fresh repo has none until its first commit', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-checkout-'));
  await run('git', ['init', '-q', dir]);
  assert.equal(await checkoutReady(dir, run), false);
  fs.writeFileSync(path.join(dir, 'a'), 'x');
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first']);
  assert.equal(await checkoutReady(dir, run), true);
});

test('tail: the end of a file from its first whole line, and the descriptor closed even when the read fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tail-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'line one\nline two\nline three\n');
  assert.equal(readTail(file, 1000), 'line one\nline two\nline three\n');
  assert.equal(readTail(file, 15), 'line three\n');
  assert.equal(readTail(path.join(dir, 'missing'), 100), '');

  const closed = [];
  const failing = {
    statSync: () => ({ size: 10 }),
    openSync: () => 42,
    readSync: () => { throw new Error('EIO'); },
    closeSync: fd => closed.push(fd),
  };
  assert.equal(readTail('/x', 100, failing), '');
  assert.deepEqual(closed, [42]);
});

test('slugForCwd: every non-alphanumeric becomes a dash, matching Claude Code', () => {
  assert.equal(slugForCwd('/home/u/termag/projects/my-proj'), '-home-u-termag-projects-my-proj');
  assert.equal(slugForCwd('/tmp/a.b_c'), '-tmp-a-b-c');
});

test('turnEnv: the chat turn runs with the scratch config dir, and without the tmux vars', () => {
  const env = turnEnv({ TMUX: '/x', TMUX_PANE: '%1', PATH: '/usr/bin' }, '/opt/node/bin/claude', '/home/u/.termag/chat-config');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/u/.termag/chat-config');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.ok(env.PATH.startsWith('/opt/node/bin:'));
});

test('prepareChatConfigDir: only the gateway credential, with projects and credentials symlinked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    apiKeyHelper: 'termag-claude-token /c', env: { ANTHROPIC_BASE_URL: 'http://gw' },
    permissions: { allow: ['Read(//**)'] }, model: 'x',
  }));
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{"t":1}');
  const dir = prepareChatConfigDir(home);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { apiKeyHelper: 'termag-claude-token /c', env: { ANTHROPIC_BASE_URL: 'http://gw' } });
  assert.equal(settings.permissions, undefined, 'the owner permission rules must not reach the chat turn');
  assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(home, '.claude/projects'));
  assert.equal(fs.readlinkSync(path.join(dir, '.credentials.json')), path.join(home, '.claude/.credentials.json'));
});

test('prepareChatConfigDir: a box with no owner settings still gets a confining empty settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cfg-'));
  const dir = prepareChatConfigDir(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {});
  assert.ok(fs.existsSync(path.join(dir, 'projects')));
});

test('rehomeTranscript: a rename moves the session transcript to the new cwd slug dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rehome-'));
  const id = 'abcdef12-3456-7890-abcd-ef1234567890';
  const oldDir = path.join(home, '.claude/projects', slugForCwd('/home/u/proj'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${id}.jsonl`), '{"type":"user"}\n');
  rehomeTranscript(home, id, '/home/u/renamed');
  const newDir = path.join(home, '.claude/projects', slugForCwd('/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)), 'moved to the new slug dir');
  assert.ok(!fs.existsSync(path.join(oldDir, `${id}.jsonl`)), 'gone from the old one');
  // A no-op when already there.
  assert.doesNotThrow(() => rehomeTranscript(home, id, '/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)));
});


// ── durable turns ──────────────────────────────────────────────────────────

test('turn sessions: named after the user and turn, never a cloud runner session (no box-update deferral)', () => {
  const name = turnSessionName('first.last', 'mva9-ab12');
  assert.equal(name, 'first_dlast-chat-mva9-ab12-r');
  const { isRunnerSessionName } = require('./runner-sessions');
  assert.equal(isRunnerSessionName(name, 'first.last'), false);
  assert.ok(!/-claude-runner-s[0-9]+-[A-Za-z0-9][A-Za-z0-9_-]*-r$/.test(name), 'termag-box-update live_runner_sessions pattern');
});

test('log lines: only complete lines, with the bytes they took', () => {
  assert.deepEqual(completeLines(Buffer.from('{"a":1}\n{"b":')), { lines: ['{"a":1}'], bytes: 8 });
  assert.deepEqual(completeLines(Buffer.from('partial')), { lines: [], bytes: 0 });
});

test('history cut: the running turn\'s prompt and what follows it leave the transcript', () => {
  const entries = [
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'two (partial)' }] } },
  ];
  assert.deepEqual(entriesBeforeTurn(entries, 'second').length, 2);
  assert.deepEqual(entriesBeforeTurn(entries, 'not written yet').length, 4);
});

// A box: turns "run" by a test-controlled stand-in for chat-turn.js that
// writes the log lines the test hands it; tmux sessions are a Set.
function box(home) {
  const sessions = new Set();
  const signals = [];
  const procs = new Map();
  return {
    sessions, signals, procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text, resumed: meta.resumed })}\n`);
      fs.writeFileSync(path.join(dir, 'claude.pid'), '4242');
      procs.set(meta.turnId, { meta, dir });
    },
    write: (turnId, events) => {
      const { dir } = procs.get(turnId);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), events.map(e => `${JSON.stringify(e)}\n`).join(''));
    },
    finish: (turnId, sessionId) => {
      const { meta, dir } = procs.get(turnId);
      if (sessionId) fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd }));
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: 0 })}\n`);
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    crash: (turnId) => { sessions.delete(procs.get(turnId).meta.session); },
    sessionAlive: async (name) => sessions.has(name),
    signalPid: (pid, sig) => signals.push([pid, sig]),
  };
}

function runner(home, b, frames, opts = {}) {
  return createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin', TMUX: 'x' },
    send: f => { if (opts.down?.()) return false; frames.push(f); return true; },
    isOpen: () => !opts.down?.(),
    startProcess: b.startProcess, sessionAlive: opts.sessionAlive || b.sessionAlive, signalPid: b.signalPid,
    stopSession: opts.stopSession, pidAlive: opts.pidAlive, interruptGraceMs: opts.interruptGraceMs,
    now: opts.now,
  });
}

const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', ...extra });

test('durable: a turn runs in its own tmux session; its log goes out numbered, and a queued message starts after it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const { turnId } = await r.sendMessage(job('hello'));
  assert.ok(b.sessions.has(`alice-chat-${turnId}-r`));
  const started = b.procs.get(turnId);
  assert.equal(started.meta.args[started.meta.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(started.meta.path, '/bin:/usr/bin');
  assert.equal(started.meta.configDir, path.join(home, '.termag/chat-config'));
  assert.deepEqual(await r.sendMessage(job('and then?')), { queued: true, position: 1 });

  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-aaaa-1111' }, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } }]);
  await r.poll();
  assert.deepEqual(frames.map(f => [f.seq, f.event.type]), [[1, 'turn-start'], [2, 'system'], [3, 'assistant']]);
  assert.ok(frames.every(f => f.turnId === turnId && f.chatKey === 'p1--main' && f.projectId === 'p1'));

  b.finish(turnId, 'sess-aaaa-1111');
  await r.poll();
  assert.equal(frames.at(-1).event.type, 'turn-end');
  const next = [...b.procs.values()].find(p => p.meta.turnId !== turnId);
  assert.equal(next.meta.text, 'and then?');
  assert.deepEqual(next.meta.args.slice(-2), ['--resume', 'sess-aaaa-1111']);
  assert.equal((await r.history('p1--main')).queued, 0);
});

test('durable: a new agent takes the turn up where the old one stopped, without sending anything twice', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const before = [];
  const r1 = runner(home, b, before);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-bbbb-2222' }]);
  await r1.poll();
  assert.equal(before.length, 2);

  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'while you were away' }] } }]);
  const after = [];
  const r2 = runner(home, b, after);
  await r2.recover();
  await r2.poll();
  assert.deepEqual(after.map(f => [f.seq, f.event.type]), [[3, 'assistant']]);
  assert.equal((await r2.history('p1--main')).running, true);
  b.finish(turnId, 'sess-bbbb-2222');
  await r2.poll();
  assert.deepEqual(after.map(f => f.event.type), ['assistant', 'turn-end']);
  const finished = await r2.history('p1--main');
  assert.equal(finished.running, false);
  assert.equal(finished.turn, null);
});

test('durable: a turn that died while the agent was down is reported; its queue parks until the backend resumes the chat', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  await r1.sendMessage(job('queued behind it'));
  await r1.poll();
  b.crash(turnId);

  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  await r2.poll();
  const err = frames.find(f => f.event.type === 'runner-error');
  assert.match(err.event.message, /stopped before Claude finished/);
  assert.deepEqual(frames.filter(f => f.turnId === turnId && f.seq != null).at(-1).event, { type: 'turn-end', exitCode: null, signal: null, lost: true });
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued behind it'), 'the queued message did not start');
  assert.deepEqual(frames.at(-1).event, { type: 'queue-parked', queued: 1 });
  assert.equal((await r2.history('p1--main')).parked, true);
  await r2.poll();
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued behind it'));

  assert.deepEqual(await r2.resumeQueue('p1--main'), { resumed: true });
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'queued behind it'), 'it starts once the backend resumes the chat');
});

test('durable: a queue found after a restart parks; a send from the backend starts it oldest first', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), JSON.stringify([job('left behind')]));
  const b = box(home);
  const r = runner(home, b, []);
  await r.recover();
  await r.poll();
  assert.equal(b.procs.size, 0, 'nothing starts after a restart');
  assert.equal((await r.history('p1--main')).parked, true);

  assert.deepEqual(await r.sendMessage(job('new one')), { queued: true, position: 1 });
  const started = [...b.procs.values()].map(p => p.meta.text);
  assert.deepEqual(started, ['left behind']);
  assert.equal((await r.history('p1--main')).parked, false);
});

test('durable: chat-clear drops the queue and stops the running turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const stopped = [];
  const r = runner(home, b, [], {
    stopSession: async (name) => {
      stopped.push(name);
      b.sessions.delete(name);
      for (const p of b.procs.values()) {
        if (p.meta.session === name) fs.writeFileSync(path.join(p.dir, 'exit'), JSON.stringify({ code: null, signal: 'SIGTERM' }));
      }
    },
  });
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: true });
  const { turnId } = await r.sendMessage(job('x'));
  await r.sendMessage(job('y'));
  await r.sendMessage(job('z'));
  assert.deepEqual(await r.clear('p1--main'), { cleared: 2, stopped: true });
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.equal((await r.history('p1--main')).queued, 0);
  assert.deepEqual(stopped, [`alice-chat-${turnId}-r`]);
  assert.ok(fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')));
  await assert.rejects(r.clear('../x'), /chatKey/);
});

test('durable: chat-clear reports stopped false while the process is still alive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-alive-'));
  const b = box(home);
  const r = runner(home, b, [], {
    interruptGraceMs: 15,
    pidAlive: () => true,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: false });
  const dir = b.procs.get(turnId).dir;
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false);
  assert.ok(b.signals.some(s => s[0] === 4242 && s[1] === 'SIGKILL'));
});

test('durable: chat-clear during start waits for the kill and does not invent an exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-start-clear-'));
  const b = box(home);
  let release;
  const held = new Promise(res => { release = res; });
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => { await held; return real(meta, dir); };
  const stopped = [];
  const r = runner(home, b, [], {
    interruptGraceMs: 15,
    pidAlive: () => true,
    stopSession: async (name) => { stopped.push(name); b.sessions.delete(name); },
  });
  const pendingSend = r.sendMessage(job('x'));
  await new Promise(res => setImmediate(res));
  let done = false;
  const pendingClear = r.clear('p1--main').then(res => { done = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(done, false);
  assert.equal(stopped.length, 0);
  release();
  const result = await pendingClear;
  assert.equal(result.stopped, false);
  assert.equal(stopped.length, 1);
  const { turnId } = await pendingSend;
  assert.equal(fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')), false);
  assert.ok(b.signals.some(s => s[1] === 'SIGKILL'));
});

test('durable: the alive check during chat-clear does not fake an exit while Claude is still alive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-clear-poll-'));
  const b = box(home);
  let t = 1_000_000;
  const r = runner(home, b, [], {
    now: () => t,
    interruptGraceMs: 40,
    pidAlive: () => true,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  const dir = b.procs.get(turnId).dir;
  const pendingClear = r.clear('p1--main');
  await new Promise(res => setImmediate(res));
  assert.equal(b.sessions.size, 0, 'kill-session removed the session');
  t += 11_000;
  await r.poll();
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'no synthetic exit while the wrapper is still killing Claude');
  // Even an exit file is not death while the recorded pid lives.
  fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: null, signal: null, lost: true }));
  assert.deepEqual(await pendingClear, { cleared: 0, stopped: false });
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: false }, 'a later clear with an exit but a live pid still refuses');
});

test('durable: a send during chat-clear is refused and nothing queued starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-clear-send-'));
  const b = box(home);
  let t = 1_000_000;
  let alive = true;
  const r = runner(home, b, [], {
    now: () => t,
    interruptGraceMs: 60,
    pidAlive: () => alive,
    stopSession: async (name) => { b.sessions.delete(name); },
  });
  const { turnId } = await r.sendMessage(job('x'));
  await r.sendMessage(job('y'));
  const pendingClear = r.clear('p1--main');
  await new Promise(res => setImmediate(res));
  await assert.rejects(r.sendMessage(job('z')), /chat-clearing/);
  assert.equal((await r.history('p1--main')).queued, 0);

  // A job that reached the queue anyway, and the turn ending mid-clear: the poll must not start it.
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), JSON.stringify([job('sneaked in')]));
  b.finish(turnId);
  t += 11_000;
  await r.poll();
  assert.equal(b.procs.size, 1, 'no new turn starts while the chat is being cleared');

  alive = false;
  assert.deepEqual(await pendingClear, { cleared: 1, stopped: true });
  await r.poll();
  assert.equal(b.procs.size, 1);
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), '[]');
  assert.equal((await r.sendMessage(job('after'))).queued, false, 'sends are accepted again once the clear returns');
});

test('durable: a crash noticed while the agent runs is closed on the next alive check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  let t = 1_000_000;
  const r = runner(home, b, frames, { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  await r.poll();
  b.crash(turnId);
  t += 11_000;
  await r.poll();
  await r.poll();
  assert.ok(frames.some(f => f.event.type === 'runner-error'));
  assert.equal(frames.at(-1).event.type, 'turn-end');
});

test('durable: nothing is lost while the socket is down', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  let down = true;
  const r = runner(home, b, frames, { down: () => down });
  const { turnId } = await r.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-cccc-3333' }]);
  await r.poll();
  assert.equal(frames.length, 0);
  down = false;
  await r.poll();
  assert.deepEqual(frames.map(f => f.seq), [1, 2]);
});

test('durable: history replays the running turn from its log and cuts it from the transcript', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-dddd-4444' }));
  const tdir = path.join(home, '.claude/projects/-w-p1');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'sess-dddd-4444.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('second'));
  fs.appendFileSync(path.join(tdir, 'sess-dddd-4444.jsonl'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } })}\n`);
  b.write(turnId, [{ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } }]);
  const h = await r.history('p1--main');
  assert.equal(h.running, true);
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.turn.events.map(e => [e.seq, e.event.type]), [[1, 'turn-start'], [2, 'stream_event']]);
});

test('durable: interrupt signals Claude and drops the queue, saying which messages; bad input is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-durable-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  assert.deepEqual(await r.interrupt('p1--main'), { interrupted: false, dropped: [] });
  await r.sendMessage(job('x'));
  await r.sendMessage(job('y'));
  assert.deepEqual(await r.interrupt('p1--main'), { interrupted: true, dropped: ['y'] });
  assert.deepEqual(frames.at(-1).event, { type: 'queue-dropped', texts: ['y'] });
  assert.deepEqual(b.signals[0], [4242, 'SIGINT']);
  assert.equal((await r.history('p1--main')).queued, 0);
  const dir = [...b.procs.values()][0].dir;
  assert.ok(fs.existsSync(path.join(dir, 'interrupted')), 'the wrapper must not report a deliberate stop as a failure');
  await assert.rejects(r.sendMessage(job('x', { chatKey: '../k' })), /chatKey/);
  await assert.rejects(r.sendMessage(job('x', { cwd: 'rel' })), /absolute/);
  await assert.rejects(r.sendMessage(job('  ')), /text/);
});

test('startTurn: a cwd change re-homes the transcript before --resume, and passes the config dir', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-'));
  const b = box(home);
  const r = runner(home, b, []);
  const id = 'sessio01-2345-6789-abcd-ef0123456789';
  const first = await r.sendMessage({ chatKey: 'p--w1', cwd: '/home/u/proj', text: 'hi', projectId: 'p', workstream: 'main', workstreamId: 'w1' });
  b.finish(first.turnId, id);
  await r.poll();
  const oldDir = path.join(home, '.claude/projects', slugForCwd('/home/u/proj'));
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${id}.jsonl`), '{"type":"user"}\n');
  const second = await r.sendMessage({ chatKey: 'p--w1', cwd: '/home/u/renamed', text: 'again', projectId: 'p', workstream: 'main', workstreamId: 'w1' });
  const newDir = path.join(home, '.claude/projects', slugForCwd('/home/u/renamed'));
  assert.ok(fs.existsSync(path.join(newDir, `${id}.jsonl`)), 'transcript followed the rename');
  const meta = b.procs.get(second.turnId).meta;
  assert.equal(meta.args[meta.args.indexOf('--resume') + 1], id, 'resumes the same session');
  assert.equal(meta.configDir, path.join(home, '.termag/chat-config'));
});

test('frames carry the workstream id, so the relay keys the chat by id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-wsid-'));
  const b = box(home);
  const sent = [];
  const r = runner(home, b, sent);
  const { turnId } = await r.sendMessage({ chatKey: 'p--w9', cwd: '/w', text: 'hi', projectId: 'p', workstream: 'feature', workstreamId: 'w9' });
  await r.poll();
  const start = sent.find(f => f.event?.type === 'turn-start');
  assert.equal(start.workstreamId, 'w9');
  assert.equal(start.workstream, 'feature');
  assert.equal(start.turnId, turnId);
});

test('sendMessage: the queue is capped, so a stuck chat cannot pile up billed turns', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cap-'));
  const b = box(home);
  const r = runner(home, b, []);
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'first' });
  for (let i = 0; i < 20; i++) await r.sendMessage({ chatKey: 'k', cwd: '/w', text: `q${i}` });
  await assert.rejects(r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'over' }), /queue-full/);
});

test('startTurn: a failed start ends the turn and the queued message runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-spawn-'));
  const b = box(home);
  let calls = 0;
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => {
    calls++;
    if (calls === 1) throw new Error('ENOENT');
    return real(meta, dir);
  };
  const sent = [];
  const r = runner(home, b, sent);
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'first' });
  await r.sendMessage({ chatKey: 'k', cwd: '/w', text: 'queued' });
  await r.poll();
  const types = sent.map(f => f.event?.type);
  assert.ok(types.includes('runner-error'), 'forwards the start failure');
  assert.ok(types.includes('turn-end'), 'ends the turn so the chat is not left busy');
  assert.equal([...b.procs.values()].map(p => p.meta.text).at(-1), 'queued');
});

test('durable: a died turn keeps the session id from its init line, and history still shows the error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-died-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'system', subtype: 'init', session_id: 'sess-ffff-6666' }]);
  b.crash(turnId);

  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  const state = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.json'), 'utf8'));
  assert.equal(state.sessionId, 'sess-ffff-6666');
  await r2.poll();
  const h = await r2.history('p1--main');
  assert.equal(h.running, false);
  assert.match(h.turn.events.find(e => e.event.type === 'runner-error').event.message, /Send the message again/);
  const next = await r2.sendMessage(job('again'));
  assert.deepEqual(b.procs.get(next.turnId).meta.args.slice(-2), ['--resume', 'sess-ffff-6666']);
});

test('durable: a died turn with no init does not wipe a session id already recorded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-died-keep-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-keep-7777', cwd: '/w/p1' }));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  b.crash(turnId);
  const r2 = runner(home, b, []);
  await r2.recover();
  const state = JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.json'), 'utf8'));
  assert.equal(state.sessionId, 'sess-keep-7777');
});

test('durable: turn-end that lands while a poll is forwarding is sent on the next poll', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-end-'));
  const b = box(home);
  const frames = [];
  let finishDuring = null;
  const r = createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin' },
    send: f => {
      frames.push(f);
      if (f.event.type === 'assistant' && finishDuring) finishDuring();
      return true;
    },
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
  });
  const { turnId } = await r.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] } }]);
  finishDuring = () => b.finish(turnId, 'sess-eeee-5555');
  await r.poll();
  assert.ok(!frames.some(f => f.event.type === 'turn-end'));
  await r.poll();
  assert.ok(frames.some(f => f.event.type === 'turn-end'));
});

test('durable: a liveness check does not kill a turn that is still starting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-starting-'));
  const b = box(home);
  let release;
  const held = new Promise(res => { release = res; });
  const real = b.startProcess;
  b.startProcess = async (meta, dir) => { await held; return real(meta, dir); };
  let t = 1_000_000;
  const r = runner(home, b, [], { now: () => t });
  const pending = r.sendMessage(job('hello'));
  await new Promise(res => setImmediate(res));
  t += 11_000;
  await r.poll();
  release();
  const { turnId } = await pending;
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'exit')));
});

test('durable: a hello does not park a queue this process already accepted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rehello-'));
  const b = box(home);
  const frames = [];
  const r = runner(home, b, frames);
  const { turnId } = await r.sendMessage(job('hello'));
  await r.sendMessage(job('follow-up'));
  await r.recover();
  b.finish(turnId, 'sess-rehello-1111');
  await r.poll();
  assert.ok([...b.procs.values()].some(p => p.meta.text === 'follow-up'), 'the follow-up starts');
  assert.ok(!frames.some(f => f.event.type === 'queue-parked'));
});

test('durable: a send clears recovered, so a queue behind a taken-up turn starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-reaccept-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  const { turnId } = await r1.sendMessage(job('hello'));
  await r1.sendMessage(job('left behind'));
  const frames = [];
  const r2 = runner(home, b, frames);
  await r2.recover();
  assert.deepEqual(await r2.sendMessage(job('and this')), { queued: true, position: 2 });
  b.finish(turnId, 'sess-reaccept-2222');
  await r2.poll();
  const started = [...b.procs.values()].filter(p => p.meta.turnId !== turnId).map(p => p.meta.text);
  assert.deepEqual(started, ['left behind']);
  assert.ok(!frames.some(f => f.event.type === 'queue-parked'));
});

test('durable: a disconnect during recover keeps the gate shut until the next recover', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rearm-'));
  const b = box(home);
  const r1 = runner(home, b, []);
  await r1.sendMessage(job('hello'));
  let releaseAlive;
  const alive = new Promise(res => { releaseAlive = res; });
  const r2 = runner(home, b, [], { sessionAlive: () => alive });
  r2.holdRecover();
  const recovering = r2.recover();
  await new Promise(res => setImmediate(res));
  r2.holdRecover();
  releaseAlive(true);
  await recovering;
  let started = false;
  const pending = r2.sendMessage(job('next')).then(res => { started = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(started, false);
  await r2.recover();
  await pending;
  assert.equal(started, true);
});

test('durable: send waits until recover finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-gate-'));
  const b = box(home);
  const r = runner(home, b, []);
  r.holdRecover();
  let started = false;
  const pending = r.sendMessage(job('hello')).then(res => { started = true; return res; });
  await new Promise(res => setImmediate(res));
  assert.equal(started, false);
  assert.equal(b.procs.size, 0);
  await r.recover();
  await pending;
  assert.equal(b.procs.size, 1);
});

test('durable: recover refuses a dead chat and does not forward it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-dead-'));
  const b = box(home);
  const stopped = [];
  const stopSession = async (name) => { stopped.push(name); b.sessions.delete(name); };
  const r1 = runner(home, b, [], { stopSession });
  const { turnId } = await r1.sendMessage(job('hello'));
  b.write(turnId, [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'secret' }] } }]);
  await r1.sendMessage(job('queued'));
  const frames = [];
  const r2 = runner(home, b, frames, { stopSession });
  await r2.recover({ deadKeys: ['p1--main'] });
  await r2.poll();
  assert.equal(frames.length, 0);
  assert.ok(stopped.includes(`alice-chat-${turnId}-r`));
  const h = await r2.history('p1--main');
  assert.equal(h.running, false);
  assert.equal(h.queued, 0);
  assert.ok(![...b.procs.values()].some(p => p.meta.text === 'queued'));
});

test('durable: a dead queue with no turn is dropped instead of parked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-dead-q-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  const queue = path.join(home, '.termag/chats/p1--main.queue.json');
  fs.writeFileSync(queue, JSON.stringify([job('left behind', { workstreamId: 'main' })]));
  const b = box(home);
  const r = runner(home, b, []);
  assert.ok(r.keysOnDisk().some(k => k.chatKey === 'p1--main' && k.projectId === 'p1' && k.workstreamId === 'main'));
  await r.recover({ deadKeys: ['p1--main'] });
  assert.equal(fs.existsSync(queue), false);
  assert.equal((await r.history('p1--main')).parked, false);
  assert.equal(b.procs.size, 0);
});

test('durable: an earlier identical prompt does not cut history; the cut is the transcript size at start', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bytes-'));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId: 'sess-hhhh-9999', cwd: '/w/p1' }));
  const file = path.join(home, '.claude/projects/-w-p1/sess-hhhh-9999.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prior = [
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, prior);
  const b = box(home);
  const r = runner(home, b, []);
  const { turnId } = await r.sendMessage(job('go'));
  assert.equal(b.procs.get(turnId).meta.transcriptBytes, Buffer.byteLength(prior));
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
  const h = await r.history('p1--main');
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].message.content, 'go');
});

test('durable: a finished turn directory older than an hour is removed on the alive check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-prune-'));
  const b = box(home);
  let t = 1_000_000;
  const r = runner(home, b, [], { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  b.finish(turnId, 'sess-gggg-8888');
  await r.poll();
  const dir = b.procs.get(turnId).dir;
  const old = new Date(t - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'done'), old, old);
  t += 11_000;
  await r.poll();
  assert.equal(fs.existsSync(dir), false);
});

test('durable: an interrupt whose wrapper never writes exit is not reported as a died turn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-int-'));
  const b = box(home);
  const frames = [];
  let t = 1_000_000;
  const r = runner(home, b, frames, { now: () => t });
  const { turnId } = await r.sendMessage(job('hello'));
  await r.interrupt('p1--main');
  b.crash(turnId);
  t += 11_000;
  await r.poll();
  await r.poll();
  assert.ok(!frames.some(f => f.event.type === 'runner-error'));
  assert.equal(frames.filter(f => f.event.type === 'turn-end').at(-1).event.lost, false);
});
