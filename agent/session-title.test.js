'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { generateTitle, parseTitleResult, sessionTitle, titleArgs, titlePrompt, TITLE_LINE_MAX_BYTES, TITLE_MESSAGE_MAX_CHARS, TITLE_SYSTEM_PROMPT } = require('./session-title');

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

test('titleArgs: Haiku in print mode with nothing to act with and nothing saved', () => {
  const args = titleArgs();
  const after = flag => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--tools'), '', 'no tools');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(after('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(after('--settings')), { disableAllHooks: true });
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(after('--setting-sources'), 'user');
  assert.equal(after('--system-prompt'), TITLE_SYSTEM_PROMPT);
  assert.equal(after('--output-format'), 'json');
  assert.ok(!args.includes('--bare'), 'bare skips the gateway credential');
  assert.ok(!args.includes('--resume'));
});

test('titlePrompt: the message as data, cut to a bound', () => {
  assert.equal(titlePrompt('Fix the login loop'), '<message>\nFix the login loop\n</message>');
  assert.equal(titlePrompt('x'.repeat(TITLE_MESSAGE_MAX_CHARS + 50)).length, TITLE_MESSAGE_MAX_CHARS + '<message>\n\n</message>'.length);
});

test('parseTitleResult: the first line, without wrapping quotes or a closing stop; nothing from an error', () => {
  const result = r => JSON.stringify({ type: 'result', is_error: false, result: r });
  assert.equal(parseTitleResult(result('Fix SSO dashboard redirect loop')), 'Fix SSO dashboard redirect loop');
  assert.equal(parseTitleResult(result('"Migrate cron jobs to Temporal."\nAnything else?')), 'Migrate cron jobs to Temporal');
  assert.equal(parseTitleResult(result('\n  **Login rate limiting**  \n')), 'Login rate limiting');
  assert.equal(parseTitleResult(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })), null);
  assert.equal(parseTitleResult(result('  ')), null);
  assert.equal(parseTitleResult('not json'), null);
  assert.equal(parseTitleResult(JSON.stringify({ type: 'result' })), null);
});

/** A spawn that records what it ran and answers with `out` and `code`, or never when `hang`. */
function fakeSpawn({ out = '', code = 0, hang = false, error = null } = {}) {
  const runs = [];
  const spawn = (cmd, argv, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    let stdin = '';
    child.stdin.on('data', c => { stdin += c; });
    child.kill = signal => { child.killed = signal; };
    runs.push({ cmd, argv, options, child, stdin: () => stdin });
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (hang) return;
      child.stdout.end(out);
      child.stdout.on('end', () => child.emit('close', code));
      child.stdout.resume();
    });
    return child;
  };
  return { spawn, runs };
}

test('generateTitle: runs the call under nice with the prompt on stdin, and answers the title', async () => {
  const f = fakeSpawn({ out: JSON.stringify({ type: 'result', is_error: false, result: 'Fix SSO dashboard redirect loop' }) });
  const title = await generateTitle({ bin: '/bin/claude', env: { A: '1' }, cwd: '/home/u/.termag/chat-title', prompt: titlePrompt('hi'), spawn: f.spawn, nice: '/usr/bin/nice' });
  assert.equal(title, 'Fix SSO dashboard redirect loop');
  const run = f.runs[0];
  assert.equal(run.cmd, '/usr/bin/nice');
  assert.deepEqual(run.argv.slice(0, 3), ['-n', '10', '/bin/claude']);
  assert.deepEqual(run.argv.slice(3), titleArgs());
  assert.equal(run.options.cwd, '/home/u/.termag/chat-title');
  // Thinking off, as for every one-shot (haiku-oneshot.js).
  assert.deepEqual(run.options.env, { A: '1', MAX_THINKING_TOKENS: '0' });
  assert.equal(run.stdin(), '<message>\nhi\n</message>');
  const plain = fakeSpawn({ out: JSON.stringify({ result: 'Title' }) });
  await generateTitle({ bin: '/bin/claude', prompt: 'p', spawn: plain.spawn, nice: null });
  assert.equal(plain.runs[0].cmd, '/bin/claude', 'no nice on a host without one');
});

test('generateTitle: null for a failed exit, a spawn error or a call past its time, which is killed', async () => {
  assert.equal(await generateTitle({ bin: 'c', prompt: 'p', spawn: fakeSpawn({ out: '{"result":"x"}', code: 1 }).spawn, nice: null }), null);
  assert.equal(await generateTitle({ bin: 'c', prompt: 'p', spawn: fakeSpawn({ error: new Error('ENOENT') }).spawn, nice: null }), null);
  assert.equal(await generateTitle({ bin: 'c', prompt: 'p', spawn: () => { throw new Error('EAGAIN'); }, nice: null }), null);
  const slow = fakeSpawn({ hang: true });
  assert.equal(await generateTitle({ bin: 'c', prompt: 'p', spawn: slow.spawn, nice: null, timeoutMs: 20 }), null);
  assert.equal(slow.runs[0].child.killed, 'SIGKILL');
});
