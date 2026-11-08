'use strict';
// The chat runner's pi engine (chat-pi-v1): engineOf, piTurnArgs, the turn
// it starts, its session and history, interrupt, chat-engine-check, and a
// real chat-turn.js run against a stand-in for `termag-pi-headless
// --headless` (the launcher's contract: plans/contract-a2.md in the
// automations space) that replays the pi spike's recordings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const {
  CAPABILITIES, PI_READ_ONLY_TOOLS, checkEngine, createChatRunner, engineOf, piLauncherReady, piModelArg, piThinkingArg, piTurnArgs, resolvePi,
} = require('./chat-runner');
const { piSessionSlug } = require('./pi-session');

const FIXTURES = path.join(__dirname, 'fixtures/pi');
const SESSION = 'd19250bb-94ce-4b99-b55a-de9911e8d39f';
const NEW_SESSION = '0f0e0d0c-1111-4222-8333-444455556666';

test('pi engine: chat-pi-v1 is advertised, and a send names claude, pi or nothing', () => {
  assert.ok(CAPABILITIES.includes('chat-pi-v1'));
  assert.equal(engineOf({}), 'claude');
  assert.equal(engineOf({ engine: '' }), 'claude');
  assert.equal(engineOf({ engine: 'claude' }), 'claude');
  assert.equal(engineOf({ engine: 'pi' }), 'pi');
  assert.throws(() => engineOf({ engine: 'codex' }), /^Error: engine-refused: /);
});

test('piTurnArgs: json print mode on the runner\'s session, the read tier closed to read tools, never the status extension', () => {
  const read = piTurnArgs(SESSION, 'dontAsk');
  assert.deepEqual(read, ['-p', '--mode', 'json', '--session-id', SESSION, '--no-approve', '--no-extensions', '--no-skills', '--tools', 'read,grep,find,ls']);
  assert.deepEqual(PI_READ_ONLY_TOOLS, ['read', 'grep', 'find', 'ls']);
  // auto: an automation's full tier. Every tool, but no MCP server (a built-in extension) and no skills.
  assert.deepEqual(piTurnArgs(SESSION, 'auto'), ['-p', '--mode', 'json', '--session-id', SESSION, '--no-approve', '--no-extensions', '--no-skills']);
  // bypass: the owner's own pi setup, as a bypass Claude turn loads the owner's.
  assert.deepEqual(piTurnArgs(SESSION, 'bypassPermissions'), ['-p', '--mode', 'json', '--session-id', SESSION, '--no-approve']);
  // Anything unknown is the read tier.
  assert.deepEqual(piTurnArgs(SESSION, 'acceptEdits'), read);
  assert.deepEqual(piTurnArgs(SESSION, undefined), read);
  for (const mode of ['dontAsk', 'auto', 'bypassPermissions']) {
    const args = piTurnArgs(SESSION, mode, { model: 'fireworks/glm-5.3-flash', effort: 'high' });
    assert.ok(!args.includes('-e') && !args.join(' ').includes('termag-status'), 'status comes from the runner');
    assert.ok(!args.includes('--approve'));
    assert.deepEqual(args.slice(-4), ['--model', 'fireworks/glm-5.3-flash', '--thinking', 'high']);
  }
  assert.throws(() => piTurnArgs(null, 'auto'), /session id/);
});

test('pi model and thinking: broker ids pass, anything else is no flag', () => {
  for (const m of ['fireworks/glm-5.3-flash', 'bedrock/glm-5', 'bedrock/kimi-k3', 'glm-5']) assert.equal(piModelArg(m), m);
  for (const m of ['--tools', '; rm -rf /', 'a/b/c', '', null, 7, `x/${'y'.repeat(200)}`]) assert.equal(piModelArg(m), null);
  for (const e of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(piThinkingArg(e), e);
  for (const e of ['default', 'ultra', '', null]) assert.equal(piThinkingArg(e), null);
});

test('resolvePi: the override, then the reconciled launcher, then PATH; a launcher from before --headless is not ready', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resolve-'));
  assert.equal(resolvePi({ home, env: { TERMAG_CHAT_PI: '/x/fake' } }), '/x/fake');
  assert.equal(resolvePi({ home, env: {} }), 'termag-pi-headless');
  const bin = path.join(home, '.local/bin/termag-pi-headless');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexec pi-headless -e termag-status.ts "$@"\n');
  assert.equal(resolvePi({ home, env: {} }), bin);
  assert.equal(piLauncherReady(bin), false);
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in --check) ;; --headless) ;; esac\n');
  assert.equal(piLauncherReady(bin), true);
  assert.equal(piLauncherReady(path.join(home, 'missing')), false);
});

test('resolvePi: a launcher on PATH or a relative override resolves to an absolute path, so its readiness is checked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resolve-path-'));
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir);
  const old = path.join(dir, 'termag-pi-headless');
  fs.writeFileSync(old, '#!/bin/sh\nexec pi-headless -e termag-status.ts "$@"\n', { mode: 0o755 });
  assert.equal(resolvePi({ home, env: { PATH: `/nonexistent:${dir}` } }), old);
  assert.equal(resolvePi({ home, env: { TERMAG_CHAT_PI: path.relative(process.cwd(), old) } }), old);
  assert.equal(resolvePi({ home, env: { TERMAG_CHAT_PI: 'termag-pi-headless', PATH: dir } }), old);
  assert.equal((await checkEngine({ engine: 'pi' }, { home, env: { PATH: dir } })).code, 'launcher-outdated');
  assert.equal((await checkEngine({ engine: 'pi' }, { home, env: { PATH: '/nonexistent' } })).code, 'launcher-missing');
});

/** A stand-in launcher: `--check` exits with `checkCode` and its stderr line. */
function fakeLauncher(dir, body) {
  const bin = path.join(dir, 'termag-pi-headless');
  fs.writeFileSync(bin, `#!/bin/sh\n# stand-in for --headless / --check\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('checkEngine: the launcher\'s --check exit codes are the reasons the orchestrator acts on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-check-'));
  assert.deepEqual(await checkEngine({ engine: 'claude' }, { home: dir }), { ok: true, engine: 'claude' });
  await assert.rejects(checkEngine({ engine: 'codex' }, { home: dir }), /engine-refused/);
  const cases = [
    [0, '', { ok: true, engine: 'pi' }],
    [127, 'pi: pi-missing: pi is not installed', { code: 'pi-missing' }],
    [127, 'pi: launcher-missing: pi-headless is not installed', { code: 'launcher-missing' }],
    // The launcher's own line, which names pi-headless (Bugbot #720).
    [127, 'termag: the AWS CLI is not installed; pi-headless needs it for the AWS SSO session', { code: 'aws-missing' }],
    [75, "pi: broker-auth: AWS SSO session for 'dev' is missing or expired; run: aws sso login", { code: 'broker-auth' }],
    [69, 'pi: broker-down: the broker is not answering', { code: 'broker-down' }],
    [1, 'something else', { code: 'check-failed' }],
  ];
  for (const [exit, line, want] of cases) {
    const bin = fakeLauncher(dir, `[ "$1" = --check ] || exit 99\n${line ? `echo "${line}" >&2\n` : ''}exit ${exit}`);
    const got = await checkEngine({ engine: 'pi' }, { home: dir, env: { ...process.env, TERMAG_CHAT_PI: bin } });
    if (want.ok) { assert.deepEqual(got, want); continue; }
    assert.equal(got.ok, false);
    assert.equal(got.code, want.code, line);
    assert.equal(got.exitCode, exit);
    assert.equal(got.remedy, line);
  }
  const slow = fakeLauncher(dir, 'exec sleep 5');
  const timedOut = await checkEngine({ engine: 'pi' }, { home: dir, env: { ...process.env, TERMAG_CHAT_PI: slow }, timeoutMs: 100 });
  assert.equal(timedOut.code, 'check-timeout');
  // An older launcher never gets --check: it would start pi.
  const old = path.join(dir, 'old-launcher');
  fs.writeFileSync(old, '#!/bin/sh\nexec pi-headless "$@"\n', { mode: 0o755 });
  assert.equal((await checkEngine({ engine: 'pi' }, { home: dir, env: { TERMAG_CHAT_PI: old } })).code, 'launcher-outdated');
  assert.equal((await checkEngine({ engine: 'pi' }, { home: dir, env: { TERMAG_CHAT_PI: path.join(dir, 'nope') } })).code, 'launcher-missing');
  assert.equal((await checkEngine({ engine: 'pi' }, { home: dir, env: { PATH: '/nonexistent' } })).code, 'launcher-missing');
});

// A box whose turns are written by the test (as chat-runner.test.js's box()).
function box() {
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
    /** The turn as chat-turn.js would end it: init, result, the state file, turn-end, exit. */
    finish: (turnId, sessionId, engine) => {
      const { meta, dir } = procs.get(turnId);
      const lines = [{ type: 'system', subtype: 'init', session_id: sessionId }, { type: 'result', is_error: false, session_id: sessionId }, { type: 'turn-end', exitCode: 0 }];
      fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd, ...(engine === 'pi' ? { engine } : {}) }));
      fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.map(e => `${JSON.stringify(e)}\n`).join(''));
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    sessionAlive: async (name) => sessions.has(name),
    signalPid: (pid, sig) => signals.push([pid, sig]),
  };
}

function piRunner(home, b, opts = {}) {
  const piBin = fakeLauncher(home, 'exit 0  # --headless --check');
  let n = 0;
  return createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', piBin, env: { PATH: '/usr/bin' },
    send: () => true, startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
    stopSession: async () => {}, interruptGraceMs: opts.interruptGraceMs ?? 5,
    ...(opts.pidAlive ? { pidAlive: opts.pidAlive } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    readCheckout: async () => ({ repo: false }),
    newSessionId: () => (n++ === 0 ? NEW_SESSION : `${NEW_SESSION.slice(0, -1)}${n}`),
  });
}

const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', engine: 'pi', ...extra });
const metaOf = (b, turnId) => b.procs.get(turnId).meta;
async function poll(r) { await r.poll(); await r.poll(); }

test('pi turn: the launcher in --headless, the runner\'s own session id, the prompt only in prompt.txt', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-'));
  const b = box();
  const r = piRunner(home, b);
  const { turnId } = await r.sendMessage(job('hello pi', { permissionMode: 'auto', model: 'bedrock/glm-5', effort: 'max', liveInput: true, orchestrator: true, titles: true, genUiPrompt: 'GENERATIVE UI (termag): the catalog' }));
  const meta = metaOf(b, turnId);
  assert.equal(meta.engine, 'pi');
  assert.equal(meta.bin, path.join(home, 'termag-pi-headless'));
  assert.equal(meta.args[0], '--headless');
  assert.deepEqual(meta.args.slice(1), piTurnArgs(NEW_SESSION, 'auto', { model: 'bedrock/glm-5', effort: 'max' }));
  assert.ok(!meta.args.includes('hello pi'), 'the brief goes on stdin');
  assert.equal(fs.readFileSync(path.join(b.procs.get(turnId).dir, 'prompt.txt'), 'utf8'), 'hello pi');
  // No live input, Claude config dir, MCP reload, orchestrator prompt, generative UI prompt or titles on pi.
  assert.equal(meta.live, false);
  assert.equal(meta.genUi, undefined);
  assert.ok(!meta.args.some(a => a.startsWith('--append-system-prompt')));
  assert.ok(!fs.existsSync(path.join(b.procs.get(turnId).dir, 'system-prompt.md')), 'no generative UI prompt is written for pi');
  assert.equal(meta.configDir, undefined);
  assert.equal(meta.mcpVersionFile, undefined);
  assert.equal(meta.titles, undefined);
  assert.equal(meta.resumed, false);
  assert.equal(meta.mode, 'auto', 'a checkout with no repository is the owner\'s own');
});

test('pi turn: the session goes on with --session-id, and a Claude turn never resumes a pi session (or the reverse)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-turn-'));
  const b = box();
  const r = piRunner(home, b);
  const first = await r.sendMessage(job('one'));
  b.finish(first.turnId, NEW_SESSION, 'pi');
  await poll(r);
  assert.deepEqual(r.readSession('p1--main'), { sessionId: NEW_SESSION, cwd: '/w/p1', engine: 'pi', pane: null, paneAt: null });
  const second = await r.sendMessage(job('two'));
  assert.equal(metaOf(b, second.turnId).resumed, true);
  assert.ok(metaOf(b, second.turnId).args.includes(NEW_SESSION));
  b.finish(second.turnId, NEW_SESSION, 'pi');
  await poll(r);
  // The same chat on Claude starts its own session.
  const claude = await r.sendMessage(job('three', { engine: undefined }));
  const claudeMeta = metaOf(b, claude.turnId);
  assert.equal(claudeMeta.engine, undefined);
  assert.equal(claudeMeta.bin, '/bin/claude');
  assert.ok(!claudeMeta.args.includes('--resume'));
  assert.equal(claudeMeta.resumed, false);
  b.finish(claude.turnId, 'claude-sess-1234', 'claude');
  await poll(r);
  assert.equal(r.readSession('p1--main').engine, 'claude');
  const back = await r.sendMessage(job('four'));
  assert.equal(metaOf(b, back.turnId).resumed, false);
  assert.ok(!metaOf(b, back.turnId).args.includes('claude-sess-1234'));
});

test('pi turn: no space memory (pi\'s argv takes no --append-system-prompt from here), and a Claude turn after it asks for a new session\'s', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-'));
  const b = box();
  const asked = [];
  const memory = {
    forTurn: async (q) => { asked.push(q); return { appendPrompt: 'SPACE MEMORY INDEX', notice: 'memory changed' }; },
    frozenPromptFor: () => 'SPACE MEMORY INDEX',
  };
  const r = piRunner(home, b, { memory });
  const first = await r.sendMessage(job('hello pi', { spaceMemory: { space: 'team' } }));
  const meta = metaOf(b, first.turnId);
  assert.deepEqual(asked, [], 'a pi turn asks the space for nothing');
  assert.ok(!meta.args.some(a => a.startsWith('--append-system-prompt') || a.includes('SPACE MEMORY')));
  assert.equal(fs.readFileSync(path.join(b.procs.get(first.turnId).dir, 'prompt.txt'), 'utf8'), 'hello pi');
  b.finish(first.turnId, NEW_SESSION, 'pi');
  await poll(r);
  // The same chat on Claude: its memory is a new Claude session's, never keyed to pi's session.
  const claude = await r.sendMessage(job('on claude', { engine: undefined, spaceMemory: { space: 'team' } }));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].sessionId, null);
  assert.ok(metaOf(b, claude.turnId).args.includes('SPACE MEMORY INDEX'));
});

test('pi turn: a checkout that is not the repository\'s own tree runs the read tier', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pr-'));
  const b = box();
  const r = createChatRunner({
    home, username: 'alice', piBin: fakeLauncher(home, 'exit 0  # --headless --check'), env: {}, send: () => true,
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid, newSessionId: () => NEW_SESSION,
    readCheckout: async () => ({ repo: true, branch: 'pr-1', checkout: 'pr', originUrl: 'git@github.com:org/repo.git' }),
  });
  const { turnId } = await r.sendMessage(job('x', { permissionMode: 'auto' }));
  assert.equal(metaOf(b, turnId).mode, 'dontAsk');
  assert.deepEqual(metaOf(b, turnId).args.slice(-2), ['--tools', 'read,grep,find,ls']);
});

test('pi turn: the init event records the session as pi\'s, before the turn is over', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-init-'));
  const b = box();
  const r = piRunner(home, b);
  const { turnId } = await r.sendMessage(job('one'));
  fs.appendFileSync(path.join(b.procs.get(turnId).dir, 'events.jsonl'), `${JSON.stringify({ type: 'system', subtype: 'init', session_id: NEW_SESSION, engine: 'pi' })}\n`);
  await r.poll();
  assert.equal(r.readSession('p1--main').engine, 'pi');
  assert.equal(r.readSession('p1--main').sessionId, NEW_SESSION);
});

test('pi send: no ask, backend or images on pi, and an unknown engine is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-refuse-'));
  const b = box();
  const r = piRunner(home, b);
  await assert.rejects(r.sendMessage(job('x', { backend: 'fireworks', model: 'accounts/f/models/m' })), /engine-refused: .*backend/);
  await assert.rejects(r.sendMessage(job('x', { ask: { threadId: 'abcdefgh12' } })), /engine-refused: .*ask/);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d40000000049454e44ae426082', 'hex').toString('base64');
  await assert.rejects(r.sendMessage(job('x', { images: [{ mediaType: 'image/png', data: png }] })), /engine-refused: .*images/);
  await assert.rejects(r.sendMessage(job('x', { engine: 'codex' })), /engine-refused/);
  assert.equal(b.procs.size, 0);
});

test('pi turn: a launcher from before --headless ends the turn with why, and starts nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-old-'));
  const b = box();
  const old = path.join(home, 'old');
  fs.writeFileSync(old, '#!/bin/sh\nexec pi-headless "$@"\n', { mode: 0o755 });
  const frames = [];
  const r = createChatRunner({
    home, username: 'alice', piBin: old, env: {}, send: f => { frames.push(f); return true; },
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid, readCheckout: async () => ({ repo: false }),
  });
  await r.sendMessage(job('x'));
  assert.equal(b.procs.size, 0);
  await poll(r);
  assert.ok(frames.some(f => f.event.type === 'runner-error' && /no --headless/.test(f.event.message)));
});

test('pi interrupt: SIGTERM to the agent\'s process group, then SIGKILL; never SIGINT', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-interrupt-'));
  const b = box();
  const r = piRunner(home, b, { interruptGraceMs: 5 });
  await r.sendMessage(job('x'));
  assert.deepEqual((await r.interrupt('p1--main')).interrupted, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(b.signals, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  const dir = [...b.procs.values()][0].dir;
  assert.ok(fs.existsSync(path.join(dir, 'interrupted')));
});

test('pi clear: not stopped while the wrapper is still up after pi\'s group is gone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-clear-'));
  const b = box();
  // pi (4242) is gone once signalled; the wrapper (4343) is still draining.
  const alive = new Set([4343]);
  const r = piRunner(home, b, { interruptGraceMs: 5, pidAlive: pid => alive.has(pid) });
  await r.sendMessage(job('x'));
  const dir = [...b.procs.values()][0].dir;
  fs.writeFileSync(path.join(dir, 'turn.pid'), '4343');
  // kill-session: the tmux session is gone at once.
  b.sessions.clear();
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: false });
  await poll(r);
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'a stop whose wrapper is still up is not a died turn');
  alive.delete(4343);
  assert.deepEqual(await r.clear('p1--main'), { cleared: 0, stopped: true });
});

test('pi history: the chat\'s finished turns come from pi\'s session file, and Open in full UI types nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-history-'));
  const b = box();
  const r = piRunner(home, b);
  const dir = path.join(home, '.pi/agent/sessions', piSessionSlug('/w/p1'));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'session-file-v3-tool-use.jsonl'), path.join(dir, `2026-10-26T17-43-51-235Z_${SESSION}.jsonl`));
  const { turnId } = await r.sendMessage(job('one'));
  b.finish(turnId, SESSION, 'pi');
  await poll(r);
  const h = await r.history('p1--main');
  assert.equal(h.sessionId, SESSION);
  assert.equal(h.engine, 'pi');
  assert.equal(h.running, false);
  assert.ok(h.entries.length >= 10);
  assert.match(h.entries[0].message.content[0].text, /^You are in a scratch directory/);
  assert.ok(h.entries.some(e => e.message.content.some(c => c.type === 'tool_use' && c.name === 'bash')));
  // The turn's record keys on pi's entry for the prompt.
  assert.equal(h.turns.length, 1);
  const claim = await r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(claim.claimed, true);
  assert.equal(claim.line, null);
  await r.releaseResume('p1--main');
});

test('pi turn: a renamed checkout\'s session file moves with it before --session-id looks it up', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rehome-'));
  const b = box();
  const r = piRunner(home, b);
  const { turnId } = await r.sendMessage(job('one'));
  const old = path.join(home, '.pi/agent/sessions', piSessionSlug('/w/p1'));
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, `t_${NEW_SESSION}.jsonl`), '{"type":"session"}\n');
  b.finish(turnId, NEW_SESSION, 'pi');
  await poll(r);
  const next = await r.sendMessage(job('two', { cwd: '/w/p1-renamed' }));
  assert.ok(fs.existsSync(path.join(home, '.pi/agent/sessions', piSessionSlug('/w/p1-renamed'), `t_${NEW_SESSION}.jsonl`)));
  assert.ok(metaOf(b, next.turnId).args.includes(NEW_SESSION));
});

// --- chat-turn.js itself, on the pi engine ---

/** A turn directory whose launcher replays `fixture` after reading the brief from stdin, and exits `code`. */
function piTurnDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chat-turn-'));
  const bin = fakeLauncher(dir, body);
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'the brief\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    chatKey: 'k', bin, args: ['--headless', ...piTurnArgs(SESSION, 'dontAsk')], cwd: dir, path: process.env.PATH, text: 'the brief', resumed: false, stateFile: state, engine: 'pi',
  }));
  return { dir, state };
}
const eventsIn = dir => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('a real pi turn: brief on stdin, pi\'s stream normalised into the log, pi\'s own lines kept, the session recorded as pi\'s', () => {
  const { dir, state } = piTurnDir(`[ "$1" = --headless ] || exit 98
read -r brief
[ "$brief" = "the brief" ] || exit 97
cat '${path.join(FIXTURES, 'tool-use-space-put.jsonl')}'`);
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir]);
  const events = eventsIn(dir);
  assert.equal(events[0].type, 'turn-start');
  assert.deepEqual(events[1], { type: 'system', subtype: 'init', session_id: SESSION, cwd: '/tmp/sdk/wd', engine: 'pi' });
  const result = events.find(e => e.type === 'result');
  assert.equal(result.is_error, false);
  assert.match(result.result, /STATUS: done/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', exitCode: 0, signal: null });
  assert.ok(!events.some(e => e.type === 'runner-error'));
  assert.equal(fs.readFileSync(path.join(dir, 'pi-events.jsonl'), 'utf8'), fs.readFileSync(path.join(FIXTURES, 'tool-use-space-put.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => `${l}\n`).join(''));
  const s = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(s.sessionId, SESSION);
  assert.equal(s.engine, 'pi');
});

test('a real pi turn that fails: a model error exiting 0 is a failed result; a failed pre-flight is pi\'s stderr', () => {
  const bad = piTurnDir(`cat '${path.join(FIXTURES, 'error-bad-model.jsonl')}'`);
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), bad.dir]);
  const events = eventsIn(bad.dir);
  const result = events.find(e => e.type === 'result');
  assert.equal(result.is_error, true);
  assert.match(result.result, /trusted launch catalog/);
  assert.ok(!events.some(e => e.type === 'runner-error'), 'the result says it');

  const sso = piTurnDir(`echo "pi: broker-auth: AWS SSO session for 'dev' is missing or expired" >&2\nexit 75`);
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), sso.dir]);
  const failed = eventsIn(sso.dir);
  assert.deepEqual(failed.map(e => e.type), ['turn-start', 'runner-error', 'turn-end']);
  assert.match(failed[1].message, /^pi exited 75: pi: broker-auth: /);
  assert.equal(failed[2].exitCode, 75);
  assert.equal(fs.existsSync(sso.state), false, 'no session to go on with');
});

test('a real pi turn stopped by a hangup: SIGTERM reaches pi\'s whole group through a launcher that does not exec', async () => {
  const { dir } = piTurnDir(`head -n 3 '${path.join(FIXTURES, 'interrupted-sigterm-tool.jsonl')}'
sleep 30 &
echo $! > "${'$'}{0%/*}/tool.pid"
wait`);
  fs.writeFileSync(path.join(dir, 'interrupted'), '');
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore' });
  const toolPid = path.join(dir, 'tool.pid');
  for (let i = 0; i < 100 && !fs.existsSync(toolPid); i++) await new Promise(r => setTimeout(r, 20));
  const tool = Number(fs.readFileSync(toolPid, 'utf8'));
  assert.ok(tool > 0);
  assert.equal(Number(fs.readFileSync(path.join(dir, 'turn.pid'), 'utf8')), wrapper.pid, 'the wrapper records itself for chat-clear');
  wrapper.kill('SIGHUP');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrapper did not exit')), 8000);
    wrapper.once('exit', c => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(tool, 0); await new Promise(r => setTimeout(r, 20)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the tool process was in the group and is gone');
  const events = eventsIn(dir);
  assert.equal(events[1].type, 'system');
  assert.ok(!events.some(e => e.type === 'result' || e.type === 'runner-error'), 'a stop is not a failure');
  assert.equal(events.at(-1).type, 'turn-end');
});

test('pi context: Clear and Compact are refused on a pi session (Compact would start a Claude session with /compact)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-context-'));
  const b = box();
  const r = piRunner(home, b);
  const { turnId } = await r.sendMessage(job('one'));
  b.finish(turnId, NEW_SESSION, 'pi');
  await poll(r);
  await assert.rejects(r.compact({ chatKey: 'p1--main', cwd: '/w/p1', projectId: 'p1', workstream: 'main', permissionMode: 'bypassPermissions' }), /^Error: engine-refused: /);
  assert.equal(b.procs.size, 1, 'no /compact turn started');
  await assert.rejects(r.resetContext('p1--main'), /^Error: engine-refused: /);
  assert.equal(r.readSession('p1--main').sessionId, NEW_SESSION, 'the pi session stays the chat\'s');
  assert.deepEqual(r.readEarlier('p1--main'), []);
});

test('pi recover: a wrapper still draining after its session is gone is taken up, not closed as died', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recover-drain-'));
  const b = box();
  // pi (4242) is gone; the wrapper (4343) is still draining after kill-session.
  const alive = new Set([4343]);
  let clock = 1_000_000;
  const opts = { pidAlive: pid => alive.has(pid), now: () => clock };
  const r = piRunner(home, b, opts);
  await r.sendMessage(job('x'));
  const dir = [...b.procs.values()][0].dir;
  fs.writeFileSync(path.join(dir, 'turn.pid'), '4343');
  b.sessions.clear();
  // The agent restarts while the wrapper drains.
  const r2 = piRunner(home, b, opts);
  await r2.recover();
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'recover does not close a turn whose wrapper is up');
  await poll(r2);
  clock += 60_000;
  await poll(r2);
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'nor does the next alive check');
  // The wrapper died without writing exit: now the turn is dead.
  alive.delete(4343);
  clock += 60_000;
  await poll(r2);
  assert.equal(fs.existsSync(path.join(dir, 'exit')), true);
});

test('pi orphan: a pi left running by a dead wrapper is stopped (group SIGTERM, then SIGKILL) before its turn closes, on poll and on recover', async () => {
  for (const viaRecover of [false, true]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orphan-'));
    const b = box();
    // The wrapper (4343) crashed; pi (4242) is still up, in its own group.
    const alive = new Set([4242]);
    let clock = 1_000_000;
    const opts = { pidAlive: pid => alive.has(pid), now: () => clock, interruptGraceMs: 5 };
    let r = piRunner(home, b, opts);
    await r.sendMessage(job('x'));
    const dir = [...b.procs.values()][0].dir;
    fs.writeFileSync(path.join(dir, 'turn.pid'), '4343');
    b.sessions.clear();
    if (viaRecover) { r = piRunner(home, b, opts); await r.recover(); }
    clock += 60_000;
    await poll(r);
    assert.deepEqual(b.signals[0], [-4242, 'SIGTERM'], 'pi\'s group is told to stop');
    assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'not closed while pi still writes the session');
    await new Promise(res => { setTimeout(res, 20); });
    assert.deepEqual(b.signals[1], [-4242, 'SIGKILL']);
    alive.delete(4242);
    clock += 60_000;
    await poll(r);
    assert.equal(fs.existsSync(path.join(dir, 'exit')), true, 'closed as died once pi is gone');
    assert.equal(b.signals.length, 2, 'signalled once');
  }
});

test('pi orphan: a draining turn whose wrapper then dies with pi still up is reaped, not left open (Bugbot #720)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-orphan-drain-'));
  const b = box();
  // Both up when the agent restarts: the turn is taken up as draining.
  const alive = new Set([4242, 4343]);
  let clock = 1_000_000;
  const opts = { pidAlive: pid => alive.has(pid), now: () => clock, interruptGraceMs: 5 };
  const r = piRunner(home, b, opts);
  await r.sendMessage(job('x'));
  const dir = [...b.procs.values()][0].dir;
  fs.writeFileSync(path.join(dir, 'turn.pid'), '4343');
  b.sessions.clear();
  const r2 = piRunner(home, b, opts);
  await r2.recover();
  clock += 60_000;
  await poll(r2);
  assert.equal(b.signals.length, 0, 'nothing signalled while the wrapper drains');
  // The wrapper dies without writing exit; pi is still running.
  alive.delete(4343);
  clock += 60_000;
  await poll(r2);
  assert.deepEqual(b.signals[0], [-4242, 'SIGTERM'], 'pi\'s group is told to stop');
  assert.equal(fs.existsSync(path.join(dir, 'exit')), false, 'not closed while pi still writes the session');
  alive.delete(4242);
  clock += 60_000;
  await poll(r2);
  assert.equal(fs.existsSync(path.join(dir, 'exit')), true, 'closed as died once pi is gone');
});

