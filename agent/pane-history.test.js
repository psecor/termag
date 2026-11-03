'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeSessionName, historyFilePath, arm, readTail, READ_MAX_BYTES } = require('./pane-history');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termag-pane-history-'));
}

/** Write a history log as the pipe would: append-only bytes. */
function writeLog(home, sessionName, text) {
  const file = historyFilePath(home, sessionName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('sanitizeSessionName flattens unsafe characters and refuses nothing-left names', () => {
  assert.equal(sanitizeSessionName('u-proj-agent'), 'u-proj-agent');
  assert.equal(sanitizeSessionName('u p.r:o:j'), 'u_p_r_o_j');
  assert.throws(() => sanitizeSessionName(''), /session name required/);
  assert.throws(() => sanitizeSessionName('///'), /session name required/);
  assert.throws(() => sanitizeSessionName(undefined), /session name required/);
});

test('historyFilePath lives under ~/.cache/termag/pane-history with a sanitized name', () => {
  assert.equal(
    historyFilePath('/home/ada', 'u-p-agent'),
    '/home/ada/.cache/termag/pane-history/u-p-agent.log',
  );
});

test('arm makes the directory and runs pipe-pane -o with a quoted log path', async () => {
  const home = tmpHome();
  const calls = [];
  const file = await arm(home, 'u p-agent', { execFile: async (cmd, argv) => { calls.push([cmd, argv]); } });
  assert.equal(file, path.join(home, '.cache/termag/pane-history/u_p-agent.log'));
  assert.deepEqual(calls, [['tmux', ['pipe-pane', '-o', '-t', 'u p-agent', `cat >> '${file}'`]]]);
  assert.ok(fs.existsSync(path.dirname(file)));
});

test('arm truncates a log past the cap and leaves the path in place', async () => {
  const home = tmpHome();
  const file = writeLog(home, 'u-p-agent', 'x'.repeat(4 * 1024 * 1024 + 1));
  await arm(home, 'u-p-agent', { execFile: async () => {} });
  // Truncate, not rename: the pipe's append-mode writer follows the inode,
  // so a renamed path would strand it (Bugbot: rotation breaks live history).
  assert.equal(fs.statSync(file).size, 0);
  assert.ok(!fs.existsSync(`${file}.old`));
  // A second arm of a small log truncates nothing.
  fs.appendFileSync(file, 'kept');
  await arm(home, 'u-p-agent', { execFile: async () => {} });
  assert.equal(fs.readFileSync(file, 'utf8'), 'kept');
});

test('readTail without beforeBytes returns the tail, and pages back on line boundaries', async () => {
  const home = tmpHome();
  writeLog(home, 'u-p-agent', Array.from({ length: 100 }, (_, i) => `L${String(i + 1).padStart(3, '0')}`).join('\n') + '\n');
  const tail = await readTail(home, 'u-p-agent', { maxBytes: 15 });
  assert.equal(tail.content, 'L098\nL099\nL100\n');
  assert.equal(tail.endByte, tail.totalBytes);
  assert.ok(tail.startByte > 0);

  const earlier = await readTail(home, 'u-p-agent', { beforeBytes: tail.startByte, maxBytes: READ_MAX_BYTES });
  assert.ok(earlier.content.startsWith('L001\n'));
  assert.ok(earlier.content.endsWith('L097\n'));
  assert.equal(earlier.startByte, 0);
  // Paging again from 0 is exhausted and stays in range.
  const rest = await readTail(home, 'u-p-agent', { beforeBytes: earlier.startByte, maxBytes: READ_MAX_BYTES });
  assert.equal(rest.startByte, 0);
});

test('a line spanning a page seam appears once, split across the two chunks', async () => {
  const home = tmpHome();
  writeLog(home, 'u-p-agent', 'aaaa\nbbbb\ncccc\ndddd\n');
  // The window starts mid-'bbbb' (byte 8): the chunk shows its tail of it,
  // and the earlier page shows its head — between them, no line is lost.
  const page = await readTail(home, 'u-p-agent', { maxBytes: 12 });
  assert.equal(page.content, 'b\ncccc\ndddd\n');
  const earlier = await readTail(home, 'u-p-agent', { beforeBytes: page.startByte, maxBytes: READ_MAX_BYTES });
  assert.equal(earlier.content, 'aaaa\nbbb');
  // Joined, the chunks hold the log verbatim.
  assert.equal(earlier.content + page.content, 'aaaa\nbbbb\ncccc\ndddd\n');
});

test('readTail pages through a line longer than the cap as fragments that still move', async () => {
  const home = tmpHome();
  const blob = 'x'.repeat(READ_MAX_BYTES + 50);
  writeLog(home, 'u-p-agent', `before\n${blob}\nafter\n`);
  const tail = await readTail(home, 'u-p-agent', { maxBytes: 12 });
  assert.equal(tail.content, 'xxxxx\nafter\n');
  const earlier = await readTail(home, 'u-p-agent', { beforeBytes: tail.startByte, maxBytes: 12 });
  // The window sits inside the blob: an x fragment, but startByte moved
  // back, so the phone pages on through it cap by cap.
  assert.ok(earlier.content.startsWith('x'));
  assert.ok(earlier.startByte < tail.startByte);
  const beforeBlob = await (async () => {
    let cursor = earlier.startByte;
    for (let hops = 0; hops < 30; hops++) {
      const page = await readTail(home, 'u-p-agent', { beforeBytes: cursor, maxBytes: READ_MAX_BYTES });
      if (page.startByte === 0) return page;
      cursor = page.startByte;
    }
    throw new Error('never paged past the blob');
  })();
  // No seam trimming: the log's first page ends mid-blob, honestly.
  assert.ok(beforeBlob.content.startsWith('before\n'));
  assert.equal(beforeBlob.startByte, 0);
});

test('readTail refuses a missing log and an out-of-range before', async () => {
  const home = tmpHome();
  await assert.rejects(() => readTail(home, 'u-p-agent', {}), /no pane history/);
  writeLog(home, 'u-p-agent', 'hello\n');
  await assert.rejects(() => readTail(home, 'u-p-agent', { beforeBytes: 99 }), /before out of range/);
});
