'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sniffImageMime, resolveImagePath, readImageRpc } = require('./read-image');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termag-read-image-'));
}

test('sniffImageMime knows PNG, JPEG, GIF and WebP by their magic bytes, and nothing else', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(GIF), 'image/gif');
  assert.equal(sniffImageMime(WEBP), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImageMime(Buffer.from('hello')), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('resolveImagePath expands ~/ and refuses relative paths', () => {
  assert.equal(resolveImagePath('~/shots/a.png', '/home/ada'), '/home/ada/shots/a.png');
  assert.equal(resolveImagePath('/tmp/x/../a.png'), '/tmp/a.png');
  assert.throws(() => resolveImagePath('shots/a.png'), /absolute/);
  assert.throws(() => resolveImagePath(''), /path required/);
  assert.throws(() => resolveImagePath(undefined), /path required/);
  assert.throws(() => resolveImagePath('/tmp/a\0.png'), /path required/);
});

test('readImageRpc answers the image as base64 with the sniffed type, whatever the extension says', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'shot.jpg');
  fs.writeFileSync(p, PNG);
  const r = await readImageRpc({ path: p });
  assert.deepEqual(r, { ok: true, mime: 'image/png', data: PNG.toString('base64'), size: PNG.length });
});

test('readImageRpc answers data: null for a missing file', async () => {
  const dir = tmpDir();
  assert.deepEqual(await readImageRpc({ path: path.join(dir, 'gone.png') }), { ok: true, data: null });
  assert.deepEqual(await readImageRpc({ path: path.join(dir, 'gone', 'deeper.png') }), { ok: true, data: null });
});

test('readImageRpc refuses non-images, directories and oversized files', async () => {
  const dir = tmpDir();
  const text = path.join(dir, 'secrets.png');
  fs.writeFileSync(text, 'not an image');
  await assert.rejects(readImageRpc({ path: text }), /not an image/);
  await assert.rejects(readImageRpc({ path: dir }), /not a file/);
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(64)]));
  await assert.rejects(readImageRpc({ path: big }, { maxBytes: 32 }), /too large/);
  await assert.rejects(readImageRpc({ path: 'relative.png' }), /absolute/);
});

test('readImageRpc applies the agent path remap after resolving', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.png'), PNG);
  const r = await readImageRpc({ path: '/home/ada/a.png' }, { remapPath: (p) => p.replace('/home/ada', dir) });
  assert.equal(r.mime, 'image/png');
});
