'use strict';
// The chat runner's devin engine (chat-devin-v1): devinTurnArgs and the chat's folders, where the Devin CLI is
// found, chat-engine-check, the turn it starts and resumes (and a load that names a new session), and a real
// chat-turn.js run of devin-acp.js against a stand-in `devin acp` (fixtures/devin/fake-devin-acp.js), keeping the
// session's transcript for history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  CAPABILITIES, DEVIN_DRIVER, checkEngine, createChatRunner, devinChatDirs, devinNotice, devinTurnArgs, engineOf, resolveDevin,
} = require('./chat-runner');

const SESSION = 'devin-1f3a9c0e-somber-minnow';
const NEW_SESSION = 'devin-2b4d6f80-zany-tumble';

test('devin engine: chat-devin-v1 is advertised, and a send may name it', () => {
  assert.ok(CAPABILITIES.includes('chat-devin-v1'));
  assert.equal(engineOf({ engine: 'devin' }), 'devin');
});

const DIRS = { sessions: '/h/.termag/chats/devin/k/sessions', workspace: '/h/.termag/chats/devin/k/workspace', home: '/h/.termag/chats/devin/k/home' };

test("devinTurnArgs: the driver under node in the chat's own folder (never the checkout), the read tier under its own HOME, the session of an earlier turn", () => {
  const read = devinTurnArgs(null, 'dontAsk', { devin: '/b/devin', dirs: DIRS, checkout: '/w/p1' });
  assert.deepEqual(read, [DEVIN_DRIVER, '--devin', '/b/devin', '--tier', 'read', '--cwd', DIRS.workspace, '--sessions', DIRS.sessions, '--home', DIRS.home]);
  // auto has no Devin tier: it runs read-only, as anything unknown does.
  assert.deepEqual(devinTurnArgs(null, 'auto', { devin: '/b/devin', dirs: DIRS, checkout: '/w/p1' }), read);
  assert.deepEqual(devinTurnArgs(null, 'acceptEdits', { devin: '/b/devin', dirs: DIRS, checkout: '/w/p1' }), read);
  const full = devinTurnArgs(SESSION, 'bypassPermissions', { devin: '/b/devin', dirs: { sessions: DIRS.sessions, workspace: DIRS.workspace }, checkout: '/w/p1' });
  assert.deepEqual(full, [DEVIN_DRIVER, '--devin', '/b/devin', '--tier', 'full', '--cwd', DIRS.workspace, '--sessions', DIRS.sessions, '--session', SESSION]);
  for (const args of [read, full, devinTurnArgs(SESSION, 'dontAsk', { devin: '/b/devin', dirs: DIRS, checkout: '/w/p1' })]) {
    // The checkout is never a turn's cwd: Devin runs that folder's (and its git root's) hooks, its own and seven other
    // tools', which the own-tree check doesn't look at.
    assert.notEqual(args[args.indexOf('--cwd') + 1], '/w/p1');
    assert.ok(!args.some(a => /prompt/i.test(a)), 'the message is on stdin');
  }
  assert.throws(() => devinTurnArgs('c7f63169-1725-4620-9601-991ca50db6bc', 'dontAsk', { devin: '/b/devin', dirs: DIRS, checkout: '/w/p1' }), /Devin session id/);
  assert.throws(() => devinTurnArgs(null, 'dontAsk', { devin: '/b/devin', dirs: { sessions: '/s', workspace: '/ws' }, checkout: '/w/p1' }), /own HOME/);
  assert.throws(() => devinTurnArgs(null, 'bypassPermissions', { devin: '/b/devin', dirs: { sessions: '/s' }, checkout: '/w/p1' }), /its folders/);
  assert.throws(() => devinTurnArgs(null, 'dontAsk', { devin: 'devin', dirs: DIRS, checkout: '/w/p1' }), /needs the Devin CLI/);
  assert.match(devinNotice('/w/p1', 'dontAsk'), /empty one termag keeps for this chat\. The repository is checked out at \/w\/p1: read its files there/);
  assert.match(devinNotice('/w/p1', 'bypassPermissions'), /empty one termag keeps for this chat\. The repository is checked out at \/w\/p1: work on its files there, by that path, and cd there before a shell command/);
});

test("devinChatDirs: the store kept; a read-only turn's folder and HOME made again, with an empty .git and only the login linked", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-dirs-'));
  const root = path.join(home, '.termag', 'chats');
  const login = path.join(home, '.local', 'share', 'devin', 'credentials.toml');
  fs.mkdirSync(path.dirname(login), { recursive: true });
  fs.writeFileSync(login, 'windsurf_api_key = "x"\n');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"hooks":{}}');
  const d = devinChatDirs({ root, chatKey: 'k', home, env: {}, readOnly: true });
  assert.deepEqual(d, { sessions: path.join(root, 'devin', 'k', 'sessions'), workspace: path.join(root, 'devin', 'k', 'workspace'), home: path.join(root, 'devin', 'k', 'home') });
  assert.deepEqual(fs.readdirSync(d.workspace), ['.git']);
  assert.deepEqual(fs.readdirSync(path.join(d.workspace, '.git')), []);
  assert.equal(fs.readlinkSync(path.join(d.home, '.local', 'share', 'devin', 'credentials.toml')), login);
  assert.deepEqual(fs.readdirSync(d.home), ['.local'], 'none of the box user\'s hooks or settings');
  // What a turn (or any process of the box user's) could leave for the next: hooks in the folder or the HOME. The sessions stay.
  fs.mkdirSync(path.join(d.workspace, '.claude'));
  fs.writeFileSync(path.join(d.workspace, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[]}}');
  fs.mkdirSync(path.join(d.home, '.config', 'devin'), { recursive: true });
  fs.writeFileSync(path.join(d.home, '.config', 'devin', 'config.json'), '{"hooks":{}}');
  fs.mkdirSync(path.join(d.sessions, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(d.sessions, 'cli', 'sessions.db'), 'db');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
  fs.symlinkSync(outside, path.join(d.workspace, 'link'));
  const again = devinChatDirs({ root, chatKey: 'k', home, env: {}, readOnly: true });
  assert.deepEqual(fs.readdirSync(again.workspace), ['.git']);
  assert.ok(!fs.existsSync(path.join(again.home, '.config')));
  assert.equal(fs.readFileSync(path.join(again.sessions, 'cli', 'sessions.db'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'kept', 'a link goes as a link, never what it points at');
  assert.equal(fs.readFileSync(login, 'utf8'), 'windsurf_api_key = "x"\n', 'remaking the HOME takes its link to the login, never the login');
  // A link put where a folder goes is taken away as a link.
  fs.rmSync(again.home, { recursive: true });
  fs.symlinkSync(outside, again.home);
  fs.rmSync(again.sessions, { recursive: true });
  fs.symlinkSync(outside, again.sessions);
  const third = devinChatDirs({ root, chatKey: 'k', home, env: {}, readOnly: true });
  assert.ok(!fs.lstatSync(third.home).isSymbolicLink() && !fs.lstatSync(third.sessions).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(outside).sort(), ['keep.txt']);
  // A full-access turn has the store and the folder, made again too (a turn of either tier could plant hooks there),
  // and the box user's HOME.
  const full = devinChatDirs({ root, chatKey: 'k2', home, env: {}, readOnly: false });
  assert.deepEqual(full, { sessions: path.join(root, 'devin', 'k2', 'sessions'), workspace: path.join(root, 'devin', 'k2', 'workspace') });
  fs.mkdirSync(path.join(full.workspace, '.claude'));
  fs.writeFileSync(path.join(full.workspace, '.claude', 'settings.json'), '{}');
  assert.deepEqual(fs.readdirSync(devinChatDirs({ root, chatKey: 'k2', home, env: {}, readOnly: true }).workspace), ['.git']);
  // The login under XDG_DATA_HOME, when it is set; none, nothing linked (Devin then says it isn't signed in).
  const xdg = path.join(home, 'xdg');
  fs.mkdirSync(path.join(xdg, 'devin'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'devin', 'credentials.toml'), 'x');
  const viaXdg = devinChatDirs({ root, chatKey: 'k3', home, env: { XDG_DATA_HOME: xdg }, readOnly: true });
  assert.equal(fs.readlinkSync(path.join(viaXdg.home, '.local', 'share', 'devin', 'credentials.toml')), path.join(xdg, 'devin', 'credentials.toml'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-bare-'));
  assert.deepEqual(fs.readdirSync(devinChatDirs({ root: path.join(bare, 'r'), chatKey: 'k', home: bare, env: {}, readOnly: true }).home), []);
});

test('resolveDevin and chat-engine-check: the override, the installer\'s ~/.local/bin, then PATH; no CLI or no login is the reason', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-resolve-'));
  assert.equal(resolveDevin({ home, env: { TERMAG_CHAT_DEVIN: '/x/devin' } }), '/x/devin');
  assert.equal(resolveDevin({ home, env: {} }), 'devin');
  assert.deepEqual(await checkEngine({ engine: 'devin' }, { home, env: {} }), {
    ok: false, engine: 'devin', code: 'launcher-missing', remedy: 'the Devin CLI is not installed on this box (its installer links it at ~/.local/bin/devin)',
  });
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'devin'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveDevin({ home, env: { PATH: `/nonexistent:${dir}` } }), path.join(dir, 'devin'));
  const installed = path.join(home, '.local/bin/devin');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveDevin({ home, env: { PATH: dir } }), installed);
  assert.deepEqual(await checkEngine({ engine: 'devin' }, { home, env: {} }), {
    ok: false, engine: 'devin', code: 'auth-missing', remedy: 'Devin is not signed in on this box: run devin auth login in a terminal there',
  });
  fs.mkdirSync(path.join(home, '.local', 'share', 'devin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'share', 'devin', 'credentials.toml'), 'x');
  assert.deepEqual(await checkEngine({ engine: 'devin' }, { home, env: {} }), { ok: true, engine: 'devin' });
});

// --- the runner: the turn it starts on the devin engine ---

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
    /** The turn's init, as chat-turn.js writes it once devin-acp.js is ready (the runner reads it as the turn runs). */
    init: (turnId, sessionId) => {
      const { dir } = procs.get(turnId);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, engine: 'devin' })}\n`);
    },
    /** The rest of the turn as chat-turn.js ends it: a transcript line pair, result, the state file, turn-end, exit. */
    finish: (turnId, sessionId) => {
      const { meta, dir } = procs.get(turnId);
      fs.mkdirSync(meta.transcriptDir, { recursive: true });
      fs.appendFileSync(path.join(meta.transcriptDir, `${sessionId}.jsonl`), [
        { type: 'user', uuid: `u-${turnId}`, timestamp: '2026-11-14T15:00:00.000Z', message: { role: 'user', content: meta.text } },
        { type: 'assistant', uuid: `a-${turnId}`, timestamp: '2026-11-14T15:00:01.000Z', message: { id: `devin-${turnId}`, role: 'assistant', content: [{ type: 'text', text: `answer to ${meta.text}` }] } },
      ].map(l => `${JSON.stringify(l)}\n`).join(''));
      const lines = [{ type: 'result', is_error: false, session_id: sessionId }, { type: 'turn-end', exitCode: 0 }];
      fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd, engine: 'devin' }));
      fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.map(e => `${JSON.stringify(e)}\n`).join(''));
      fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
      sessions.delete(meta.session);
    },
    sessionAlive: async (name) => sessions.has(name),
    signalPid: () => {},
  };
}

function devinRunner(home, b, devinBin) {
  return createChatRunner({
    investigationFor: () => null,
    home, username: 'alice', claudeBin: '/bin/claude', devinBin, env: { PATH: '/usr/bin' },
    send: () => true, startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: b.signalPid,
    stopSession: async () => {}, interruptGraceMs: 5,
    readCheckout: async () => ({ repo: false }),
  });
}
const job = (text, extra = {}) => ({ chatKey: 'p1--review-12', cwd: '/w/p1', text, projectId: 'p1', workstream: 'review-12', engine: 'devin', ...extra });
async function poll(r) { await r.poll(); await r.poll(); }
function devinHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(home, 'devin');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return { home, bin };
}

test("devin turn: devin-acp.js under node, read-only in the chat's own folder, the checkout's path in the message; then the session Devin named; the runner's transcript is its history", async () => {
  const { home, bin } = devinHome('devin-turn-');
  const b = box();
  const r = devinRunner(home, b, bin);
  const first = await r.sendMessage(job('/bypass review it', { permissionMode: 'dontAsk', model: 'opus', effort: 'high' }));
  const { meta, dir } = b.procs.get(first.turnId);
  assert.equal(meta.bin, process.execPath);
  assert.equal(meta.args[0], DEVIN_DRIVER);
  assert.equal(meta.engine, 'devin');
  assert.equal(meta.mode, 'dontAsk');
  const root = path.dirname(meta.stateFile);
  assert.deepEqual(meta.args.slice(1), ['--devin', bin, '--tier', 'read', '--cwd', path.join(root, 'devin', 'p1--review-12', 'workspace'), '--sessions', path.join(root, 'devin', 'p1--review-12', 'sessions'), '--home', path.join(root, 'devin', 'p1--review-12', 'home')]);
  assert.ok(!meta.args.includes('opus') && !meta.args.includes('high'), 'no model or effort for Devin');
  assert.equal(meta.agentEnv, undefined, 'devin-acp.js makes its own environment for Devin');
  assert.equal(meta.live, false);
  assert.equal(meta.transcriptDir, path.join(root, 'sessions', 'devin'));
  assert.equal(meta.replaces, undefined, 'a first turn takes over from nothing');
  // The notice leads (so the message never starts with a slash command) and says where the checkout is.
  const sent = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  assert.ok(!/^\s*\//.test(sent));
  assert.match(sent, /checked out at \/w\/p1: read its files there/);
  assert.match(sent, /\/bypass review it\s*$/);
  b.init(first.turnId, SESSION);
  b.finish(first.turnId, SESSION);
  await poll(r);
  const second = await r.sendMessage(job('two', { permissionMode: 'dontAsk' }));
  const meta2 = b.procs.get(second.turnId).meta;
  assert.deepEqual(meta2.args.slice(-2), ['--session', SESSION]);
  assert.equal(meta2.resumed, true);
  // A load may fail and name a new session: the one it was given would go to earlier then.
  assert.deepEqual(meta2.replaces, { sessionId: SESSION, engine: 'devin' });
  assert.ok(Number.isInteger(meta2.transcriptBytes) && meta2.transcriptBytes > 0);
  // While it runs, having loaded the same session, history is the session's first turn and this one's replay.
  b.init(second.turnId, SESSION);
  await poll(r);
  const during = await r.history('p1--review-12');
  assert.deepEqual(during.entries.map(e => e.type), ['user', 'assistant']);
  b.finish(second.turnId, SESSION);
  await poll(r);
  const h = await r.history('p1--review-12');
  assert.equal(h.engine, 'devin');
  assert.equal(h.sessionId, SESSION);
  assert.deepEqual(h.entries.map(e => e.type), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(!h.entries.some(e => e.type === 'context-cleared'), 'a load that worked moves nothing to earlier');
  const read = await r.transcriptRead('p1--review-12', {});
  assert.equal(read.sessionId, SESSION);
  assert.match(Buffer.from(read.data, 'base64').toString('utf8'), /answer to two/);
});

test("a load Devin can't do names a new session: the one before goes to earlier and stays in history, and the running turn is drawn once", async () => {
  const { home, bin } = devinHome('devin-lost-');
  const b = box();
  const r = devinRunner(home, b, bin);
  const first = await r.sendMessage(job('one'));
  b.init(first.turnId, SESSION);
  b.finish(first.turnId, SESSION);
  await poll(r);
  const second = await r.sendMessage(job('two'));
  b.init(second.turnId, NEW_SESSION);
  await poll(r);
  // The turn writes its own session's transcript as it goes: drawn from the turn's log, not twice.
  const { meta } = b.procs.get(second.turnId);
  fs.mkdirSync(meta.transcriptDir, { recursive: true });
  fs.appendFileSync(path.join(meta.transcriptDir, `${NEW_SESSION}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'u-new', timestamp: '2026-11-14T15:01:00.000Z', message: { role: 'user', content: 'two' } })}\n`);
  const during = await r.history('p1--review-12');
  assert.equal(during.sessionId, NEW_SESSION);
  const texts = during.entries.filter(e => e.type === 'user' && typeof e.message.content === 'string').map(e => e.message.content);
  assert.deepEqual(texts, ['one'], 'the earlier session, then the running turn from its log');
  assert.ok(during.entries.some(e => e.type === 'context-cleared'));
  fs.rmSync(path.join(meta.transcriptDir, `${NEW_SESSION}.jsonl`));
  b.finish(second.turnId, NEW_SESSION);
  await poll(r);
  const h = await r.history('p1--review-12');
  assert.equal(h.sessionId, NEW_SESSION);
  assert.deepEqual(h.entries.filter(e => e.type === 'user').map(e => e.message.content), ['one', 'two']);
  const third = await r.sendMessage(job('three'));
  assert.deepEqual(b.procs.get(third.turnId).meta.args.slice(-2), ['--session', NEW_SESSION]);
});

test("a full-access devin turn: as the box user, in the chat's folder, the checkout by its path", async () => {
  const { home, bin } = devinHome('devin-full-');
  const b = box();
  const r = devinRunner(home, b, bin);
  const { turnId } = await r.sendMessage(job('fix it', { permissionMode: 'bypassPermissions' }));
  const { meta, dir } = b.procs.get(turnId);
  // readCheckout says no repository, which the owner's tick is enough for.
  assert.equal(meta.mode, 'bypassPermissions');
  assert.deepEqual(meta.args.slice(3, 7), ['--tier', 'full', '--cwd', path.join(path.dirname(meta.stateFile), 'devin', 'p1--review-12', 'workspace')]);
  assert.ok(!meta.args.includes('--home'));
  assert.match(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'), /checked out at \/w\/p1: work on its files there/);
});

test('devin send and context: no ask, backend or images; Clear and Compact are not offered', async () => {
  const { home, bin } = devinHome('devin-refuse-');
  const r = devinRunner(home, box(), bin);
  await assert.rejects(r.sendMessage(job('x', { backend: 'fireworks' })), /engine-refused: a Devin turn takes no model backend/);
  await assert.rejects(r.sendMessage(job('x', { images: [{ mediaType: 'image/png', data: Buffer.from('x').toString('base64') }] })), /engine-refused|image/);
});

test('devin turn with no Devin CLI on the box: the turn ends with why, and starts nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-missing-'));
  const b = box();
  const r = devinRunner(home, b, path.join(home, 'nowhere', 'devin'));
  const { turnId } = await r.sendMessage(job('one'));
  assert.equal(b.procs.has(turnId), false, 'nothing started');
  await poll(r);
  assert.match(JSON.stringify(await r.history('p1--review-12')), /the Devin CLI is not installed on this box/);
});

// --- chat-turn.js itself, on the devin engine ---

function devinTurnDir(scenario, { prompt = 'review termag#12', session = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-chat-turn-'));
  const devin = path.join(dir, 'devin');
  fs.writeFileSync(devin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures/devin/fake-devin-acp.js')}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'fake.jsonl');
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ log, ...scenario }));
  const home = path.join(dir, 'home');
  const dirs = devinChatDirs({ root: path.join(home, '.termag', 'chats'), chatKey: 'k', home, env: {}, readOnly: true });
  const state = path.join(dir, 'state.json');
  const transcriptDir = path.join(dir, 'sessions', 'devin');
  fs.writeFileSync(path.join(dir, 'prompt.txt'), `${prompt}\n`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    chatKey: 'k', bin: process.execPath, args: devinTurnArgs(session, 'dontAsk', { devin, dirs, checkout: dir }), cwd: dir, path: process.env.PATH, text: prompt, resumed: false, stateFile: state, engine: 'devin', transcriptDir,
  }));
  return { dir, state, transcriptDir, env: { ...process.env, FAKE_DEVIN_SCENARIO: path.join(dir, 'scenario.json') } };
}
const eventsIn = dir => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const linesIn = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test("a real devin turn: the message on stdin, the driver's stream normalised into the log, its own lines kept, the session and transcript recorded", () => {
  const t = devinTurnDir({ turn: [
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the diff.' } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', title: 'Read a.js', status: 'in_progress', locations: [{ path: '/w/a.js' }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'let a;' } }] } },
    { request: { method: 'session/request_permission', params: { toolCall: { toolCallId: 'c2', kind: 'execute', title: 'npm test' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } } },
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looks fine.' } } },
  ] });
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), t.dir], { env: t.env });
  const events = eventsIn(t.dir);
  assert.equal(events[0].type, 'turn-start');
  const sessionId = events[1].session_id;
  assert.match(sessionId, /^devin-[0-9a-f]{8}-somber-minnow$/, "Devin's name, tagged");
  assert.deepEqual(events[1], { type: 'system', subtype: 'init', session_id: sessionId, cwd: path.join(t.dir, 'home', '.termag', 'chats', 'devin', 'k', 'workspace'), model: 'swe-1-6-fast', engine: 'devin' });
  const result = events.find(e => e.type === 'result');
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'Looks fine.');
  assert.deepEqual(events.at(-1), { type: 'turn-end', exitCode: 0, signal: null });
  assert.ok(!events.some(e => e.type === 'runner-error'));
  const denied = events.flatMap(e => (e.type === 'user' ? e.message.content : [])).find(c => c.tool_use_id === 'c2');
  assert.equal(denied.is_error, true);
  assert.ok(fs.readFileSync(path.join(t.dir, 'devin-events.jsonl'), 'utf8').includes('"termag":"permission"'), "the driver's own lines, for diagnosis");
  const s = JSON.parse(fs.readFileSync(t.state, 'utf8'));
  assert.equal(s.sessionId, sessionId);
  assert.equal(s.engine, 'devin');
  const lines = linesIn(path.join(t.transcriptDir, `${sessionId}.jsonl`));
  assert.deepEqual(lines[0].message, { role: 'user', content: 'review termag#12\n' });
  assert.equal(lines.length, 1 + events.filter(e => e.type === 'assistant' || (e.type === 'user' && e.message)).length);
});

test("a real devin turn Devin refuses (not signed in): its message is the error, the session kept for the next turn", () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/devin/3000.12.57/acp.json'), 'utf8'));
  const t = devinTurnDir({ end: { error: recorded.promptSignedOut.error } });
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), t.dir], { env: t.env });
  const events = eventsIn(t.dir);
  assert.deepEqual(events.map(e => e.type), ['turn-start', 'system', 'runner-error', 'turn-end']);
  assert.equal(events[2].message, 'Devin exited 1: Devin: Please log in to use Devin. Use `/login` to authenticate again.');
});
