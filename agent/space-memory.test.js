'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatRunner, historyEntries, entriesBeforeTurn } = require('./chat-runner');
const {
  CAPABILITIES, MANAGED_ENV, createSpaceMemory, managedCommand, stripNotice, stripNoticeEvent, withNotice, withSpaceMemory,
} = require('./space-memory');

/**
 * Stands in for `termag space memory context … --session <file> --json` (the
 * CLI's contextFor): the index the first time a session file is seen, then a
 * notice whenever the generation moved since that session last looked.
 */
function fakeCli(world) {
  return async (bin, argv) => {
    world.calls.push(argv);
    if (world.fail) throw new Error('termag: Can\'t reach the orchestrator');
    const file = argv[argv.indexOf('--session') + 1];
    // Pretty-printed, as the CLI's --json is.
    const out = v => ({ stdout: `${JSON.stringify(v, null, 2)}\n` });
    if (!world.on) return out({ kind: 'off', space: null });
    let seen = null;
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new session */ }
    // A named space the box doesn't reach falls back to its default, as the CLI does.
    const asked = argv[3] && !argv[3].startsWith('--') ? argv[3] : null;
    const space = asked && !(world.unreachable || []).includes(asked) ? asked : 'team';
    const indexPath = `/home/u/.termag/spaces/${space}/index.md`;
    if (!seen) {
      fs.writeFileSync(file, JSON.stringify({ generation: world.generation }));
      // pluginDir: what a CLI from before skills left space memory still answers; never used.
      return out({ kind: 'start', space, generation: world.generation, index: world.index || `# Shared memory of ${space}\nGeneration ${world.generation}.\n`, indexPath, pluginDir: world.pluginDir });
    }
    if (seen.generation === world.generation) return out({ kind: 'none', space });
    fs.writeFileSync(file, JSON.stringify({ generation: world.generation }));
    return out({ kind: 'notice', space, generation: world.generation, indexPath, notice: `Space memory of ${space} changed since this session started: +1 memory (gen-${world.generation}); re-read ${indexPath}.` });
  };
}

function setup(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'space-memory-'));
  // A space's skills as an older CLI's sync left them, to show none of it reaches a turn.
  const pluginDir = path.join(home, '.termag/spaces/team/plugin');
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"team"}');
  fs.mkdirSync(path.join(pluginDir, 'skills', 'demo-kit'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'skills', 'demo-kit', 'SKILL.md'), '---\nname: demo-kit\ndescription: d\n---\n');
  const world = { on: true, generation: 1, calls: [], fail: false, pluginDir, ...opts };
  const memory = createSpaceMemory({ home, execFile: fakeCli(world), bin: process.execPath });
  const procs = new Map();
  const sessions = new Set();
  const frames = [];
  const runner = createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin' },
    send: f => { frames.push(f); return true; }, isOpen: () => true,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text })}\n`);
      procs.set(meta.turnId, { meta, dir });
    },
    sessionAlive: async name => sessions.has(name), signalPid: () => {},
    titleGenerator: async () => null, readCheckout: async () => ({ repo: false }),
    memory,
  });
  const finish = (turnId, sessionId) => {
    const { meta, dir } = procs.get(turnId);
    if (sessionId) fs.writeFileSync(meta.stateFile, JSON.stringify({ sessionId, cwd: meta.cwd }));
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: 0 })}\n`);
    fs.writeFileSync(path.join(dir, 'exit'), JSON.stringify({ code: 0 }));
    sessions.delete(meta.session);
  };
  /** One whole turn: send, wait for it to start, finish it on `sessionId`, sweep. */
  const turn = async (text, extra = {}, sessionId = 'sess-aaaa-1111') => {
    const { turnId } = await runner.sendMessage({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', permissionMode: 'bypassPermissions', ...extra });
    const p = procs.get(turnId);
    const prompt = fs.readFileSync(path.join(p.dir, 'prompt.txt'), 'utf8');
    finish(turnId, sessionId);
    await runner.poll();
    return { ...p, prompt, turnId };
  };
  return { home, world, runner, turn, frames, procs, memory };
}

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test('capability: the agent announces space-memory-v1', () => {
  assert.deepEqual(CAPABILITIES, ['space-memory-v1']);
});

test('the notice rides ahead of the message and comes off again, as a string or a text block', () => {
  const msg = withNotice('Space memory changed.', 'please go on');
  assert.equal(msg, '<space-memory-notice>\nSpace memory changed.\n</space-memory-notice>\n\nplease go on');
  assert.equal(withNotice(null, 'x'), 'x');
  assert.equal(stripNotice(msg), 'please go on');
  assert.equal(stripNotice('please go on'), 'please go on');
  // A message that only quotes the tag is the person's, and stays.
  assert.equal(stripNotice('see <space-memory-notice>'), 'see <space-memory-notice>');
  const blocks = [{ type: 'image', source: { type: 'termag', id: 'a' } }, { type: 'text', text: msg }];
  assert.deepEqual(stripNotice(blocks), [blocks[0], { type: 'text', text: 'please go on' }]);
  const onlyNotice = [{ type: 'image', source: {} }, { type: 'text', text: withNotice('n', '') }];
  assert.deepEqual(stripNotice(onlyNotice), [onlyNotice[0]]);
  const ev = { type: 'user', isReplay: true, message: { role: 'user', content: msg } };
  assert.equal(stripNoticeEvent(ev).message.content, 'please go on');
  const other = { type: 'assistant', message: { content: msg } };
  assert.equal(stripNoticeEvent(other), other);
});

test('history and the turn cut never show or miss the notice', () => {
  const jsonl = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: withNotice('changed', 'go on') } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ].map(e => JSON.stringify(e)).join('\n');
  const entries = historyEntries(jsonl);
  assert.equal(entries[0].message.content, 'go on');
  assert.deepEqual(entriesBeforeTurn([{ type: 'user', message: { content: withNotice('n', 'go on') } }, { type: 'assistant', message: {} }], 'go on'), []);
});

test('argv: the index goes in ahead of --resume, after anything termag appends; never a plugin dir', () => {
  const memory = { appendPrompt: 'INDEX', pluginDir: '/p' };
  assert.deepEqual(withSpaceMemory(['-p', '--resume', 's1'], memory), ['-p', '--append-system-prompt', 'INDEX', '--resume', 's1']);
  assert.deepEqual(withSpaceMemory(['-p', '--append-system-prompt', 'ASK', '--resume', 's1'], memory), ['-p', '--append-system-prompt', 'ASK\n\nINDEX', '--resume', 's1']);
  assert.deepEqual(withSpaceMemory(['-p'], memory), ['-p', '--append-system-prompt', 'INDEX']);
  assert.deepEqual(withSpaceMemory(['-p'], null), ['-p']);
  assert.deepEqual(withSpaceMemory(['-p'], { appendPrompt: null, pluginDir: '/p' }), ['-p']);
  assert.deepEqual(managedCommand(['node', 'chat-turn.js', '/d']), ['/usr/bin/env', `${MANAGED_ENV}=1`, 'node', 'chat-turn.js', '/d']);
});

test('a session\'s system prompt is byte-identical on every turn, after memory changes too; each change is one notice', async () => {
  const { world, turn, frames, home } = setup();
  const t1 = await turn('first');
  const prompt1 = flag(t1.meta.args, '--append-system-prompt');
  assert.equal(prompt1, '# Shared memory of team\nGeneration 1.\n');
  assert.equal(t1.prompt, 'first');

  world.generation = 2;
  const t2 = await turn('second');
  assert.equal(flag(t2.meta.args, '--append-system-prompt'), prompt1);
  assert.match(t2.prompt, /^<space-memory-notice>\nSpace memory of team changed since this session started: \+1 memory \(gen-2\)/);
  assert.ok(t2.prompt.endsWith('\n\nsecond'));
  // What the chat shows is what the person typed.
  assert.equal(t2.meta.text, 'second');
  const starts = frames.filter(f => f.event.type === 'turn-start').map(f => f.event.text);
  assert.deepEqual(starts, ['first', 'second']);

  const t3 = await turn('third');
  assert.equal(flag(t3.meta.args, '--append-system-prompt'), prompt1);
  assert.equal(t3.prompt, 'third', 'no change, no notice');

  world.generation = 3;
  const t4 = await turn('fourth');
  assert.equal(flag(t4.meta.args, '--append-system-prompt'), prompt1);
  assert.match(t4.prompt, /gen-3/);
  const t5 = await turn('fifth');
  assert.equal(t5.prompt, 'fifth');
  // Every argv but --resume (and the turn's own paths) is the same from the second turn on.
  const stable = a => a.filter((x, i) => a[i - 1] !== '--resume' && x !== '--resume');
  assert.deepEqual(stable(t5.meta.args), stable(t2.meta.args));
});

test('a reload during the turn replays its log without the notices: one bubble, as typed (notice-leak)', async () => {
  const { world, turn, runner, procs, frames } = setup();
  await turn('first');
  world.generation = 2;
  const { turnId } = await runner.sendMessage({
    chatKey: 'p1--main', cwd: '/w/p1', text: 'second', projectId: 'p1', workstream: 'main', permissionMode: 'bypassPermissions',
    notice: 'The chat continues on a new box.',
  });
  const { dir } = procs.get(turnId);
  const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  assert.match(prompt, /^<termag-box-notice>[\s\S]*<space-memory-notice>[\s\S]*\n\nsecond$/);
  // Claude's replay of the message it was given (--replay-user-messages), as a string and as a text block.
  for (const content of [prompt, [{ type: 'text', text: prompt }]]) {
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content } })}\n`);
  }
  await runner.poll();
  const h = await runner.history('p1--main');
  const replays = h.turn.events.filter(e => e.event.type === 'user').map(e => e.event.message.content);
  assert.deepEqual(replays, ['second', [{ type: 'text', text: 'second' }]]);
  const live = frames.filter(f => f.turnId === turnId && f.event.type === 'user').map(f => f.event.message.content);
  assert.deepEqual(live, replays, 'the live frames and the reload agree');
});

test('a new session (Clear drops the id) starts over with the memory as it is now', async () => {
  const { world, turn } = setup();
  const t1 = await turn('first');
  world.generation = 5;
  // What Clear leaves: the chat's state with no session id.
  fs.writeFileSync(t1.meta.stateFile, JSON.stringify({ sessionId: null, cwd: '/w/p1' }));
  const t2 = await turn('fresh start', {}, 'sess-bbbb-2222');
  assert.equal(flag(t2.meta.args, '--append-system-prompt'), '# Shared memory of team\nGeneration 5.\n');
  assert.equal(t2.prompt, 'fresh start', 'a new session is told by its prompt, not by a notice');
  assert.ok(!t2.meta.args.includes('--resume'));
  world.generation = 6;
  const t3 = await turn('next', {}, 'sess-bbbb-2222');
  assert.equal(flag(t3.meta.args, '--append-system-prompt'), '# Shared memory of team\nGeneration 5.\n');
  assert.match(t3.prompt, /gen-6/);
});

test('a session that began without memory keeps its prompt and is told where the memory is', async () => {
  const { world, turn } = setup({ on: false });
  const t1 = await turn('before');
  assert.equal(flag(t1.meta.args, '--append-system-prompt'), undefined);
  world.on = true;
  const t2 = await turn('after');
  assert.equal(flag(t2.meta.args, '--append-system-prompt'), undefined, 'never a new system prompt mid-session');
  assert.match(t2.prompt, /started before space memory loaded\. The shared memory of team is in \/home\/u\/\.termag\/spaces\/team\/index\.md/);
  const t3 = await turn('later');
  assert.equal(t3.prompt, 'later');
});

test('a failing CLI changes nothing: the session keeps its frozen prompt', async () => {
  const { world, turn } = setup();
  const t1 = await turn('first');
  world.fail = true;
  world.generation = 9;
  const t2 = await turn('second');
  assert.equal(flag(t2.meta.args, '--append-system-prompt'), flag(t1.meta.args, '--append-system-prompt'));
  assert.equal(t2.prompt, 'second');
});

test('an untrusted turn gets the index too; an ask\'s prompt comes first; the named space is asked for', async () => {
  const { turn, world } = setup();
  const t1 = await turn('look', { permissionMode: 'dontAsk', spaceMemory: { space: 'improve-termag' } });
  assert.match(flag(t1.meta.args, '--append-system-prompt'), /Shared memory of improve-termag/);
  assert.deepEqual(world.calls[0].slice(0, 5), ['space', 'memory', 'context', 'improve-termag', '--session']);
  assert.deepEqual(world.calls[0].slice(-3), ['--refresh', '60s', '--json']);

  const s = setup();
  const ask = { threadId: 'abcdefgh1234', systemPrompt: 'You are answering an ask.' };
  const t = await s.turn('do it', { ask, spaceMemory: { space: 'bad name!' } });
  assert.equal(flag(t.meta.args, '--append-system-prompt'), 'You are answering an ask.\n\n# Shared memory of team\nGeneration 1.\n');
  assert.equal(s.world.calls[0][3], '--session', 'a bad space name is dropped: the box default');
});

test('no CLI on the box: nothing loads, and the turn runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'space-memory-'));
  const lines = [];
  const m = createSpaceMemory({ home, execFile: async () => { throw new Error('not called'); }, log: l => lines.push(l) });
  assert.deepEqual(await m.forTurn({ chatKey: 'k', sessionId: null }), { appendPrompt: null, notice: null });
  await m.forTurn({ chatKey: 'k', sessionId: null });
  assert.equal(lines.length, 1, 'said once');
});

test('a chat loads its own space, the one the server fixed; a session keeps it with no notice; Clear loads the same (plan-outbox #38)', async () => {
  const { turn, world } = setup();
  // The box's first grant is team; the chat belongs to design.
  const t1 = await turn('hello', { spaceMemory: { space: 'design' } });
  assert.equal(world.calls[0][3], 'design');
  assert.equal(flag(t1.meta.args, '--append-system-prompt'), '# Shared memory of design\nGeneration 1.\n');
  const t2 = await turn('still here', { spaceMemory: { space: 'design' } });
  assert.equal(world.calls[1][3], 'design');
  assert.equal(flag(t2.meta.args, '--append-system-prompt'), flag(t1.meta.args, '--append-system-prompt'));
  assert.equal(t2.prompt, 'still here');
  // A session from before, pinned to another space than the one the server now names, keeps its prompt, and hears nothing.
  const t3 = await turn('renamed', { spaceMemory: { space: 'team' } });
  assert.equal(world.calls[2][3], 'design');
  assert.equal(t3.prompt, 'renamed');
  assert.ok(!t3.prompt.includes('now open in the space'));
  // Clear: the new session loads the chat's space again.
  fs.writeFileSync(t1.meta.stateFile, JSON.stringify({ sessionId: null, cwd: '/w/p1' }));
  const t4 = await turn('fresh', { spaceMemory: { space: 'design' } }, 'sess-cccc-3333');
  assert.equal(flag(t4.meta.args, '--append-system-prompt'), '# Shared memory of design\nGeneration 1.\n');
  assert.equal(t4.prompt, 'fresh');
});

test('a chat with no space it can load ({ space: null }) loads nothing, never the box default; a session that had memory keeps its prompt and is told once', async () => {
  const { turn, world } = setup();
  const t1 = await turn('hello', { spaceMemory: { space: null } });
  assert.equal(world.calls.length, 0, 'the CLI is not asked: it would load the box default');
  assert.equal(flag(t1.meta.args, '--append-system-prompt'), undefined);
  assert.equal(t1.prompt, 'hello');
  assert.equal((await turn('again', { spaceMemory: { space: null } })).prompt, 'again');

  // A chat in design whose box loses the grant: the system prompt stays, one notice says it no longer loads.
  const s = setup();
  const a = await s.turn('one', { spaceMemory: { space: 'design' } });
  const b = await s.turn('two', { spaceMemory: { space: null } });
  assert.equal(flag(b.meta.args, '--append-system-prompt'), flag(a.meta.args, '--append-system-prompt'));
  assert.match(b.prompt, /^<space-memory-notice>\nSpace memory of design is no longer loaded for this chat/);
  assert.equal((await s.turn('three', { spaceMemory: { space: null } })).prompt, 'three');
  assert.equal(s.world.calls.length, 1);
  // Granted again: loaded again, and the session is told so, revoking the "disregard" (Bugbot, #768).
  const d = await s.turn('four', { spaceMemory: { space: 'design' } });
  assert.equal(s.world.calls.at(-1)[3], 'design');
  assert.equal(flag(d.meta.args, '--append-system-prompt'), flag(a.meta.args, '--append-system-prompt'));
  assert.match(d.prompt, /^<space-memory-notice>\nSpace memory of design is loaded for this chat again: what this session was given from it at its start applies again/);
  assert.equal((await s.turn('five', { spaceMemory: { space: 'design' } })).prompt, 'five', 'said once');
  // Lost again: told again.
  assert.match((await s.turn('six', { spaceMemory: { space: null } })).prompt, /is no longer loaded/);
});

test('a restored grant the CLI can\'t confirm yet says nothing, and says it once the CLI answers', async () => {
  const s = setup();
  await s.turn('one', { spaceMemory: { space: 'design' } });
  await s.turn('two', { spaceMemory: { space: null } });
  s.world.fail = true;
  assert.equal((await s.turn('three', { spaceMemory: { space: 'design' } })).prompt, 'three');
  s.world.fail = false;
  assert.match((await s.turn('four', { spaceMemory: { space: 'design' } })).prompt, /is loaded for this chat again/);
});

test('chat-send keeps { space: null } on the job, and drops anything that is not a name or null', async () => {
  const { turn, world } = setup();
  await turn('bad', { spaceMemory: { space: 7 } });
  assert.equal(world.calls.length, 1, 'not a name: as if none was sent, the box default');
  await turn('none', { spaceMemory: { space: null } });
  assert.equal(world.calls.length, 1);
});

test('agent.js hands chat-send\'s spaceMemory to the runner (it copies the fields it passes one by one)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
  const handler = /case 'chat-send': \{[\s\S]*?chats\.sendMessage\(\{([\s\S]*?)\}\)\);/.exec(src);
  assert.ok(handler, 'the chat-send handler calls chats.sendMessage({ … })');
  assert.match(handler[1], /spaceMemory: msg\.spaceMemory/);
});

test('Clear after a session has its id: the new session keeps the prompt it froze (Bugbot, #768)', async () => {
  const { world, turn } = setup();
  const t1 = await turn('first');
  // A second turn records the Claude session id in owner.json.
  await turn('second');
  world.generation = 5;
  fs.writeFileSync(t1.meta.stateFile, JSON.stringify({ sessionId: null, cwd: '/w/p1' }));
  const t3 = await turn('after clear', {}, 'sess-bbbb-2222');
  assert.equal(flag(t3.meta.args, '--append-system-prompt'), '# Shared memory of team\nGeneration 5.\n');
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(t1.meta.stateFile), 'p1--main.space-memory', 'owner.json'), 'utf8'));
  assert.equal(owner.sessionId, null, 'the cleared session\'s id is not carried into the new one');
  const t4 = await turn('next', {}, 'sess-bbbb-2222');
  assert.equal(flag(t4.meta.args, '--append-system-prompt'), '# Shared memory of team\nGeneration 5.\n');
  assert.equal(t4.prompt, 'next');
});

test('a space\'s skills never reach a session: no plugin dir in any turn, mode or resume, nothing frozen (plan-outbox #50)', async () => {
  const { home, turn, runner } = setup();
  const chat = path.join(home, '.termag/chats/p1--main.space-memory');
  // What an agent from before left next to a session: dropped at the next turn, never passed on.
  fs.mkdirSync(path.join(chat, 'plugin', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(chat, 'plugin', '.claude-plugin', 'plugin.json'), '{"name":"team"}');
  for (const permissionMode of ['bypassPermissions', 'acceptEdits', 'dontAsk']) {
    const t = await turn(permissionMode, { permissionMode });
    assert.ok(!t.meta.args.includes('--plugin-dir'), `${permissionMode}: ${t.meta.args.join(' ')}`);
    assert.ok(!flag(t.meta.args, '--append-system-prompt').includes('demo-kit'));
  }
  assert.ok(!fs.existsSync(path.join(chat, 'plugin')));
  for (const permissionMode of ['bypassPermissions', 'dontAsk']) {
    const claim = await runner.claimResume('p1--main', { cwd: '/w/p1', permissionMode });
    assert.equal(claim.claimed, true, permissionMode);
    const script = fs.readFileSync(path.join(home, '.termag/chat-resume', 'p1--main'), 'utf8');
    assert.ok(!script.includes('--plugin-dir'), `${permissionMode}: ${script}`);
    await runner.releaseResume('p1--main');
  }
});

test('a chat resumed in a pane (Open in full UI) keeps the hooks from adding its memory again (Security Agent, sweep 27)', () => {
  const { resumeLaunch } = require('./chat-runner');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'space-memory-resume-'));
  const session = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const launch = resumeLaunch({ home, chatKey: 'p1--main', sessionId: session, mode, bin: '/bin/claude', cwd: '/w/p1' });
    assert.ok(launch, mode);
    const script = fs.readFileSync(path.join(home, '.termag/chat-resume', 'p1--main'), 'utf8');
    assert.match(script, new RegExp(`\\nexport ${MANAGED_ENV}=1\\n`), `${mode}: ${script}`);
    // Set before exec, so Claude Code, and the hooks it runs, inherit it.
    assert.ok(script.indexOf(`export ${MANAGED_ENV}=1`) < script.indexOf('exec '));
  }
});

test('Open in full UI resumes the session with its frozen index, byte for byte, in every mode (plan-outbox #42)', async () => {
  const { home, world, turn, runner, memory } = setup();
  // Quotes, $, a backslash and the trailing newline: the bytes a shell would mangle.
  world.index = "# Shared memory of team\nIt's \"data\", not $HOME or `authority` \\n.\n\n";
  const t1 = await turn('first');
  world.generation = 2;
  await turn('second');
  const frozen = fs.readFileSync(path.join(home, '.termag/chats/p1--main.space-memory/prompt.md'), 'utf8');
  assert.equal(frozen, world.index);
  assert.equal(flag(t1.meta.args, '--append-system-prompt'), frozen);
  const session = 'sess-aaaa-1111';
  assert.equal(memory.frozenPromptFor('p1--main', session), frozen);

  // A stand-in claude that records the argv it was exec'd with.
  const bin = path.join(home, 'fake-claude');
  const seen = path.join(home, 'argv.json');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'space-memory-cwd-'));
  const { resumeLaunch } = require('./chat-runner');
  const { execFileSync } = require('node:child_process');
  for (const mode of ['bypassPermissions', 'acceptEdits', 'dontAsk']) {
    fs.rmSync(seen, { force: true });
    const launch = resumeLaunch({ home, chatKey: 'p1--main', sessionId: session, mode, bin, cwd, appendPrompt: memory.frozenPromptFor('p1--main', session) });
    execFileSync('sh', [path.join(home, '.termag/chat-resume', 'p1--main')], { env: { PATH: '/usr/bin:/bin' } });
    const argv = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(flag(argv, '--append-system-prompt'), frozen, `${mode}: the pane gets the session's frozen bytes`);
    assert.equal(argv.filter(a => a === '--append-system-prompt').length, 1, mode);
    assert.deepEqual(argv.slice(-2), ['--resume', session], mode);
    assert.deepEqual(launch.argv, argv, mode);
  }

  // The runner's resume claim does the same: a chat in a pane keeps the system prompt its turns had.
  const claim = await runner.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(claim.claimed, true);
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume', 'p1--main'), 'utf8');
  assert.ok(script.includes(`'--append-system-prompt' '${frozen.replace(/'/g, `'\\''`)}' '--resume'`), script);
  await runner.releaseResume('p1--main');
});

test('a session with no frozen index resumes with no appended prompt; nor does another session\'s copy', async () => {
  const { home, turn, runner, memory } = setup({ on: false });
  await turn('first');
  await turn('second');
  assert.equal(memory.frozenPromptFor('p1--main', 'sess-aaaa-1111'), null);
  const claim = await runner.claimResume('p1--main', { cwd: '/w/p1', permissionMode: 'bypassPermissions' });
  assert.equal(claim.claimed, true);
  const script = fs.readFileSync(path.join(home, '.termag/chat-resume', 'p1--main'), 'utf8');
  assert.ok(!script.includes('--append-system-prompt'), script);
  await runner.releaseResume('p1--main');

  const s = setup();
  await s.turn('first');
  // After its first turn the copy can only be that session's (owner.json learns the id at the second).
  assert.ok(s.memory.frozenPromptFor('p1--main', 'sess-aaaa-1111'));
  await s.turn('second');
  // Cleared since (another session), no session, or another chat: nothing frozen is theirs.
  assert.equal(s.memory.frozenPromptFor('p1--main', 'sess-zzzz-9999'), null);
  assert.equal(s.memory.frozenPromptFor('p1--main', null), null);
  assert.equal(s.memory.frozenPromptFor('other--main', 'sess-aaaa-1111'), null);
});

test('a compact turn stays a bare /compact: the session\'s frozen index, no CLI call, no notice; the next turn has the notice (Bugbot, #768)', async () => {
  const { turn, world, runner, procs } = setup();
  const t1 = await turn('first', { spaceMemory: { space: 'design' } });
  world.generation = 2;
  const calls = world.calls.length;
  const { turnId } = await runner.compact({ chatKey: 'p1--main', cwd: '/w/p1', projectId: 'p1', workstream: 'main', permissionMode: 'bypassPermissions' });
  const p = procs.get(turnId);
  assert.equal(fs.readFileSync(path.join(p.dir, 'prompt.txt'), 'utf8'), '/compact');
  assert.equal(flag(p.meta.args, '--append-system-prompt'), flag(t1.meta.args, '--append-system-prompt'), 'the same system prompt as every turn of the session');
  assert.equal(world.calls.length, calls, 'nothing asked of the CLI: a no-space chat can\'t load the box default here');
  fs.appendFileSync(path.join(p.dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end', exitCode: 0 })}\n`);
  fs.writeFileSync(path.join(p.dir, 'exit'), JSON.stringify({ code: 0 }));
  await runner.poll();
  const t2 = await turn('after', { spaceMemory: { space: 'design' } });
  assert.match(t2.prompt, /^<space-memory-notice>\n.*gen-2/);
});
