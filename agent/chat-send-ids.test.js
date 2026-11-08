// A send's id (chat-send-ids.js): a chat-send the runner already took is
// answered as it was the first time, and starts no second turn. The browser
// sends a new session's first message again when the first answer never
// reaches it (the orchestrator stops waiting while the box starts the turn).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSendId, sentAnswer, withSent, SEND_IDS_MAX } = require('./chat-send-ids');
const { createChatRunner } = require('./chat-runner');

test('send ids: only short ids of letters, digits and hyphens', () => {
  assert.ok(isSendId('0b6f3c1e-4b7a-4d2e-9f00-3a1b2c3d4e5f'));
  assert.ok(isSendId('abcdefgh'));
  for (const bad of [undefined, null, 42, '', 'short', 'a'.repeat(65), 'has space1', '../../etc', 'semi;colon']) {
    assert.equal(isSendId(bad), false, String(bad));
  }
});

test('send ids: the answer kept for an id, the newest SEND_IDS_MAX kept', () => {
  let list = [];
  for (let i = 0; i < SEND_IDS_MAX + 5; i++) list = withSent(list, `send-id-${i}`, { queued: false, turnId: `t${i}` });
  assert.equal(list.length, SEND_IDS_MAX);
  assert.equal(sentAnswer(list, 'send-id-0'), null, 'the oldest fell off');
  assert.deepEqual(sentAnswer(list, `send-id-${SEND_IDS_MAX + 4}`), { queued: false, turnId: `t${SEND_IDS_MAX + 4}` });
  assert.equal(sentAnswer(list, 'never-sent'), null);
  // Garbage on disk reads as nothing sent.
  assert.equal(sentAnswer('nope', 'send-id-1'), null);
  assert.equal(sentAnswer([{ id: 'send-id-1' }, null], 'send-id-1'), null);
});

function box() {
  const procs = new Map();
  const sessions = new Set();
  return {
    procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text })}\n`);
      fs.writeFileSync(path.join(dir, 'claude.pid'), '4242');
      procs.set(meta.turnId, { meta, dir });
    },
    sessionAlive: async name => sessions.has(name),
  };
}

function runner(home, b) {
  return createChatRunner({
    home, username: 'alice', claudeBin: '/bin/claude', env: { PATH: '/usr/bin', TMUX: 'x' },
    send: () => true, isOpen: () => true,
    startProcess: b.startProcess, sessionAlive: b.sessionAlive, signalPid: () => {},
    telemetrySettings: async () => null,
    titleGenerator: async () => null,
    headingGenerator: async () => null,
    planUsage: { current: async () => null },
  });
}

const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', ...extra });
const turnsFor = (b, text) => [...b.procs.values()].filter(p => p.meta.text === text).length;

test('runner: a new session\'s first message sent twice with its id starts one turn, and the second send gets the first answer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  const first = await r.sendMessage(job('connect the MCP server', { sendId: 'first-msg-0001' }));
  assert.equal(first.queued, false);
  const again = await r.sendMessage(job('connect the MCP server', { sendId: 'first-msg-0001' }));
  assert.deepEqual(again, { ...first, duplicate: true });
  assert.equal(turnsFor(b, 'connect the MCP server'), 1);
});

test('runner: a send repeated while the first is still starting its turn waits for it and starts none of its own', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const r = runner(home, { ...b, startProcess: async (meta, dir) => { await slow; return b.startProcess(meta, dir); } });
  const first = r.sendMessage(job('hello', { sendId: 'first-msg-0002' }));
  const again = r.sendMessage(job('hello', { sendId: 'first-msg-0002' }));
  release();
  const [a, c] = await Promise.all([first, again]);
  assert.equal(c.duplicate, true);
  assert.equal(c.turnId, a.turnId);
  assert.equal(turnsFor(b, 'hello'), 1);
});

test('runner: the id outlasts an agent restart, and a queued send is answered as queued again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  await r.sendMessage(job('first'));
  const queued = await r.sendMessage(job('behind it', { sendId: 'queued-msg-0001' }));
  assert.deepEqual(queued, { queued: true, position: 1 });
  const restarted = runner(home, b);
  assert.deepEqual(await restarted.sendMessage(job('behind it', { sendId: 'queued-msg-0001' })), { queued: true, position: 1, duplicate: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), 'utf8')).length, 1, 'queued once');
});

test('runner: sends without an id, or with another id, are each their own message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  await r.sendMessage(job('go'));
  assert.equal((await r.sendMessage(job('go'))).queued, true);
  assert.equal((await r.sendMessage(job('go', { sendId: 'other-msg-0001' }))).queued, true);
  assert.equal((await r.sendMessage(job('go', { sendId: 'other-msg-0002' }))).queued, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), 'utf8')).length, 3);
});

test('runner: a send refused is not remembered, so its retry is tried again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  await assert.rejects(r.sendMessage(job('', { sendId: 'empty-msg-0001' })), /text is required/);
  const ok = await r.sendMessage(job('now with text', { sendId: 'empty-msg-0001' }));
  assert.equal(ok.duplicate, undefined);
  assert.equal(turnsFor(b, 'now with text'), 1);
});

test('runner: a queued send that Stop drops is forgotten, so its Retry goes in again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  await r.sendMessage(job('first'));
  assert.deepEqual(await r.sendMessage(job('behind it', { sendId: 'stopped-msg-0001' })), { queued: true, position: 1 });
  const stop = await r.interrupt('p1--main');
  assert.deepEqual(stop.dropped, ['behind it']);
  const retried = await r.sendMessage(job('behind it', { sendId: 'stopped-msg-0001' }));
  assert.equal(retried.duplicate, undefined, 'not answered from the ledger: the message never ran');
  assert.ok(retried.queued === true || typeof retried.turnId === 'string');
});

test('runner: a queued send dropped by clearing the chat is forgotten too; a send whose turn started is not', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  const r = runner(home, b);
  const started = await r.sendMessage(job('first', { sendId: 'started-msg-0001' }));
  await r.sendMessage(job('behind it', { sendId: 'cleared-msg-0001' }));
  await r.clear('p1--main');
  assert.equal((await r.sendMessage(job('behind it', { sendId: 'cleared-msg-0001' }))).duplicate, undefined);
  // The first message did reach Claude: a repeat of it is still that send.
  assert.deepEqual(await r.sendMessage(job('first', { sendId: 'started-msg-0001' })), { ...started, duplicate: true });
});

test('runner: Stop while a queued send is still starting the turn ahead of it: the dropped send is not recorded, so its Retry goes in again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-send-id-'));
  const b = box();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let starting;
  const started = new Promise(resolve => { starting = resolve; });
  const r = runner(home, { ...b, startProcess: async (meta, dir) => { starting(); await slow; return b.startProcess(meta, dir); } });
  // A queue left with no turn running: the next send starts its head (startNext) before it answers.
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.queue.json'), JSON.stringify([job('head of the queue')]));
  const sent = r.sendMessage(job('behind it', { sendId: 'raced-msg-0001' }));
  await started;
  const stop = r.interrupt('p1--main');
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await sent).queued, true);
  assert.ok((await stop).dropped.includes('behind it'));
  const retried = await r.sendMessage(job('behind it', { sendId: 'raced-msg-0001' }));
  assert.equal(retried.duplicate, undefined, 'Stop dropped it before it reached Claude: Retry takes it again');
});
