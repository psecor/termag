'use strict';
// pane-subagents.js: which session a pane's Claude is on, its subagents, and
// the sessions running alongside it, from a temp home with a fake tmux and ps.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPaneSubagents, parsePs, treeOf, withoutImages } = require('./pane-subagents');
const { slugForCwd } = require('./chat-runner');

const START = 'Thu Nov  5 11:37:53 2026';
const startMs = Date.parse(START);
const PANE_SID = '13013c9a-894d-42b2-9d67-3e918a88fb3c';
const SIDE_SID = '496bb91b-2f1d-42c9-a973-a47b0e6600fc';
const AGENT = 'ac9afc6661520867b';

function scene() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-subagents-'));
  const cwd = path.join(home, 'termag/projects/sample');
  fs.mkdirSync(cwd, { recursive: true });
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const proj = path.join(home, '.claude/projects', slugForCwd(cwd));
  fs.mkdirSync(path.join(proj, PANE_SID, 'subagents'), { recursive: true });
  const session = (pid, sid, over = {}) => fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({
    pid, sessionId: sid, cwd, startedAt: startMs + 2000, kind: 'interactive', entrypoint: 'cli', ...over,
  }));
  const line = o => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(path.join(proj, `${PANE_SID}.jsonl`), line({ type: 'user', message: { role: 'user', content: 'Fan out' } }));
  fs.writeFileSync(path.join(proj, `${SIDE_SID}.jsonl`),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' } })
    + line({ type: 'user', timestamp: '2026-11-05T16:40:00.000Z', message: { role: 'user', content: 'Review the flag registry' } })
    + line({ type: 'assistant', timestamp: '2026-11-05T16:40:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading it now.' }] } }));
  const sub = path.join(proj, PANE_SID, 'subagents');
  fs.writeFileSync(path.join(sub, `agent-${AGENT}.jsonl`),
    line({ isSidechain: true, type: 'user', timestamp: '2026-11-05T16:41:00.000Z', message: { role: 'user', content: 'Find the flaky tests' } })
    + line({ isSidechain: true, type: 'assistant', timestamp: '2026-11-05T16:41:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Two are flaky: a and b.' }] } }));
  fs.writeFileSync(path.join(sub, `agent-${AGENT}.meta.json`), JSON.stringify({
    agentType: 'Explore', description: 'Find flaky tests', toolUseId: 'toolu_01', requestShape: 'background', model: 'sonnet', finished: true,
  }));
  return { home, cwd, session, proj };
}

// The pane's shell 100, its claude 101 (and 102, a Bash tool's child of it); 200 a claude in the ctrl pane.
const psOut = rows => rows.map(([pid, ppid, start = START]) => `${pid} ${ppid} ${start}`).join('\n');
const PROCS = psOut([[1, 0], [100, 1], [101, 100], [102, 101], [200, 1], [300, 1]]);

function runner(home, { panePid = 100, ps = PROCS } = {}) {
  return createPaneSubagents({
    home,
    tmux: async args => {
      assert.deepStrictEqual(args.slice(0, 4), ['display-message', '-p', '-t', '=jonnyd-sample-agent:']);
      if (panePid == null) throw new Error("can't find session");
      return { stdout: `${panePid}\n` };
    },
    ps: async () => ({ stdout: ps }),
  });
}

test('parsePs reads pids, parents and start times; treeOf walks a pane down, nearest first', () => {
  const procs = parsePs(`  100     1 ${START}\n  101   100 ${START}\n  bad line\n`);
  assert.deepStrictEqual([...procs.keys()], [100, 101]);
  assert.strictEqual(procs.get(101).start, startMs);
  assert.deepStrictEqual(treeOf(parsePs(PROCS), 100), [100, 101, 102]);
});

test('the pane\'s session is the session file of the Claude under its shell, with its subagents', async () => {
  const { home, cwd, session } = scene();
  session(101, PANE_SID);
  const r = await runner(home).list('jonnyd-sample-agent');
  assert.strictEqual(r.running, true);
  assert.deepStrictEqual(r.session, { sessionId: PANE_SID, cwd, startedAt: startMs + 2000 });
  assert.strictEqual(r.subagents.length, 1);
  assert.deepStrictEqual({ ...r.subagents[0], updatedAt: undefined }, {
    agentId: AGENT, toolUseId: 'toolu_01', agentType: 'Explore', description: 'Find flaky tests', background: true, model: 'sonnet',
    finished: true, startedAt: '2026-11-05T16:41:00.000Z', updatedAt: undefined, prompt: 'Find the flaky tests', report: 'Two are flaky: a and b.',
  });
  assert.deepStrictEqual(r.alongside, []);
});

test('a subagent still going has no report, and one with no meta yet is listed plainly', async () => {
  const { home, session, proj } = scene();
  session(101, PANE_SID);
  const sub = path.join(proj, PANE_SID, 'subagents');
  fs.writeFileSync(path.join(sub, `agent-${AGENT}.meta.json`), JSON.stringify({ description: 'Find flaky tests', finished: false }));
  fs.writeFileSync(path.join(sub, 'agent-b2.jsonl'), `${JSON.stringify({ isSidechain: true, type: 'user', message: { role: 'user', content: 'Check the registry' } })}\n`);
  const r = await runner(home).list('jonnyd-sample-agent');
  const byId = Object.fromEntries(r.subagents.map(s => [s.agentId, s]));
  assert.strictEqual(byId[AGENT].finished, false);
  assert.strictEqual(byId[AGENT].report, null);
  assert.strictEqual(byId.b2.description, null);
  assert.strictEqual(byId.b2.prompt, 'Check the registry');
});

test('a resumed session\'s subagents come from every directory it wrote them in, each once', async () => {
  const { home, session, proj } = scene();
  session(101, PANE_SID);
  const other = path.join(home, '.claude/projects', 'other-dir', PANE_SID, 'subagents');
  fs.mkdirSync(other, { recursive: true });
  const line = o => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(path.join(other, 'agent-later.jsonl'), line({ isSidechain: true, type: 'user', message: { role: 'user', content: 'Later' } }));
  // A copy of the first one, older than the original.
  fs.copyFileSync(path.join(proj, PANE_SID, 'subagents', `agent-${AGENT}.jsonl`), path.join(other, `agent-${AGENT}.jsonl`));
  fs.utimesSync(path.join(other, `agent-${AGENT}.jsonl`), new Date(0), new Date(0));
  const r = await runner(home).list('jonnyd-sample-agent');
  assert.deepStrictEqual(r.subagents.map(s => s.agentId).sort(), [AGENT, 'later'].sort());
  assert.strictEqual(r.subagents.find(s => s.agentId === AGENT).description, 'Find flaky tests');
  // The copy read is the one listed: the newest. Make the other directory's the newer, and different.
  fs.writeFileSync(path.join(other, `agent-${AGENT}.jsonl`), line({ isSidechain: true, type: 'user', message: { role: 'user', content: 'Resumed copy' } }));
  const read = await runner(home).readSubagent('jonnyd-sample-agent', AGENT);
  assert.deepStrictEqual(read.entries.map(e => e.message.content), ['Resumed copy']);
});

test('a session alongside under another spelling of the directory (a symlink) is read from its own slug', async () => {
  const { home, cwd, session } = scene();
  const alias = path.join(home, 'alias');
  fs.symlinkSync(cwd, alias);
  session(101, PANE_SID);
  session(200, SIDE_SID, { cwd: alias });
  const aliasProj = path.join(home, '.claude/projects', slugForCwd(alias));
  fs.mkdirSync(aliasProj, { recursive: true });
  fs.renameSync(path.join(home, '.claude/projects', slugForCwd(cwd), `${SIDE_SID}.jsonl`), path.join(aliasProj, `${SIDE_SID}.jsonl`));
  const rpc = runner(home);
  const r = await rpc.list('jonnyd-sample-agent');
  assert.deepStrictEqual(r.alongside.map(a => [a.sessionId, a.title]), [[SIDE_SID, 'Review the flag registry']]);
  assert.strictEqual((await rpc.readSession('jonnyd-sample-agent', SIDE_SID)).found, true);
});

test('a session file older than the process it names is a reused pid\'s, and is passed over', async () => {
  const { home, session } = scene();
  session(101, PANE_SID, { startedAt: startMs - 60_000 });
  const r = await runner(home).list('jonnyd-sample-agent');
  assert.strictEqual(r.session, null);
  assert.deepStrictEqual(r.subagents, []);
});

test('no session file (an older Claude Code) is no session, never a guess', async () => {
  const { home } = scene();
  const r = await runner(home).list('jonnyd-sample-agent');
  assert.deepStrictEqual(r, { running: true, session: null, subagents: [], alongside: [] });
});

test('a pane that is gone says so', async () => {
  const { home } = scene();
  const r = await runner(home, { panePid: null }).list('jonnyd-sample-agent');
  assert.strictEqual(r.running, false);
});

test('running alongside: live interactive sessions in the same directory, outside the pane', async () => {
  const { home, session } = scene();
  session(101, PANE_SID);
  session(102, 'aaaaaaaa-0000-4000-8000-000000000001'); // the pane Claude's own child: not alongside
  session(200, SIDE_SID, { startedAt: startMs + 5000 }); // the ctrl pane's Claude: alongside
  session(300, 'bbbbbbbb-0000-4000-8000-000000000002', { entrypoint: 'sdk-cli' }); // a headless claude -p
  session(400, 'cccccccc-0000-4000-8000-000000000003'); // a dead process's file
  session(201, 'dddddddd-0000-4000-8000-000000000004', { cwd: path.join(home, 'elsewhere') });
  const r = await runner(home, { ps: psOut([[1, 0], [100, 1], [101, 100], [102, 101], [200, 1], [201, 1], [300, 1]]) }).list('jonnyd-sample-agent');
  assert.deepStrictEqual(r.alongside.map(a => a.sessionId), [SIDE_SID]);
  assert.strictEqual(r.alongside[0].title, 'Review the flag registry');
});

test('reads a subagent of the pane\'s session, and a session in the pane\'s directory, as history entries', async () => {
  const { home, session } = scene();
  session(101, PANE_SID);
  const rpc = runner(home);
  const sub = await rpc.readSubagent('jonnyd-sample-agent', AGENT);
  assert.strictEqual(sub.found, true);
  assert.deepStrictEqual(sub.entries.map(e => e.type), ['user', 'assistant']);
  assert.deepStrictEqual(await rpc.readSubagent('jonnyd-sample-agent', 'nope'), { found: false, entries: [] });
  const side = await rpc.readSession('jonnyd-sample-agent', SIDE_SID);
  assert.strictEqual(side.found, true);
  assert.deepStrictEqual(side.entries.map(e => e.message.content), ['Review the flag registry', [{ type: 'text', text: 'Reading it now.' }]]);
  assert.deepStrictEqual(await rpc.readSession('jonnyd-sample-agent', 'eeeeeeee-0000-4000-8000-000000000005'), { found: false, entries: [] });
});

test('refuses a session name, an agent id or a session id that could be a path', async () => {
  const { home } = scene();
  const rpc = runner(home);
  await assert.rejects(rpc.list('../x'), /bad session/);
  await assert.rejects(rpc.list('a:b'), /bad session/);
  await assert.rejects(rpc.readSubagent('jonnyd-sample-agent', '../../x'), /bad agentId/);
  await assert.rejects(rpc.readSession('jonnyd-sample-agent', '../x'), /bad sessionId/);
});

test('drops base64 images, a tool result\'s too', () => {
  const e = { type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }] },
    { type: 'text', text: 'hi' },
  ] } };
  const out = withoutImages(e);
  assert.deepStrictEqual(out.message.content[0], { type: 'image', source: { type: 'termag', media_type: 'image/png', path: null } });
  assert.deepStrictEqual(out.message.content[1].content[0], { type: 'image', source: { type: 'termag', media_type: 'image/jpeg', path: null } });
  assert.strictEqual(out.message.content[2].text, 'hi');
  assert.strictEqual(withoutImages({ type: 'assistant', message: { content: 'x' } }).message.content, 'x');
});
