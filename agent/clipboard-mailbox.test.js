'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLIPBOARD_MAX_BYTES, isPng, writeClipboardMailbox, pasteKeyArgv, clipboardPasteImage } = require('./clipboard-mailbox');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')]);

function tmpSlot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-clip-'));
  return path.join(dir, 'nested', 'clipboard.png');
}

// A fake execFile that records calls; `fail` makes it reject like a missing session.
function fakeExec({ fail = false, onCall } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (onCall) onCall();
    if (fail) throw new Error("can't find session: =u-p-agent");
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('the limit stays 20 MiB, matching the backend and the browser', () => {
  assert.equal(CLIPBOARD_MAX_BYTES, 20 * 1024 * 1024);
});

test('isPng checks the eight-byte signature', () => {
  assert.equal(isPng(PNG), true);
  assert.equal(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), false); // JPEG
  assert.equal(isPng(PNG.subarray(0, 7)), false);
  assert.equal(isPng(Buffer.alloc(0)), false);
});

test('Ctrl+V goes to the exact session as a tmux key name, argv only', () => {
  assert.deepEqual(pasteKeyArgv('u-p-agent'), ['send-keys', '-t', '=u-p-agent:', 'C-v']);
});

test('writeClipboardMailbox creates the directory, writes the bytes and leaves no temp file', async () => {
  const slot = tmpSlot();
  await writeClipboardMailbox(slot, PNG);
  assert.deepEqual(fs.readFileSync(slot), PNG);
  assert.deepEqual(fs.readdirSync(path.dirname(slot)), ['clipboard.png']);
  // A second write replaces the first.
  await writeClipboardMailbox(slot, Buffer.from('second'));
  assert.equal(fs.readFileSync(slot, 'utf8'), 'second');
});

test('two writes in flight do not collide on a temp name', async () => {
  const slot = tmpSlot();
  await Promise.all([writeClipboardMailbox(slot, PNG), writeClipboardMailbox(slot, PNG)]);
  assert.deepEqual(fs.readdirSync(path.dirname(slot)), ['clipboard.png']);
});

test('clipboard-paste-image writes the mailbox before it sends C-v, and answers ok', async () => {
  const slot = tmpSlot();
  let fileAtKeystroke = null;
  const { exec, calls } = fakeExec({ onCall: () => { fileAtKeystroke = fs.readFileSync(slot); } });
  const reply = await clipboardPasteImage({ sessionName: 'u-p-agent', data: PNG.toString('base64') }, { slot, execFile: exec });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(calls, [{ cmd: 'tmux', args: ['send-keys', '-t', '=u-p-agent:', 'C-v'] }]);
  assert.deepEqual(fileAtKeystroke, PNG, 'the whole image was in place when Ctrl+V went out');
});

test('clipboard-paste-image refuses bad input without touching the mailbox or tmux', async () => {
  const slot = tmpSlot();
  const { exec, calls } = fakeExec();
  const cases = [
    [{ data: PNG.toString('base64') }, /sessionName required/],
    [{ sessionName: 's', data: '' }, /image required/],
    [{ sessionName: 's' }, /image required/],
    [{ sessionName: 's', data: '!!!!' }, /image required/], // decodes to nothing
    [{ sessionName: 's', data: Buffer.from('GIF89a......').toString('base64') }, /not a PNG/],
    [{ sessionName: 's', data: Buffer.concat([PNG, Buffer.alloc(64)]).toString('base64') }, /too large/],
  ];
  for (const [msg, err] of cases) {
    await assert.rejects(clipboardPasteImage(msg, { slot, execFile: exec, maxBytes: 64 }), err);
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(slot), false);
});

test('an oversized payload is refused before it is decoded', async () => {
  const { exec } = fakeExec();
  await assert.rejects(
    clipboardPasteImage({ sessionName: 's', data: 'A'.repeat(200) }, { slot: tmpSlot(), execFile: exec, maxBytes: 64 }),
    /too large/,
  );
});

test('a failed send-keys takes the mailbox back out and reports the tmux error', async () => {
  const slot = tmpSlot();
  const { exec } = fakeExec({ fail: true });
  await assert.rejects(
    clipboardPasteImage({ sessionName: 'u-p-agent', data: PNG.toString('base64') }, { slot, execFile: exec }),
    /can't find session/,
  );
  assert.equal(fs.existsSync(slot), false);
});
