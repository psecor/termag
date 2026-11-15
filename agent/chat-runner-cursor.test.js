'use strict';
// The chat runner's cursor engine (chat-cursor-v1): cursorTurnArgs, where
// cursor-agent is found, chat-engine-check, the turn it starts and resumes,
// and a real chat-turn.js run against a stand-in cursor-agent that replays
// cursor-agent 2026.10.22's own stream (agent/fixtures/cursor/2026.10.22/),
// keeping the session's transcript for history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  CAPABILITIES, CURSOR_READ_ONLY_TOOLS, checkEngine, createChatRunner, cursorConfinedHome, cursorModelArg, cursorTurnArgs, engineOf, resolveCursor,
} = require('./chat-runner');

const FIXTURES = path.join(__dirname, 'fixtures/cursor/2026.10.22');
// The session tools-auto-review.jsonl's init names.
const FIXTURE_SESSION = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tools-auto-review.jsonl'), 'utf8').split('\n')[0]).session_id;
const SESSION = 'c7f63169-1725-4620-9601-991ca50db6bc';

test('cursor engine: chat-cursor-v1 is advertised, and a send may name it', () => {
  assert.ok(CAPABILITIES.includes('chat-cursor-v1'));
  assert.equal(engineOf({ engine: 'cursor' }), 'cursor');
});

const WS = { workspace: '/h/.termag/chats/cursor-workspaces/p1--main', checkout: '/w/p1' };
const BASE = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', WS.workspace, '--add-dir', WS.checkout];

test("cursorTurnArgs: stream-json print mode in the chat's own empty workspace, the checkout added, the tier the mode's, a resume once Cursor named the session", () => {
  assert.deepEqual(cursorTurnArgs(null, 'dontAsk', WS), [...BASE, '--mode', 'plan']);
  assert.deepEqual(cursorTurnArgs(null, 'auto', WS), [...BASE, '--auto-review']);
  assert.deepEqual(cursorTurnArgs(null, 'bypassPermissions', WS), [...BASE, '--force']);
  // Anything unknown is the read tier.
  assert.deepEqual(cursorTurnArgs(null, 'acceptEdits', WS), cursorTurnArgs(null, 'dontAsk', WS));
  assert.deepEqual(cursorTurnArgs(SESSION, 'dontAsk', { ...WS, model: 'gpt-5' }).slice(-4), ['--resume', SESSION, '--model', 'gpt-5']);
  for (const mode of ['dontAsk', 'auto', 'bypassPermissions']) {
    const args = cursorTurnArgs(SESSION, mode, WS);
    assert.ok(!args.includes('--approve-mcps'), 'no MCP server is approved here');
    assert.ok(!args.some(a => /prompt/i.test(a)), 'the message is on stdin');
    // The checkout is never the workspace: Cursor runs a trusted workspace's .cursor/hooks.json (sessionStart, even in plan mode).
    assert.equal(args[args.indexOf('--workspace') + 1], WS.workspace);
  }
  assert.throws(() => cursorTurnArgs('../x', 'auto', WS), /session id/);
  assert.throws(() => cursorTurnArgs(null, 'dontAsk'), /own workspace/);
  assert.throws(() => cursorTurnArgs(null, 'dontAsk', { workspace: WS.checkout, checkout: 'relative' }), /own workspace/);
  assert.deepEqual(CURSOR_READ_ONLY_TOOLS, ['Read', 'Grep', 'Glob']);
});

test('cursor model: its model names pass, anything else is no flag', () => {
  for (const m of ['gpt-5', 'sonnet-4-thinking', 'composer-1', 'auto']) assert.equal(cursorModelArg(m), m);
  for (const m of ['--force', "claude-opus-4-8[context=1m]", 'a b', '', null, 7, 'x'.repeat(90)]) assert.equal(cursorModelArg(m), null);
});

test('resolveCursor and chat-engine-check: the override, the installer\'s ~/.local/bin, then PATH; none is the reason', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-resolve-'));
  assert.equal(resolveCursor({ home, env: { TERMAG_CHAT_CURSOR: '/x/cursor-agent' } }), '/x/cursor-agent');
  assert.equal(resolveCursor({ home, env: {} }), 'cursor-agent');
  assert.deepEqual(await checkEngine({ engine: 'cursor' }, { home, env: {} }), {
    ok: false, engine: 'cursor', code: 'launcher-missing', remedy: 'cursor-agent is not installed on this box (its installer puts it in ~/.local/bin)',
  });
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveCursor({ home, env: { PATH: `/nonexistent:${dir}` } }), path.join(dir, 'cursor-agent'));
  const installed = path.join(home, '.local/bin/cursor-agent');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveCursor({ home, env: { PATH: dir } }), installed);
  assert.deepEqual(await checkEngine({ engine: 'cursor' }, { home, env: {} }), { ok: true, engine: 'cursor' });
});

// --- the runner: the turn it starts on the cursor engine ---

function box() {
  const sessions = new Set();
  const procs = new Map();
  return {
    procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text, resumed: meta.resumed })}\n`);
      fs.writeFileSync(path.join(dir, 'claude.pid'), '4242');
      procs.set(meta.turnId, { meta, dir });
    },
    /** The turn as chat-turn.js ends it on Cursor: init, a transcript line, result, the state file, turn-end, exit. */
    finish: (turnId, sessionId) => {
      const { meta, dir } = procs.get(turnId);
      fs.mkdirSync(meta.transcriptDir, { recursive: true });
      fs.appendFileSync(path.join(meta.transcriptDir, `${sessionId}.jsonl`), [
        { type: 'user', uuid: `u-${turnId}`, timestamp: '2026-11-12T18:00:00.000Z', message: { role: 'user', content: meta.text } },
        { type: 'assistant', uuid: `a-${turnId}`, timestamp: '2026-11-12T18:00:01.000Z', message: { id: 'cursor-1', role: 'assistant', content: [{ type: 'text', text: `answer to ${meta.text}` }] } },
      ].map(l => `${JSON.stringify(l)}\n`).join(''));
      const lines = [{ type: 'system', subtype: 'init', session_id: sessionId, engine: 'cursor' }, { type: 'result', is_error: false, session_id: sessionId }, { type: 'turn-end', exitCode: 0 }];
      fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd, engine: 'cursor' }));
      fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.map(e => `${JSON.stringify(e)}\n`).join(''));
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    sessionAlive: async (name) => sessions.has(name),
    signalPid: () => {},
  };
}

function cursorRunner(home, b, cursorBin) {
  return createChatRunner({
    investigationFor: () => null,
    home, username: 'alice', claudeBin: '/bin/claude', cursorBin, env: { PATH: '/usr/bin' },
    send: () => true, startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
    stopSession: async () => {}, interruptGraceMs: 5,
    readCheckout: async () => ({ repo: false }),
  });
}
const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', engine: 'cursor', ...extra });
async function poll(r) { await r.poll(); await r.poll(); }

test("cursor turn: cursor-agent in print mode, no session until Cursor names one, then --resume; the runner's transcript is its history", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  const first = await r.sendMessage(job('one', { permissionMode: 'bypassPermissions', model: 'gpt-5', effort: 'high' }));
  const meta = b.procs.get(first.turnId).meta;
  assert.equal(meta.bin, bin);
  assert.equal(meta.engine, 'cursor');
  assert.ok(!meta.args.includes('--resume'), 'a first turn names no session');
  assert.ok(meta.args.includes('--model') && meta.args.includes('gpt-5'));
  // The chat's own workspace, the same on every turn (Cursor resumes a session only in the workspace that made it), never the checkout.
  const ws = meta.args[meta.args.indexOf('--workspace') + 1];
  assert.equal(ws, path.join(path.dirname(meta.stateFile), 'cursor-workspaces', 'p1--main'));
  assert.deepEqual(fs.readdirSync(ws), []);
  assert.equal(meta.args[meta.args.indexOf('--add-dir') + 1], '/w/p1');
  assert.ok(!meta.args.includes('high'), 'Cursor takes no effort');
  assert.equal(meta.live, false);
  assert.equal(meta.transcriptDir, path.join(path.dirname(meta.stateFile), 'sessions', 'cursor'));
  // A full-access turn is the box user's Cursor (its HOME), with the chat's own config folder, where its sessions are.
  assert.deepEqual(meta.agentEnv, { CURSOR_CONFIG_DIR: path.join(path.dirname(meta.stateFile), 'cursor-config', 'p1--main') });
  // The message, and a notice of where the checkout is (its shell runs in the workspace).
  const sent = fs.readFileSync(path.join(b.procs.get(first.turnId).dir, 'prompt.txt'), 'utf8');
  assert.match(sent, /checked out at \/w\/p1/);
  assert.match(sent, /one\s*$/);
  b.finish(first.turnId, SESSION);
  await poll(r);
  const second = await r.sendMessage(job('two', { permissionMode: 'bypassPermissions' }));
  const meta2 = b.procs.get(second.turnId).meta;
  assert.deepEqual(meta2.args.slice(meta2.args.indexOf('--resume'), meta2.args.indexOf('--resume') + 2), ['--resume', SESSION]);
  assert.equal(meta2.args[meta2.args.indexOf('--workspace') + 1], ws);
  assert.equal(meta2.resumed, true);
  assert.ok(Number.isInteger(meta2.transcriptBytes) && meta2.transcriptBytes > 0, 'history cuts at where the transcript ended');
  b.finish(second.turnId, SESSION);
  await poll(r);
  const h = await r.history('p1--main');
  assert.equal(h.engine, 'cursor');
  assert.equal(h.sessionId, SESSION);
  assert.deepEqual(h.entries.map(e => e.type), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(h.entries[2].message.content, 'two');
  assert.equal(h.more, false);
  // Each turn's record keys on its own user line.
  assert.deepEqual(h.turns.map(t => t.userUuid), [`u-${first.turnId}`, `u-${second.turnId}`]);
  // The orchestrator's copy (chat-transcript-read) is that transcript, for the stored view and a new box.
  const read = await r.transcriptRead('p1--main', {});
  assert.equal(read.sessionId, SESSION);
  assert.ok(!read.missing);
  assert.match(Buffer.from(read.data, 'base64').toString('utf8'), /answer to two/);
});

test("cursor workspace: emptied before every turn, so nothing an earlier turn left (a planted .cursor/hooks.json) runs at the next one's start", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ws-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  const first = await r.sendMessage(job('one', { permissionMode: 'bypassPermissions' }));
  const meta = b.procs.get(first.turnId).meta;
  const ws = meta.args[meta.args.indexOf('--workspace') + 1];
  // What an open turn's shell could leave there.
  fs.mkdirSync(path.join(ws, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.cursor', 'hooks.json'), '{"version":1,"hooks":{"sessionStart":[{"command":"touch pwned"}]}}');
  fs.writeFileSync(path.join(ws, 'scratch.txt'), 'x');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
  fs.symlinkSync(outside, path.join(ws, 'link'));
  b.finish(first.turnId, SESSION);
  await poll(r);
  const second = await r.sendMessage(job('two'));
  const meta2 = b.procs.get(second.turnId).meta;
  assert.equal(meta2.args[meta2.args.indexOf('--workspace') + 1], ws, 'the same folder, so the session resumes');
  assert.deepEqual(fs.readdirSync(ws), []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'kept', 'a link goes as a link, never what it points at');
});

test("a confined cursor turn: a HOME of its own with none of the box user's hooks, made again each turn; the chat's config folder keeps only its sessions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  const root = path.join(home, '.termag', 'chats');
  const first = await r.sendMessage(job('one', { permissionMode: 'dontAsk' }));
  const meta = b.procs.get(first.turnId).meta;
  assert.equal(meta.mode, 'dontAsk');
  const scratch = path.join(root, 'cursor-homes', 'p1--main');
  const config = path.join(root, 'cursor-config', 'p1--main');
  assert.deepEqual(meta.agentEnv, { CURSOR_CONFIG_DIR: config, HOME: scratch });
  // What a turn (or any process of the box user's) could leave for the next: hooks in the scratch home, a looser
  // cli-config.json in the config folder, a link where the home goes. The sessions stay.
  fs.mkdirSync(path.join(scratch, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(scratch, '.cursor', 'hooks.json'), '{"version":1,"hooks":{"sessionStart":[{"command":"touch pwned"}]}}');
  fs.writeFileSync(path.join(config, 'cli-config.json'), '{"permissions":{"allow":["Shell(*)"]}}');
  fs.mkdirSync(path.join(config, 'chats', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(config, 'chats', 'abc', 'store.db'), 'session');
  b.finish(first.turnId, SESSION);
  await poll(r);
  const second = await r.sendMessage(job('two', { permissionMode: 'dontAsk' }));
  assert.deepEqual(b.procs.get(second.turnId).meta.agentEnv, { CURSOR_CONFIG_DIR: config, HOME: scratch });
  assert.ok(!fs.existsSync(path.join(scratch, '.cursor', 'hooks.json')), 'the home is made again');
  assert.deepEqual(fs.readdirSync(config), ['chats'], 'only the sessions stay');
  assert.equal(fs.readFileSync(path.join(config, 'chats', 'abc', 'store.db'), 'utf8'), 'session');
  b.finish(second.turnId, SESSION);
  await poll(r);
  // A link put where the home goes is taken away as a link, never what it points at.
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
  fs.rmSync(scratch, { recursive: true });
  fs.symlinkSync(outside, scratch);
  const third = await r.sendMessage(job('three', { permissionMode: 'auto' }));
  assert.equal(b.procs.get(third.turnId).meta.agentEnv.HOME, scratch, 'auto-review is confined too');
  assert.ok(!fs.lstatSync(scratch).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'kept');
});

test("cursorConfinedHome: the box user's Cursor login linked in, and nothing else (Linux's auth.json, macOS's keychain)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-login-'));
  const root = path.join(home, '.termag', 'chats');
  fs.mkdirSync(path.join(home, '.config', 'cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'cursor', 'auth.json'), '{}');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), '{"version":1,"hooks":{}}');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"hooks":{}}');
  const linux = cursorConfinedHome({ root, chatKey: 'k', home, env: {}, platform: 'linux' });
  assert.equal(fs.readlinkSync(path.join(linux, '.config', 'cursor', 'auth.json')), path.join(home, '.config', 'cursor', 'auth.json'));
  assert.ok(!fs.existsSync(path.join(linux, '.cursor')) && !fs.existsSync(path.join(linux, '.claude')), 'no hooks, no Claude settings');
  // With XDG_CONFIG_HOME set, cursor-agent finds the login there itself.
  const xdg = cursorConfinedHome({ root, chatKey: 'k', home, env: { XDG_CONFIG_HOME: path.join(home, '.config') }, platform: 'linux' });
  assert.deepEqual(fs.readdirSync(xdg), []);
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  const mac = cursorConfinedHome({ root, chatKey: 'k', home, env: {}, platform: 'darwin' });
  assert.equal(fs.readlinkSync(path.join(mac, 'Library', 'Keychains')), path.join(home, 'Library', 'Keychains'));
  assert.deepEqual(fs.readdirSync(mac), ['Library']);
});

test("a session another engine made (a Cursor chat restored on a new box as Claude's transcript) isn't resumed, and stays in history above the new one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-earlier-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  // What chat-session-restore leaves: the chat's state on a Claude session.
  const root = path.join(home, '.termag', 'chats');
  fs.mkdirSync(root, { recursive: true });
  const RESTORED = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(root, 'p1--main.json'), JSON.stringify({ sessionId: RESTORED, cwd: '/w/p1', engine: 'claude' }));
  const { turnId } = await r.sendMessage(job('after the move'));
  const meta = b.procs.get(turnId).meta;
  assert.ok(!meta.args.includes('--resume'), 'a Claude session is never resumed by Cursor');
  assert.deepEqual(meta.replaces, { sessionId: RESTORED, engine: 'claude' });
  // Until Cursor names its session, the chat's is still the restored one.
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'p1--main.json'), 'utf8')).sessionId, RESTORED);
  assert.ok(!fs.existsSync(path.join(root, 'p1--main.earlier.json')));
  b.finish(turnId, SESSION);
  await poll(r);
  const earlier = JSON.parse(fs.readFileSync(path.join(root, 'p1--main.earlier.json'), 'utf8'));
  assert.deepEqual(earlier.map(e => [e.sessionId, e.engine]), [[RESTORED, 'claude']]);
  // And it's no longer the current session, so history doesn't show it twice (as current and as earlier).
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'p1--main.json'), 'utf8')).sessionId, SESSION);
});

test("a switch to an engine that can't start leaves the chat on its session: the next send on its own engine resumes it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-switch-fail-'));
  const b = box();
  const r = cursorRunner(home, b, path.join(home, 'nowhere', 'cursor-agent'));
  const root = path.join(home, '.termag', 'chats');
  fs.mkdirSync(root, { recursive: true });
  const CLAUDE = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(root, 'p1--main.json'), JSON.stringify({ sessionId: CLAUDE, cwd: '/w/p1', engine: 'claude' }));
  const failed = await r.sendMessage(job('try cursor'));
  assert.equal(b.procs.has(failed.turnId), false, 'nothing started');
  await poll(r);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'p1--main.json'), 'utf8'));
  assert.deepEqual([state.sessionId, state.engine], [CLAUDE, 'claude']);
  assert.ok(!fs.existsSync(path.join(root, 'p1--main.earlier.json')), 'nothing moved to earlier');
  const next = await r.sendMessage(job('back on claude', { engine: 'claude' }));
  const meta = b.procs.get(next.turnId).meta;
  assert.deepEqual(meta.args.slice(meta.args.indexOf('--resume'), meta.args.indexOf('--resume') + 2), ['--resume', CLAUDE]);
  assert.equal(meta.replaces, undefined);
});

test("a Cursor session a switch to Claude left above keeps its history, read from the runner's transcript", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-switch-history-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  const first = await r.sendMessage(job('one'));
  b.finish(first.turnId, SESSION);
  await poll(r);
  const claude = await r.sendMessage(job('now claude', { engine: 'claude' }));
  const { meta, dir } = b.procs.get(claude.turnId);
  assert.deepEqual(meta.replaces, { sessionId: SESSION, engine: 'cursor' });
  // Before Claude names its session, the Cursor one is still the chat's, whole.
  const during = await r.history('p1--main');
  assert.equal(during.sessionId, SESSION);
  assert.match(JSON.stringify(during.entries), /answer to one/);
  const CLAUDE = '99999999-8888-4777-8666-555555555555';
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'system', subtype: 'init', session_id: CLAUDE })}\n`);
  await poll(r);
  const h = await r.history('p1--main');
  assert.equal(h.sessionId, CLAUDE);
  const text = JSON.stringify(h.entries);
  assert.match(text, /answer to one/, "the Cursor session's answer is still in history");
  assert.equal(text.match(/answer to one/g).length, 1, 'once');
  assert.ok(h.entries.some(e => e.type === 'context-cleared'));
});

test("an earlier Cursor session longer than history's cap reports its cut, so the session before it is not read and shows only its divider", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-earlier-cap-'));
  const b = box();
  const r = cursorRunner(home, b, path.join(home, 'cursor-agent'));
  const root = path.join(home, '.termag', 'chats');
  const sessions = path.join(root, 'sessions', 'cursor');
  fs.mkdirSync(sessions, { recursive: true });
  const OLDEST = '11111111-1111-4111-8111-111111111111';
  const LONG = '22222222-2222-4222-8222-222222222222';
  const line = (i, text) => `${JSON.stringify({ type: 'user', uuid: `u-${text}-${i}`, timestamp: '2026-11-12T18:00:00.000Z', message: { role: 'user', content: `${text} ${i}` } })}\n`;
  fs.writeFileSync(path.join(sessions, `${OLDEST}.jsonl`), line(0, 'from the oldest'));
  fs.writeFileSync(path.join(sessions, `${LONG}.jsonl`), Array.from({ length: 650 }, (_, i) => line(i, 'long')).join(''));
  fs.writeFileSync(path.join(root, 'p1--main.earlier.json'), JSON.stringify([
    { sessionId: OLDEST, clearedAt: '2026-11-12T17:00:00.000Z', engine: 'cursor' },
    { sessionId: LONG, clearedAt: '2026-11-12T19:00:00.000Z', engine: 'cursor' },
  ]));
  fs.writeFileSync(path.join(root, 'p1--main.json'), JSON.stringify({ sessionId: null, cwd: '/w/p1', engine: 'claude' }));
  const h = await r.history('p1--main');
  const text = JSON.stringify(h.entries);
  assert.ok(!text.includes('from the oldest'), "the oldest session's entries would sit above a gap");
  assert.match(text, /long 649/);
  assert.ok(!text.includes('"long 0"'), 'the long session is cut at the cap');
  assert.equal(h.entries.filter(e => e.type === 'context-cleared').length, 2, 'both dividers stay');
});

test('cursor send and context: no ask, backend or images; Clear, Compact and Open in full UI are not offered', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-refuse-'));
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const b = box();
  const r = cursorRunner(home, b, bin);
  await assert.rejects(r.sendMessage(job('x', { backend: 'fireworks', model: 'accounts/fireworks/models/x' })), /a Cursor turn takes no model backend/);
  const { turnId } = await r.sendMessage(job('one'));
  b.finish(turnId, SESSION);
  await poll(r);
  await assert.rejects(r.resetContext('p1--main', {}), /a Cursor chat cannot clear its context yet/);
  await assert.rejects(r.compact({ chatKey: 'p1--main', cwd: '/w/p1' }), /a Cursor chat cannot compact/);
  const claim = await r.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(claim.line, null);
  await r.releaseResume('p1--main');
});

test('cursor turn with no cursor-agent on the box: the turn ends with why, and starts nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-missing-'));
  const b = box();
  const r = cursorRunner(home, b, path.join(home, 'nowhere', 'cursor-agent'));
  const { turnId } = await r.sendMessage(job('one'));
  assert.equal(b.procs.has(turnId), false, 'nothing started');
  await poll(r);
  const h = await r.history('p1--main');
  assert.match(JSON.stringify(h), /cursor-agent is not installed on this box/);
});

// --- chat-turn.js itself, on the cursor engine ---

function cursorTurnDir(body, { prompt = 'review termag#12', agentEnv = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chat-turn-'));
  const bin = path.join(dir, 'cursor-agent');
  fs.writeFileSync(bin, `#!/bin/sh\n# stand-in for cursor-agent -p\n${body}\n`, { mode: 0o755 });
  const state = path.join(dir, 'state.json');
  const transcriptDir = path.join(dir, 'sessions', 'cursor');
  fs.writeFileSync(path.join(dir, 'prompt.txt'), `${prompt}\n`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    chatKey: 'k', bin, args: cursorTurnArgs(null, 'dontAsk', { workspace: path.join(dir, 'ws'), checkout: dir }), cwd: dir, path: process.env.PATH, text: prompt, resumed: false, stateFile: state, engine: 'cursor', transcriptDir, ...(agentEnv && { agentEnv }),
  }));
  return { dir, state, transcriptDir };
}
const eventsIn = dir => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const linesIn = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test("a real cursor turn: the message on stdin, Cursor's stream normalised into the log, its own lines kept, the session and transcript recorded", () => {
  const { dir, state, transcriptDir } = cursorTurnDir(`[ "$1" = -p ] || exit 98
read -r brief
[ "$brief" = "review termag#12" ] || exit 97
printf '%s\\n%s\\n' "$HOME" "$CURSOR_CONFIG_DIR" > "$(dirname "$0")/env-seen"
cat '${path.join(FIXTURES, 'tools-auto-review.jsonl')}'`, { agentEnv: { HOME: '/tmp/cursor-home-k', CURSOR_CONFIG_DIR: '/tmp/cursor-config-k' } });
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'env-seen'), 'utf8'), '/tmp/cursor-home-k\n/tmp/cursor-config-k\n', "cursor-agent runs with meta.agentEnv's HOME and config folder");
  const events = eventsIn(dir);
  assert.equal(events[0].type, 'turn-start');
  assert.equal(events[1].type, 'system');
  assert.equal(events[1].engine, 'cursor');
  assert.equal(events.find(e => e.type === 'result').is_error, false);
  assert.deepEqual(events.at(-1), { type: 'turn-end', exitCode: 0, signal: null });
  assert.ok(!events.some(e => e.type === 'runner-error'));
  assert.ok(fs.readFileSync(path.join(dir, 'cursor-events.jsonl'), 'utf8').includes('"grepToolCall"'), "Cursor's own lines, for diagnosis");
  const s = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(s.sessionId, FIXTURE_SESSION);
  assert.equal(s.engine, 'cursor');
  // The transcript: the message first, then every assistant and tool-result line, each with a uuid and a time.
  const lines = linesIn(path.join(transcriptDir, `${FIXTURE_SESSION}.jsonl`));
  assert.deepEqual(lines[0].message, { role: 'user', content: 'review termag#12\n' });
  assert.equal(lines[0].type, 'user');
  assert.equal(lines.length, 1 + events.filter(e => e.type === 'assistant' || (e.type === 'user' && e.message)).length);
  for (const l of lines) {
    assert.match(l.uuid, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(l.timestamp)));
  }
  assert.ok(lines.some(l => l.type === 'user' && Array.isArray(l.message.content) && l.message.content[0].type === 'tool_result'));
});

test('a real cursor turn that fails before its stream: cursor-agent\'s stderr is the error, and no session or transcript is kept', () => {
  const { dir, state, transcriptDir } = cursorTurnDir(`echo "⚠ Workspace Trust Required" >&2\nexit 1`);
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir]);
  const events = eventsIn(dir);
  assert.deepEqual(events.map(e => e.type), ['turn-start', 'runner-error', 'turn-end']);
  assert.match(events[1].message, /^Cursor exited 1: ⚠ Workspace Trust Required/);
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.existsSync(transcriptDir), false);
});
