'use strict';
/**
 * Pane output history, for the phone's "Load earlier".
 *
 * Agent panes run their TUI on tmux's alternate screen, which keeps no
 * scrollback: capture-pane sees only the visible pane, so a capture-based
 * client has no past to scroll back through. This module keeps one anyway.
 * The agent arms `tmux pipe-pane` on every pane it manages — from the
 * tmux-create case, on the created and already-exists paths alike, so an
 * agent restart re-arms every session the backend reconstructs — and the
 * pipe appends every byte the pane emits to one log per session under
 * ~/.cache/termag/pane-history/. `pane-history-read` tails that log in byte
 * chunks, which the phone renders as plain earlier output above the
 * transcript.
 *
 * The log is the raw pane stream: a TUI repaint (attach, resize) lands in it
 * whole, so a stretch near a seam can repeat, and a spinner-redrawing TUI
 * emits bytes while idle. Truncation at MAX_HISTORY_BYTES on arm bounds the
 * file; reads only ever tail it.
 */
const fs = require('node:fs');
const path = require('node:path');

const { pipePaneArgv } = require('./tmux-args');

const CAPABILITIES = ['pane-history-v1'];
const MAX_HISTORY_BYTES = 4 * 1024 * 1024; // rotate past this when arming
const READ_MAX_BYTES = 256 * 1024;         // one "load earlier" chunk, at most
const READ_DEFAULT_BYTES = 64 * 1024;

/**
 * tmux session names may carry characters a log file name must not; flatten
 * them. A name that flattens to nothing is refused.
 */
function sanitizeSessionName(sessionName) {
  const s = String(sessionName || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!s || /^_+$/.test(s)) throw new Error('session name required');
  return s;
}

function historyFilePath(home, sessionName) {
  return path.join(home || '/home', '.cache', 'termag', 'pane-history', `${sanitizeSessionName(sessionName)}.log`);
}

/**
 * Arm the pipe for `sessionName` and bound the log. Truncate — never
 * rename — past the cap: the pipe's `cat >>` holds the file open O_APPEND,
 * so after a rename it keeps writing into the renamed inode and the read
 * path is gone for good (the pipe only re-arms on a session that has none,
 * `-o`). A truncate leaves the path where the writer and readers look, and
 * an append-mode writer continues at the new EOF.
 */
async function arm(home, sessionName, { execFile } = {}) {
  if (typeof execFile !== 'function') throw new Error('execFile required');
  const file = historyFilePath(home, sessionName);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX_HISTORY_BYTES) await fs.promises.truncate(file, 0);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await execFile('tmux', pipePaneArgv(sessionName, file));
  return file;
}

function clampBytes(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(READ_MAX_BYTES, n));
}

/**
 * `{ beforeBytes, maxBytes }` → the log's bytes before `beforeBytes` (the
 * whole tail when absent), and `startByte` — the offset the next earlier
 * page reads before; 0 means there is nothing earlier — is the raw window
 * start, so paging always moves. No seam trimming on purpose: a line that
 * spans two chunks then appears once, split across the chunks' blocks,
 * where trimming it at BOTH seams made it vanish entirely.
 */
async function readTail(home, sessionName, { beforeBytes, maxBytes } = {}) {
  const file = historyFilePath(home, sessionName);
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('no pane history for this session');
    throw err;
  }
  const totalBytes = st.size;
  const cap = clampBytes(maxBytes, READ_DEFAULT_BYTES);
  let end = totalBytes;
  if (beforeBytes != null) {
    const b = Number(beforeBytes);
    if (!Number.isFinite(b) || b < 0 || b > totalBytes) throw new Error('before out of range');
    end = Math.floor(b);
  }
  const start = Math.max(0, end - cap);
  if (end === start) return { content: '', startByte: start, endByte: end, totalBytes };

  const fh = await fs.promises.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  return { content: buf.toString('utf8'), startByte: start, endByte: end, totalBytes };
}

module.exports = {
  CAPABILITIES,
  MAX_HISTORY_BYTES,
  READ_MAX_BYTES,
  READ_DEFAULT_BYTES,
  sanitizeSessionName,
  historyFilePath,
  arm,
  readTail,
};
