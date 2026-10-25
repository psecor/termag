'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionTitle, TITLE_LINE_MAX_BYTES } = require('./session-title');

const transcript = (entries) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, entries.map(e => `${typeof e === 'string' ? e : JSON.stringify(e)}\n`).join(''));
  return file;
};
const ai = (aiTitle) => ({ type: 'ai-title', aiTitle, sessionId: 's1' });
const custom = (customTitle) => ({ type: 'custom-title', customTitle, sessionId: 's1' });
const user = (content) => ({ type: 'user', message: { role: 'user', content } });

test('sessionTitle: the newest generated title, as Claude writes it again each turn', () => {
  const file = transcript([user('add rate limiting'), ai('Express API login rate limiting'), user('which library?'), ai('Express API login rate limiting')]);
  assert.equal(sessionTitle(file), 'Express API login rate limiting');
});

test('sessionTitle: a /rename beats the generated title, whichever came last', () => {
  assert.equal(sessionTitle(transcript([custom('Auth fix'), ai('Express API login rate limiting')])), 'Auth fix');
  assert.equal(sessionTitle(transcript([ai('Express API login rate limiting'), custom('Auth fix')])), 'Auth fix');
  assert.equal(sessionTitle(transcript([custom('Auth fix'), custom('Auth fix, part 2')])), 'Auth fix, part 2');
});

test('sessionTitle: reads only from `start`, the part of the transcript one turn wrote', () => {
  const earlier = [user('first'), ai('Old title')];
  const file = transcript([...earlier, user('second'), ai('New title')]);
  const start = earlier.map(e => Buffer.byteLength(`${JSON.stringify(e)}\n`)).reduce((a, b) => a + b, 0);
  assert.equal(sessionTitle(file, { start }), 'New title');
  const quiet = transcript([...earlier, user('second')]);
  assert.equal(sessionTitle(quiet, { start }), null, 'a turn that wrote no title says nothing');
});

test('sessionTitle: nothing for a missing file, blanks, junk, or a title buried in a long line', () => {
  assert.equal(sessionTitle('/nonexistent/session.jsonl'), null);
  assert.equal(sessionTitle(transcript([ai('   '), custom(''), { type: 'ai-title' }, 'not json -title"', user('hi')])), null);
  // A tool result that quotes a title line is a message, not a title.
  const quoted = user(`${'x'.repeat(TITLE_LINE_MAX_BYTES)} {"type":"ai-title","aiTitle":"Quoted"}`);
  assert.equal(sessionTitle(transcript([quoted])), null);
});

test('sessionTitle: trims, and bounds what goes in a frame', () => {
  assert.equal(sessionTitle(transcript([ai('  Spaced out  ')])), 'Spaced out');
  assert.equal(sessionTitle(transcript([ai('t'.repeat(900))])).length, 500);
});
