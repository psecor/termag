'use strict';
/**
 * The browser clipboard mailbox: a one-shot drop point for a pasted image.
 * The agent writes ~/.cache/termag/clipboard.png and only then makes Claude
 * Code paste (Ctrl+V); agent/xclip-shim.sh hands the file to Claude Code and
 * deletes it.
 *
 * Two RPCs fill it:
 *   - terminal-paste-image (the desktop terminal's paste over its terminal
 *     WebSocket): writes the mailbox, then types \x16 into that stream's PTY.
 *   - clipboard-paste-image (the phone's "attach a photo", which has no PTY):
 *     writes the mailbox, then `tmux send-keys -t =<session>: C-v`.
 */
const fs = require('fs');
const path = require('path');
const { tmuxPaneTarget } = require('./tmux-args');

const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf) {
  return buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

let tmpSeq = 0;

/**
 * Write `image` to `slot` atomically: a temp file next to it, then a rename,
 * so a reader (the shim) never sees half an image. The temp name is unique
 * per write, so two pastes in flight never share one.
 */
async function writeClipboardMailbox(slot, image) {
  await fs.promises.mkdir(path.dirname(slot), { recursive: true });
  const tmpSlot = `${slot}.tmp-${process.pid}-${tmpSeq++}`;
  try {
    await fs.promises.writeFile(tmpSlot, image);
    await fs.promises.rename(tmpSlot, slot);
  } catch (err) {
    await fs.promises.unlink(tmpSlot).catch(() => {});
    throw err;
  }
}

/** argv for the Ctrl+V that makes Claude Code read the mailbox (exact session). */
function pasteKeyArgv(sessionName) {
  return ['send-keys', '-t', tmuxPaneTarget(sessionName, true), 'C-v'];
}

/**
 * The clipboard-paste-image RPC: `{ sessionName, data }` with `data` a
 * base64 PNG. Throws (the agent answers with the message) on a missing
 * session name, an empty, oversized or non-PNG image, or a failed send-keys;
 * a failed send-keys removes the mailbox again so a later Ctrl+V does not
 * pick up an image nobody pasted.
 */
async function clipboardPasteImage(msg, { slot, execFile, maxBytes = CLIPBOARD_MAX_BYTES }) {
  const { sessionName, data } = msg || {};
  if (typeof sessionName !== 'string' || sessionName === '') throw new Error('sessionName required');
  if (typeof data !== 'string' || data === '') throw new Error('image required');
  // base64 is 4 chars per 3 bytes; refuse an oversized payload before decoding it.
  if (Math.floor(data.length / 4) * 3 > maxBytes + 3) throw new Error(`image too large (limit ${maxBytes} bytes)`);
  const image = Buffer.from(data, 'base64');
  if (image.length === 0) throw new Error('image required');
  if (image.length > maxBytes) throw new Error(`image too large (limit ${maxBytes} bytes)`);
  if (!isPng(image)) throw new Error('image is not a PNG');
  await writeClipboardMailbox(slot, image);
  // Ctrl+V makes Claude Code read the mailbox immediately, so the keystroke
  // only goes out once the file is fully in place.
  try {
    await execFile('tmux', pasteKeyArgv(sessionName));
  } catch (err) {
    await fs.promises.unlink(slot).catch(() => {});
    throw err;
  }
  return { ok: true };
}

module.exports = { CLIPBOARD_MAX_BYTES, isPng, writeClipboardMailbox, pasteKeyArgv, clipboardPasteImage };
