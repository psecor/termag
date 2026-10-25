'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { MAX_IMAGE_BYTES, MAX_IMAGES, createImageStore, decodeImages, userContent } = require('./chat-images');
const { CAPABILITIES, createChatRunner, entriesBeforeTurn, turnArgs, userPromptUuid } = require('./chat-runner');

// The smallest real PNG and GIF headers sniffImageMime accepts.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const GIF = Buffer.from('GIF89a-gif-body');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('capability: the runner advertises chat images', () => {
  assert.ok(CAPABILITIES.includes('chat-images-v1'));
});

test('decode: base64 of a PNG, JPEG, GIF or WebP by its bytes, capped in count and size', () => {
  assert.deepEqual(decodeImages(undefined), []);
  const [img] = decodeImages([{ mediaType: 'image/jpeg', data: PNG.toString('base64') }]);
  assert.equal(img.mediaType, 'image/png', 'the bytes decide the type, not the declared one');
  assert.throws(() => decodeImages([{ data: Buffer.from('<svg/>').toString('base64') }]), /^Error: image-refused: image 1 is not a PNG/);
  assert.throws(() => decodeImages([{ data: 'not base64!' }]), /image-refused: image 1 is not base64/);
  assert.throws(() => decodeImages(Array(MAX_IMAGES + 1).fill({ data: PNG.toString('base64') })), /at most 4 images/);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.throws(() => decodeImages([{ data: big.toString('base64') }]), /larger than/);
  assert.throws(() => decodeImages('x'), /must be a list/);
});

test('store: an image is kept once under its hash, read back as a block, and stripped to a reference', () => {
  const home = tmp('chat-img-store-');
  const store = createImageStore(home);
  const ref = store.save('p1--w1', PNG, 'image/png');
  assert.deepEqual(ref, { id: sha(PNG), mediaType: 'image/png', path: `~/.termag/chat-images/p1--w1/${sha(PNG)}.png` });
  const file = path.join(home, '.termag/chat-images/p1--w1', `${sha(PNG)}.png`);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(store.save('p1--w1', PNG, 'image/png'), ref);
  assert.deepEqual(store.block('p1--w1', ref), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  assert.equal(store.block('p1--w1', { id: '../x', mediaType: 'image/png' }), null);
  assert.equal(store.block('other--chat', ref), null, 'one chat cannot name another chat\'s image');

  const ev = {
    type: 'user', isReplay: true,
    message: {
      role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF.toString('base64') } },
        { type: 'text', text: 'what is this?' },
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] },
      ],
    },
  };
  const out = store.stripEvent('p1--w1', ev);
  assert.ok(!JSON.stringify(out).includes(GIF.toString('base64')), 'no image bytes leave in an event');
  assert.deepEqual(out.message.content[0], { type: 'image', source: { type: 'termag', media_type: 'image/gif', id: sha(GIF), path: `~/.termag/chat-images/p1--w1/${sha(GIF)}.gif` } });
  assert.equal(out.message.content[2].content[0].source.id, sha(PNG));
  assert.ok(fs.existsSync(path.join(home, '.termag/chat-images/p1--w1', `${sha(GIF)}.gif`)), 'an image only the transcript had is saved on the way');
  const plain = { type: 'user', message: { content: 'hi' } };
  assert.equal(store.stripEvent('p1--w1', plain), plain);
  assert.equal(store.stripEvent('p1--w1', { type: 'assistant', message: { content: [] } }).type, 'assistant');
});

test('content: images first, then the text; text alone stays a string', () => {
  const block = { type: 'image', source: {} };
  assert.equal(userContent('hi', []), 'hi');
  assert.deepEqual(userContent('hi', [block]), [block, { type: 'text', text: 'hi' }]);
  assert.deepEqual(userContent('', [block]), [block]);
});

test('turn argv: a message with images reads stream-json, without the live replay', () => {
  const args = turnArgs(null, 'dontAsk', { images: true });
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(!args.includes('--replay-user-messages'));
  const live = turnArgs(null, 'dontAsk', { live: true, images: true });
  assert.ok(live.includes('--replay-user-messages'));
});

function box() {
  const procs = new Map();
  const sessions = new Set();
  return {
    procs,
    startProcess: async (meta, dir) => {
      sessions.add(meta.session);
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-start', text: meta.text, images: meta.images })}\n`);
      procs.set(meta.turnId, { meta, dir });
    },
    sessionAlive: async name => sessions.has(name),
    signalPid: () => {},
  };
}

const job = (text, extra = {}) => ({ chatKey: 'p1--main', cwd: '/w/p1', text, projectId: 'p1', workstream: 'main', ...extra });
const png64 = PNG.toString('base64');

test('runner: a send with images keeps them, starts a stream-json turn on them, and no frame carries their bytes', async () => {
  const home = tmp('chat-img-run-');
  const b = box();
  const frames = [];
  const r = createChatRunner({ home, username: 'alice', claudeBin: '/bin/claude', send: f => { frames.push(f); return true; }, ...b });
  const { turnId } = await r.sendMessage(job('what is in it?', { images: [{ mediaType: 'image/png', data: png64 }] }));
  const { meta, dir } = b.procs.get(turnId);
  assert.equal(meta.args[meta.args.indexOf('--input-format') + 1], 'stream-json');
  assert.deepEqual(meta.images, [{ id: sha(PNG), mediaType: 'image/png', path: `~/.termag/chat-images/p1--main/${sha(PNG)}.png` }]);
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'prompt.jsonl'), 'utf8'));
  assert.deepEqual(line, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png64 } }, { type: 'text', text: 'what is in it?' }] },
  });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'user', isReplay: true, message: line.message })}\n`);
  await r.poll();
  assert.deepEqual(frames.map(f => f.event.type), ['turn-start', 'user']);
  assert.equal(frames[0].event.images[0].id, sha(PNG));
  assert.ok(!JSON.stringify(frames).includes(png64));
  assert.equal(frames[1].event.message.content[0].source.type, 'termag');
  const history = await r.history('p1--main');
  assert.ok(!JSON.stringify(history).includes(png64), 'the running turn\'s replay is stripped too');
});

test('runner: images alone are a message; nothing at all is still refused; a bad image refuses the send', async () => {
  const home = tmp('chat-img-only-');
  const b = box();
  const r = createChatRunner({ home, username: 'alice', claudeBin: '/bin/claude', send: () => true, ...b });
  const { turnId } = await r.sendMessage(job('', { images: [{ data: png64 }] }));
  const line = JSON.parse(fs.readFileSync(path.join(b.procs.get(turnId).dir, 'prompt.jsonl'), 'utf8'));
  assert.deepEqual(line.message.content.map(p => p.type), ['image']);
  await assert.rejects(r.sendMessage(job('  ')), /text is required/);
  await assert.rejects(r.sendMessage(job('hi', { images: [{ data: Buffer.from('nope').toString('base64') }] })), /^Error: image-refused/);
});

test('runner: a live send with images goes into the inbox as a built line, and back to the queue as references', async () => {
  const home = tmp('chat-img-live-');
  const b = box();
  const r = createChatRunner({ home, username: 'alice', claudeBin: '/bin/claude', send: () => true, ...b });
  const { turnId } = await r.sendMessage(job('start', { liveInput: true }));
  const { dir } = b.procs.get(turnId);
  assert.ok(!fs.existsSync(path.join(dir, 'prompt.jsonl')), 'a text-only turn is unchanged');
  assert.deepEqual(await r.sendMessage(job('and this?', { liveInput: true, images: [{ data: png64 }] })), { queued: false, live: true, turnId });
  const inboxed = JSON.parse(fs.readFileSync(path.join(dir, 'inbox/000001.json'), 'utf8'));
  assert.equal(JSON.parse(inboxed.line).message.content[0].source.data, png64);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'turn-end' })}\n`);
  fs.writeFileSync(path.join(dir, 'exit'), '{}');
  await r.poll();
  const next = [...b.procs.values()].find(p => p.meta.turnId !== turnId);
  assert.equal(next.meta.text, 'and this?');
  assert.equal(next.meta.images[0].id, sha(PNG));
  assert.ok(fs.existsSync(path.join(next.dir, 'prompt.jsonl')));
});

test('a real turn with an image: prompt.jsonl is stdin, and the turn-start names the image', () => {
  const dir = tmp('chat-turn-img-');
  const bin = path.join(dir, 'claude');
  // Echoes the content types of the line it read, as Claude's stream-json input would see them.
  fs.writeFileSync(bin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const content = JSON.parse(input.trim()).message.content;
  process.stdout.write(JSON.stringify({ type: 'result', result: content.map(p => p.type).join(',') + ' ' + process.argv.slice(2).join(' ') }) + '\\n');
});
`, { mode: 0o755 });
  const images = [{ id: sha(PNG), mediaType: 'image/png', path: '~/x.png' }];
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'look');
  fs.writeFileSync(path.join(dir, 'prompt.jsonl'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: userContent('look', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png64 } }]) } })}\n`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args: turnArgs(null, 'dontAsk', { images: true }), cwd: dir, path: process.env.PATH, text: 'look', images }));
  execFileSync(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir]);
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines[0].images, images);
  assert.match(lines[1].result, /^image,text -p --input-format stream-json /);
});

test('a live turn takes an inbox message with images as its built line', async () => {
  const dir = tmp('chat-turn-img-live-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
let carry = '';
process.stdin.on('data', d => {
  const lines = (carry + d).split('\\n'); carry = lines.pop();
  for (const line of lines) {
    const c = JSON.parse(line).message.content;
    process.stdout.write(JSON.stringify({ type: 'result', result: Array.isArray(c) ? c.map(p => p.type).join(',') : c }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'inbox'));
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png64 } }, { type: 'text', text: 'and?' }] } });
  fs.writeFileSync(path.join(dir, 'inbox/000001.json'), JSON.stringify({ text: 'and?', line }));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'first');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ chatKey: 'k', bin, args: [], cwd: dir, path: process.env.PATH, text: 'first', live: true }));
  const wrapper = spawn(process.execPath, [path.join(__dirname, 'chat-turn.js'), dir], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => wrapper.once('exit', resolve)), 0);
  const results = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'result').map(e => e.result);
  assert.deepEqual(results, ['first', 'image,text']);
});

const imagePart = (buf, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
const toolResult = { type: 'user', uuid: 'tool-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README.md' }] } };

test('history cut: an image-only prompt is its images, so a tool result after it is not the prompt', () => {
  const entries = [
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', message: { content: [imagePart(PNG)] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }] } },
    toolResult,
  ];
  assert.equal(entriesBeforeTurn(entries, '', [sha(PNG)]).length, 2);
  assert.equal(entriesBeforeTurn(entries, '', [sha(GIF)]).length, 5, 'other images: not this turn\'s prompt');
  const stored = [{ type: 'user', message: { content: [{ type: 'image', source: { type: 'termag', id: sha(PNG) } }, { type: 'text', text: 'and this?' }] } }, toolResult];
  assert.equal(entriesBeforeTurn(stored, 'and this?', [sha(PNG)]).length, 0, 'a stored reference counts by its id');
  assert.equal(entriesBeforeTurn(stored, 'and this?').length, 2, 'the same words without the image are another message');
});

test('user prompt uuid: an image-only message is a prompt; a tool result still is not', () => {
  const lines = [toolResult, { type: 'user', uuid: 'img-1', message: { role: 'user', content: [imagePart(PNG)] } }].map(e => JSON.stringify(e));
  assert.equal(userPromptUuid(lines.join('\n')), 'img-1');
  assert.equal(userPromptUuid(lines.map(l => Buffer.from(l))), 'img-1', 'lines as Buffers, as linesForward hands them out');
});

/** A transcript in Claude's place for `sessionId`, and the chat's state naming it. */
function seedTranscript(home, sessionId, entries) {
  const dir = path.join(home, '.claude/projects/-w-p1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), entries.map(e => `${JSON.stringify(e)}\n`).join(''));
  fs.mkdirSync(path.join(home, '.termag/chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag/chats/p1--main.json'), JSON.stringify({ sessionId, cwd: '/w/p1' }));
}

test('runner history: a running image-only turn is cut at its prompt, not at the tool result after it', async () => {
  const home = tmp('chat-img-cut-');
  const b = box();
  const r = createChatRunner({ home, username: 'alice', claudeBin: '/bin/claude', send: () => true, ...b });
  // A first turn: Claude writes the transcript only once the turn runs.
  const { turnId } = await r.sendMessage(job('', { images: [{ data: png64 }] }));
  assert.equal(b.procs.get(turnId).meta.transcriptBytes ?? null, null);
  seedTranscript(home, 'sess-cut-0001', [
    { type: 'user', uuid: 'u-img', message: { role: 'user', content: [imagePart(PNG)] } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: {} }] } },
    toolResult,
  ]);
  const history = await r.history('p1--main');
  assert.equal(history.running, true);
  assert.deepEqual(history.entries, [], 'the prompt and what follows it come from the turn\'s own log');
});

test('runner history: a message whose images outgrow the history budget is kept, and so is everything before it', async () => {
  const home = tmp('chat-img-big-');
  const r = createChatRunner({ home, username: 'alice', claudeBin: '/bin/claude', send: () => true, ...box() });
  // Two images of ~3.4 MB: one transcript line of ~9 MB of base64, past the 8 MB tail.
  const a = Buffer.concat([PNG, crypto.randomBytes(3_400_000)]);
  const c = Buffer.concat([PNG, crypto.randomBytes(3_400_000)]);
  seedTranscript(home, 'sess-big-0001', [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a-1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', uuid: 'u-2', message: { role: 'user', content: [imagePart(a), imagePart(c), { type: 'text', text: 'compare these' }] } },
    { type: 'assistant', uuid: 'a-2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
  ]);
  const history = await r.history('p1--main');
  assert.deepEqual(history.entries.map(e => e.uuid), ['u-1', 'a-1', 'u-2', 'a-2']);
  assert.deepEqual(history.entries[2].message.content.map(p => p.source?.id ?? p.text), [sha(a), sha(c), 'compare these']);
  assert.ok(fs.existsSync(path.join(home, '.termag/chat-images/p1--main', `${sha(a)}.png`)));
});
