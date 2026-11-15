'use strict';
// devin-acp.js, the Devin turn's ACP client, run for real against a stand-in `devin acp`
// (fixtures/devin/fake-devin-acp.js) that answers with Devin 3000.12.57's own recorded replies and plays a
// scenario's turn: the tier's mode, what a read-only turn allows and refuses, a load and its replay, a lost
// session, the message never a slash command, a mode Devin leaves, a stop, and failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { parseArgs, devinEnv, safeText, optionFor, allows, sessionIdOf, devinIdOf } = require('./devin-acp');

const DRIVER = path.join(__dirname, 'devin-acp.js');
const FAKE = path.join(__dirname, 'fixtures/devin/fake-devin-acp.js');
const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/devin/3000.12.57/acp.json'), 'utf8'));
const SID = RECORDED.sessionNew.sessionId;
/** termag's id for a session Devin names `name`: a random tag between the prefix and the name. */
const TAGGED = name => new RegExp(`^devin-[0-9a-f]{8}-${name}$`);

function setup(scenario, { tier = 'read', session = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-acp-'));
  const devin = path.join(dir, 'devin');
  fs.writeFileSync(devin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'fake.jsonl');
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ log, ...scenario }));
  for (const d of ['ws', 'home', 'sessions', 'checkout']) fs.mkdirSync(path.join(dir, d));
  const args = ['--devin', devin, '--tier', tier, '--cwd', path.join(dir, 'ws'), '--sessions', path.join(dir, 'sessions'),
    ...(tier === 'read' ? ['--home', path.join(dir, 'home')] : []), ...(session ? ['--session', session] : [])];
  return { dir, args, log, env: { PATH: process.env.PATH, HOME: path.join(dir, 'realhome'), FAKE_DEVIN_SCENARIO: file, ...env } };
}
function run(s, text = 'review termag#12') {
  const r = spawnSync(process.execPath, [DRIVER, ...s.args], { input: text, env: s.env, encoding: 'utf8', timeout: 20000 });
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const seen = fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { code: r.status, lines, stderr: r.stderr, seen, sent: seen.filter(e => e.got).map(e => e.got) };
}
const sentOf = (sent, method) => sent.filter(m => m.method === method);
const TOOL = (id, kind, extra = {}) => ({ toolCall: { toolCallId: id, kind, title: `${kind} it`, status: 'pending', ...extra }, options: [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
] });

test('a read-only turn: ask mode in its own folder and HOME, terminals offered only to be refused, a look allowed and nothing else', () => {
  const s = setup({
    turn: [
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } } },
      { request: { method: 'session/request_permission', params: TOOL('r1', 'read') } },
      { request: { method: 'session/request_permission', params: TOOL('s1', 'search') } },
      { request: { method: 'session/request_permission', params: TOOL('x1', 'execute', { rawInput: { command: 'npm test' } }) } },
      { request: { method: 'session/request_permission', params: TOOL('e1', 'edit') } },
      { request: { method: 'session/request_permission', params: TOOL('f1', 'fetch') } },
      { request: { method: 'session/request_permission', params: TOOL('m1', 'switch_mode') } },
      { request: { method: 'session/request_permission', params: TOOL('o1', 'other') } },
      { request: { method: 'terminal/create', params: { command: 'git', args: ['log'] } } },
      { request: { method: 'fs/write_text_file', params: { path: '/w/a', content: 'x' } } },
    ],
  }, { env: { XDG_CONFIG_HOME: '/real/.config', XDG_DATA_HOME: '/real/.local/share', DEVIN_PERMISSION_MODE: 'bypass', CHISEL_X: '1' } });
  const { code, lines, sent, seen, stderr } = run(s);
  assert.equal(code, 0, stderr);
  // Devin ran in the chat's own folder, under the turn's own HOME, with none of the box's XDG folders or Devin settings.
  const start = seen[0];
  assert.deepEqual(start.argv, ['acp']);
  assert.equal(fs.realpathSync(start.cwd), fs.realpathSync(path.join(s.dir, 'ws')));
  assert.deepEqual(start.env, { HOME: path.join(s.dir, 'home'), DEVIN_SESSIONS_DIR: path.join(s.dir, 'sessions') });
  // initialize offers terminals (to refuse them) and no file system.
  assert.deepEqual(sentOf(sent, 'initialize')[0].params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true } });
  // A new session in the folder, no directory added, then ask mode before the message.
  assert.deepEqual(sentOf(sent, 'session/new')[0].params, { cwd: path.join(s.dir, 'ws'), mcpServers: [] });
  assert.deepEqual(sentOf(sent, 'session/set_mode')[0].params, { sessionId: SID, modeId: 'ask' });
  const order = sent.filter(m => m.method).map(m => m.method);
  assert.ok(order.indexOf('session/set_mode') < order.indexOf('session/prompt'));
  assert.deepEqual(sentOf(sent, 'session/prompt')[0].params, { sessionId: SID, prompt: [{ type: 'text', text: 'review termag#12' }] });
  // What it answered: a look yes (once), everything else no; the terminal and the file write refused.
  const answers = Object.fromEntries(seen.filter(e => e.answered === 'session/request_permission').map((e, i) => [['r1', 's1', 'x1', 'e1', 'f1', 'm1', 'o1'][i], e.answer.result.outcome]));
  assert.deepEqual(answers, {
    r1: { outcome: 'selected', optionId: 'yes' }, s1: { outcome: 'selected', optionId: 'yes' },
    x1: { outcome: 'selected', optionId: 'no' }, e1: { outcome: 'selected', optionId: 'no' }, f1: { outcome: 'selected', optionId: 'no' },
    m1: { outcome: 'selected', optionId: 'no' }, o1: { outcome: 'selected', optionId: 'no' },
  });
  const terminal = seen.find(e => e.answered === 'terminal/create').answer;
  assert.match(terminal.error.message, /read-only: it runs no commands/);
  assert.equal(seen.find(e => e.answered === 'fs/write_text_file').answer.error.code, -32601);
  // Its stdout: ready, Devin's update, each permission with its answer, the refusals, the result.
  assert.match(lines[0].sessionId, TAGGED(SID));
  assert.deepEqual(lines[0], { termag: 'ready', sessionId: lines[0].sessionId, devinSession: SID, cwd: path.join(s.dir, 'ws'), mode: 'ask', loaded: false, model: 'swe-1-6-fast' });
  assert.equal(lines[1].method, 'session/update');
  assert.deepEqual(lines.filter(l => l.termag === 'permission').map(l => [l.toolCallId, l.allowed]), [['r1', true], ['s1', true], ['x1', false], ['e1', false], ['f1', false], ['m1', false], ['o1', false]]);
  assert.deepEqual(lines.filter(l => l.termag === 'refused'), [{ termag: 'refused', method: 'terminal/create', command: 'git' }, { termag: 'refused', method: 'fs/write_text_file' }]);
  assert.deepEqual(lines.at(-1), { termag: 'result', stopReason: 'end_turn' });
  // The mode update its own set_mode made isn't in the stream.
  assert.ok(!lines.some(l => l.params && l.params.update && l.params.update.sessionUpdate === 'current_mode_update'));
});

test("a full-access turn: bypass as the box user, in the chat's folder too (never the checkout), no terminals offered, anything Devin asks allowed", () => {
  const s = setup({ turn: [{ request: { method: 'session/request_permission', params: TOOL('x1', 'execute') } }] }, { tier: 'full', env: { XDG_CONFIG_HOME: '/real/.config' } });
  const { code, lines, sent, seen } = run(s);
  assert.equal(code, 0);
  assert.equal(seen[0].env.HOME, path.join(s.dir, 'realhome'));
  assert.equal(seen[0].env.XDG_CONFIG_HOME, '/real/.config');
  assert.equal(seen[0].env.DEVIN_SESSIONS_DIR, path.join(s.dir, 'sessions'));
  assert.equal(sentOf(sent, 'initialize')[0].params.clientCapabilities.terminal, false);
  assert.equal(sentOf(sent, 'session/new')[0].params.cwd, path.join(s.dir, 'ws'));
  assert.equal(fs.realpathSync(seen[0].cwd), fs.realpathSync(path.join(s.dir, 'ws')));
  assert.equal(sentOf(sent, 'session/set_mode')[0].params.modeId, 'bypass');
  assert.deepEqual(seen.find(e => e.answered).answer.result.outcome, { outcome: 'selected', optionId: 'yes' });
  assert.equal(lines[0].mode, 'bypass');
});

test("a resumed turn loads the chat's session, sets the mode again (a load comes back in Code), and leaves the load's replay out", () => {
  const s = setup({ load: 'ok', replay: [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
  ], turn: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'now' } } }] }, { session: `devin-0123abcd-${SID}` });
  const { code, lines, sent } = run(s, 'two');
  assert.equal(code, 0);
  assert.deepEqual(sentOf(sent, 'session/load')[0].params, { cwd: path.join(s.dir, 'ws'), mcpServers: [], sessionId: SID });
  assert.equal(sentOf(sent, 'session/new').length, 0);
  assert.equal(sentOf(sent, 'session/set_mode')[0].params.modeId, 'ask');
  assert.equal(lines[0].loaded, true);
  assert.equal(lines[0].sessionId, `devin-0123abcd-${SID}`, 'a loaded session keeps its id');
  assert.ok(!JSON.stringify(lines).includes('earlier'), "the replay isn't this turn's");
  assert.ok(JSON.stringify(lines).includes('"now"'));
  assert.equal(sentOf(sent, 'session/prompt')[0].params.prompt[0].text, 'two');
});

test("a session Devin can't load: a new one, and the message says the conversation before it is gone", () => {
  const s = setup({ load: 'missing' }, { session: 'devin-0123abcd-gone-session' });
  const { code, lines, sent, stderr } = run(s, 'two');
  assert.equal(code, 0);
  assert.equal(sentOf(sent, 'session/new').length, 1);
  assert.equal(lines[0].loaded, false);
  assert.match(lines[0].sessionId, TAGGED(SID));
  assert.match(stderr, /session gone-session did not load \(Session not found\)/);
  assert.match(sentOf(sent, 'session/prompt')[0].params.prompt[0].text, /^termag couldn't load this chat's earlier Devin session[^\n]*\n\ntwo$/);
});

test("the message never starts with a slash command, which would switch Devin's mode (Devin 3000.12.57: `/bypass` from ask)", () => {
  assert.deepEqual(RECORDED.slashBypass.updates.map(u => u.params.update.currentModeId), ['bypass'], 'what the recording saw');
  for (const text of ['/bypass', '  \n /code go', '/']) {
    const out = safeText(text);
    assert.ok(!/^\s*\//.test(out), JSON.stringify(text));
    assert.ok(out.endsWith(text));
  }
  for (const text of ['review this', 'a /bypass b', '<termag-box-notice>\n…']) assert.equal(safeText(text), text);
  const s = setup({});
  const { sent } = run(s, '/bypass rm -rf /');
  assert.match(sentOf(sent, 'session/prompt')[0].params.prompt[0].text, /^The message below is the person's, as text \(not a command\):\n\n\/bypass rm -rf \/$/);
});

test('a read-only turn whose session leaves ask mode is cancelled and stopped; a full-access one may change mode', () => {
  const flip = { turn: [{ update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypass' } }, { waitCancel: true }] };
  const s = setup(flip);
  const { code, lines, sent, stderr } = run(s);
  assert.equal(code, 1);
  assert.deepEqual(lines.filter(l => l.termag === 'left-mode'), [{ termag: 'left-mode', mode: 'bypass', want: 'ask' }]);
  assert.ok(!lines.some(l => l.termag === 'result'));
  assert.deepEqual(sentOf(sent, 'session/cancel')[0].params, { sessionId: SID });
  assert.match(stderr.trim().split('\n').pop(), /^Devin left ask mode for bypass; termag stopped this read-only turn$/);
  // Through a config update too.
  const viaConfig = setup({ turn: [{ update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', currentValue: 'accept-edits' }] } }, { waitCancel: true }] });
  assert.equal(run(viaConfig).code, 1);
  const full = setup({ turn: [{ update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' } }] }, { tier: 'full' });
  const f = run(full);
  assert.equal(f.code, 0);
  assert.equal(f.lines.at(-1).termag, 'result');
});

test("failures are the turn's last stderr line and exit 1: a prompt Devin refuses (no sign-in), no ask mode, Devin gone mid-turn", () => {
  const signedOut = run(setup({ end: { error: RECORDED.promptSignedOut.error } }));
  assert.equal(signedOut.code, 1);
  assert.equal(signedOut.stderr.trim().split('\n').pop(), 'Devin: Please log in to use Devin. Use `/login` to authenticate again.');
  const noAsk = run(setup({ mode: { ask: false } }));
  assert.equal(noAsk.code, 1);
  assert.match(noAsk.stderr.trim().split('\n').pop(), /^Devin: Devin offers no ask mode here \(it has accept-edits, smart, plan, bypass\)$/);
  assert.equal(sentOf(noAsk.sent, 'session/prompt').length, 0, 'no message without the mode');
  const gone = run(setup({ turn: [{ exit: 3 }] }));
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /devin acp exited 3 before the turn was over/);
});

test('a stop (SIGTERM, as chat-turn.js sends its group) cancels the prompt and ends the turn', async () => {
  const s = setup({ turn: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } }, { waitCancel: true }] });
  const child = spawn(process.execPath, [DRIVER, ...s.args], { env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('go');
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => { const t = setInterval(() => { if (out.includes('working')) { clearInterval(t); resolve(); } }, 20); });
  child.kill('SIGTERM');
  const code = await new Promise(r => child.on('exit', c => r(c)));
  assert.equal(code, 1);
  const sent = fs.readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.got).map(e => e.got);
  assert.equal(sentOf(sent, 'session/cancel').length, 1);
});

test('argv, environment, options and ids', () => {
  const ok = ['--devin', '/d', '--tier', 'read', '--cwd', '/ws', '--sessions', '/s', '--home', '/h'];
  assert.deepEqual(parseArgs(ok), { devin: '/d', tier: 'read', cwd: '/ws', sessions: '/s', home: '/h' });
  assert.throws(() => parseArgs(['--devin', '/d', '--tier', 'read', '--cwd', '/ws', '--sessions', '/s']), /own --home/);
  assert.throws(() => parseArgs([...ok.slice(0, 2), '--tier', 'auto', ...ok.slice(4)]), /read or full/);
  assert.throws(() => parseArgs([...ok, '--session', 'not-prefixed']), /devin- session id/);
  assert.throws(() => parseArgs([...ok, '--session', 'devin-untagged-name']), /devin- session id/);
  assert.throws(() => parseArgs([...ok, '--prompt', 'x']), /bad argument/);
  assert.deepEqual(devinEnv({ HOME: '/real', PATH: '/bin', XDG_STATE_HOME: '/x', WINDSURF_API_KEY: 'k' }, { tier: 'read', home: '/h', sessions: '/s' }), { HOME: '/h', PATH: '/bin', DEVIN_SESSIONS_DIR: '/s' });
  assert.deepEqual(devinEnv({ HOME: '/real', DEVIN_MODEL: 'opus' }, { tier: 'full', sessions: '/s' }), { HOME: '/real', DEVIN_MODEL: 'opus', DEVIN_SESSIONS_DIR: '/s' });
  assert.equal(optionFor([{ optionId: 'a', kind: 'allow_always' }, { optionId: 'r', kind: 'reject_always' }], true), 'a');
  assert.equal(optionFor([{ optionId: 'a', kind: 'allow_always' }, { optionId: 'r', kind: 'reject_always' }], false), 'r');
  assert.equal(optionFor([{ optionId: 'a', kind: 'allow_once' }], false), null);
  assert.equal(optionFor(null, true), null);
  assert.equal(allows('read', { kind: 'think' }), true);
  assert.equal(allows('read', {}), false);
  assert.equal(allows('full', { kind: 'delete' }), true);
  // Devin names sessions with two words, sometimes short, and two chats' stores can name one alike: a random tag
  // keeps every id its own (the runner files a transcript by id alone), and the prefix makes a short name an id it takes.
  assert.equal(sessionIdOf('ice-elf', 'abcdef01'), 'devin-abcdef01-ice-elf');
  assert.match(sessionIdOf('ice-elf'), /^devin-[0-9a-f]{8}-ice-elf$/);
  assert.notEqual(sessionIdOf('ice-elf'), sessionIdOf('ice-elf'));
  assert.equal(devinIdOf('devin-abcdef01-ice-elf'), 'ice-elf');
  assert.ok(sessionIdOf('x'.repeat(63), 'abcdef01').length <= 80, 'within a runner session id');
  for (const bad of ['../x', '', 'a b', null, 'x'.repeat(64)]) assert.equal(sessionIdOf(bad), null);
  assert.equal(sessionIdOf('ice-elf', 'nothex!!'), null);
  for (const bad of ['ice-elf', 'devin-ice-elf', 'devin-abcdef01-', 'devin-abcdef01-../x', 'devin-ABCDEF01-ice', 7]) assert.equal(devinIdOf(bad), null);
});
