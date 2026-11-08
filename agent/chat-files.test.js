'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { CAPABILITIES, DIR, EXCLUDE_LINE, MAX_FILE_BYTES, putFile, safeName } = require('./chat-files');

const execFileAsync = promisify(execFile);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const b64 = s => Buffer.from(s).toString('base64');

function repo() {
  const dir = tmp('chat-files-repo-');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

test('capability: the agent announces chat files', () => {
  assert.deepEqual(CAPABILITIES, ['chat-files-v1']);
});

test('safeName: the last segment, in characters a shell path can take', () => {
  assert.equal(safeName('Q3 report (final).xlsx'), 'Q3-report-_final_.xlsx');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\data.zip'), 'data.zip');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName(undefined), 'file');
  assert.equal(safeName(`${'a'.repeat(300)}.zip`).length, 120);
  assert.ok(safeName(`${'a'.repeat(300)}.zip`).endsWith('.zip'), 'the extension is kept');
  // Bugbot on #1477: the tail kept of a long name must not start with a dot or a dash.
  assert.equal(safeName(`${'a'.repeat(200)}.-${'b'.repeat(118)}`), 'b'.repeat(118));
});

test('putFile: keeps the file in the checkout, named by its bytes, out of git', async () => {
  const cwd = repo();
  const res = await putFile({ cwd, name: 'data set.zip', data: b64('PK\u0003\u0004zip-body') }, { execFile: execFileAsync });
  assert.match(res.path, /^\.termag-attachments\/[0-9a-f]{16}\/data-set\.zip$/);
  assert.equal(res.name, 'data-set.zip');
  assert.equal(res.size, 12);
  const file = path.join(cwd, res.path);
  assert.equal(fs.readFileSync(file, 'utf8'), 'PK\u0003\u0004zip-body');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Git doesn't see it: the folder is in info/exclude, once.
  assert.equal(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  await putFile({ cwd, name: 'other.bin', data: b64('\u0000\u0001') }, { execFile: execFileAsync });
  const exclude = fs.readFileSync(path.join(cwd, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter(l => l === EXCLUDE_LINE).length, 1);
  // The same bytes again are the same path.
  const again = await putFile({ cwd, name: 'data set.zip', data: b64('PK\u0003\u0004zip-body') }, { execFile: execFileAsync });
  assert.equal(again.path, res.path);
});

// Devin on #1477: a copy edited since, at the same length, or one with a looser mode, was kept as it was.
test('putFile: the same file again replaces whatever is at its path with exactly what was sent, privately', async () => {
  const cwd = tmp('chat-files-again-');
  const res = await putFile({ cwd, name: 'a.txt', data: b64('hello') });
  const file = path.join(cwd, res.path);
  fs.writeFileSync(file, 'HELLO');
  fs.chmodSync(file, 0o644);
  fs.chmodSync(path.dirname(file), 0o755);
  await putFile({ cwd, name: 'a.txt', data: b64('hello') });
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('putFile: a checkout that is not a git repository still takes it', async () => {
  const cwd = tmp('chat-files-plain-');
  const res = await putFile({ cwd, name: 'a.txt', data: b64('hi') }, { execFile: execFileAsync });
  assert.equal(fs.readFileSync(path.join(cwd, res.path), 'utf8'), 'hi');
});

test('putFile: refuses no checkout, bad data, empty and too large', async () => {
  await assert.rejects(putFile({ cwd: 'relative', name: 'a', data: b64('x') }), /^Error: file-refused: the chat has no checkout$/);
  await assert.rejects(putFile({ cwd: path.join(os.tmpdir(), 'chat-files-missing-xyz'), name: 'a', data: b64('x') }), /no checkout on this box yet/);
  const cwd = tmp('chat-files-bad-');
  await assert.rejects(putFile({ cwd, name: 'a', data: 'not base64!' }), /not base64/);
  await assert.rejects(putFile({ cwd, name: 'a', data: '' }), /is empty/);
  await assert.rejects(putFile({ cwd, name: 'a', data: Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64') }), /larger than 20 MB/);
});

test('putFile: never writes through a symlink the checkout holds', async () => {
  const cwd = tmp('chat-files-link-');
  const outside = tmp('chat-files-outside-');
  fs.symlinkSync(outside, path.join(cwd, DIR));
  await assert.rejects(putFile({ cwd, name: 'a.txt', data: b64('x') }), /file-refused: \.termag-attachments in the checkout is not a folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
  // A symlink where the file would go is refused too.
  const cwd2 = tmp('chat-files-link2-');
  const first = await putFile({ cwd: cwd2, name: 'a.txt', data: b64('x') });
  fs.unlinkSync(path.join(cwd2, first.path));
  fs.symlinkSync(path.join(outside, 'target'), path.join(cwd2, first.path));
  await assert.rejects(putFile({ cwd: cwd2, name: 'a.txt', data: b64('x') }), /something else is already at that path/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
