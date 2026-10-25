'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CHUNK_BYTES, SHRINK_LINE_BYTES, historyTail, linesBackward, linesForward } = require('./transcript-lines');

const tmpFile = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-lines-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, text);
  return file;
};
const strs = it => [...it].map(b => b.toString('utf8'));

test('backward: whole lines newest first, without a line still being written or one an offset cuts', () => {
  const file = tmpFile('one\ntwo\nthree\npart');
  assert.deepEqual(strs(linesBackward(file)), ['three', 'two', 'one']);
  assert.deepEqual(strs(linesBackward(file, { end: 8 })), ['two', 'one'], 'end on a line boundary');
  assert.deepEqual(strs(linesBackward(file, { end: 6 })), ['one'], 'end inside "two"');
  assert.deepEqual(strs(linesBackward(file, { start: 2 })), ['three', 'two'], 'start inside "one"');
  assert.deepEqual(strs(linesBackward(file, { start: 4 })), ['three', 'two'], 'start on a line boundary');
  assert.deepEqual(strs(linesBackward(path.join(path.dirname(file), 'missing'))), []);
});

test('forward: whole lines oldest first, from an offset, without the line it cuts or an unfinished one', () => {
  const file = tmpFile('one\ntwo\nthree\npart');
  assert.deepEqual(strs(linesForward(file)), ['one', 'two', 'three']);
  assert.deepEqual(strs(linesForward(file, { start: 2 })), ['two', 'three']);
  assert.deepEqual(strs(linesForward(file, { start: 4 })), ['two', 'three']);
});

test('a line longer than a read chunk comes back whole, both ways', () => {
  const long = 'x'.repeat(CHUNK_BYTES * 2 + 123);
  const file = tmpFile(`a\n${long}\nb\n`);
  assert.deepEqual(strs(linesBackward(file)).map(l => l.length), [1, long.length, 1]);
  assert.deepEqual(strs(linesForward(file)).map(l => l.length), [1, long.length, 1]);
});

test('history tail: the newest lines that fit, oldest first', () => {
  const file = tmpFile('line one\nline two\nline three\n');
  assert.equal(historyTail(file, { maxBytes: 1000 }), 'line one\nline two\nline three\n');
  assert.equal(historyTail(file, { maxBytes: 15 }), 'line three\n');
  assert.equal(historyTail(file, { maxBytes: 1000, end: 18 }), 'line one\nline two\n');
  assert.equal(historyTail(path.join(path.dirname(file), 'missing'), { maxBytes: 100 }), '');
});

test('history tail: a line too large for the budget is shrunk, and the lines before it stay', () => {
  const data = 'A'.repeat(SHRINK_LINE_BYTES * 8);
  const big = { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data } }, { type: 'text', text: 'what is it?' }] } };
  const lines = [{ type: 'user', message: { content: 'first' } }, big, { type: 'assistant', message: { content: 'a cat' } }];
  const file = tmpFile(lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  const shrink = e => ({ ...e, message: { content: e.message.content.map(p => p.type === 'image' ? { type: 'image', source: { type: 'termag', id: 'x' } } : p) } });
  const out = historyTail(file, { maxBytes: 64 * 1024, shrink }).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out.map(e => e.type), ['user', 'user', 'assistant']);
  assert.equal(out[0].message.content, 'first');
  assert.deepEqual(out[1].message.content[0], { type: 'image', source: { type: 'termag', id: 'x' } });

  // No shrink that helps, or a line that does not parse: that line goes, the others stay.
  assert.deepEqual(historyTail(file, { maxBytes: 64 * 1024 }).trim().split('\n').map(l => JSON.parse(l).type), ['user', 'assistant']);
  const broken = tmpFile(`"first"\n{${'x'.repeat(SHRINK_LINE_BYTES + 1)}\n"last"\n`);
  assert.equal(historyTail(broken, { maxBytes: 1024 }), '"first"\n"last"\n');
});

test('history tail: the descriptor is closed even when the read fails', () => {
  const closed = [];
  const failing = {
    openSync: () => 42,
    fstatSync: () => ({ size: 10 }),
    readSync: () => { throw new Error('EIO'); },
    closeSync: fd => closed.push(fd),
  };
  assert.equal(historyTail('/x', { maxBytes: 100, fsImpl: failing }), '');
  assert.deepEqual(closed, [42]);
});
