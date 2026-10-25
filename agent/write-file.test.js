'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileRpc } = require('./write-file');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-'));
}
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('writes the content, creating the directory', async () => {
  const p = path.join(tmp(), 'a', 'b', 'f.txt');
  await writeFileRpc(p, 'hello');
  assert.equal(fs.readFileSync(p, 'utf8'), 'hello');
});

test('mode and dirMode tighten an existing group-writable file and directory', async () => {
  const dir = path.join(tmp(), '.ssh');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o775);
  const p = path.join(dir, 'authorized_keys');
  fs.writeFileSync(p, 'old');
  fs.chmodSync(p, 0o664);
  await writeFileRpc(p, 'new', { mode: 0o600, dirMode: 0o700 });
  assert.equal(fs.readFileSync(p, 'utf8'), 'new');
  assert.equal(modeOf(p), 0o600);
  assert.equal(modeOf(dir), 0o700);
});

test('a new directory gets dirMode', async () => {
  const dir = path.join(tmp(), '.ssh');
  await writeFileRpc(path.join(dir, 'authorized_keys'), 'k', { mode: 0o600, dirMode: 0o700 });
  assert.equal(modeOf(dir), 0o700);
});

test('invalid modes are ignored and non-string content is refused', async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  const p = path.join(dir, 'f');
  await writeFileRpc(p, 'x', { mode: '600', dirMode: 0o7777 });
  assert.equal(modeOf(dir), 0o755);
  await assert.rejects(writeFileRpc(p, 1), /content must be a string/);
});
