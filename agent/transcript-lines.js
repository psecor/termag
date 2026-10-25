'use strict';

// Whole lines of a Claude Code transcript, read in chunks. A message with
// images is one JSONL line holding their base64 (several MB each), so a
// byte-window read can split it, and a window smaller than the line loses
// it and every line before it. These readers hand out whole lines, and
// `historyTail` shrinks an oversized one before counting it.

const fs = require('node:fs');

const CHUNK_BYTES = 1024 * 1024;
// No line is read past this: four images at the Messages API's cap are ~21 MB of base64.
const LINE_MAX_BYTES = 48 * 1024 * 1024;
// A longer line is parsed and shrunk before it counts against the budget.
const SHRINK_LINE_BYTES = 256 * 1024;
// How much of the file one read may cover, whatever it keeps.
const RAW_MAX_BYTES = 192 * 1024 * 1024;

/**
 * Whole lines of `file` between byte offsets `start` and `end`, newest
 * first, as Buffers without their newline. A line cut by either offset is
 * left out, as is one longer than LINE_MAX_BYTES.
 */
function* linesBackward(file, { start = 0, end = Infinity, fsImpl = fs } = {}) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(fd).size;
    const stop = Math.max(0, Math.min(start, size));
    let pos = Math.max(stop, Math.min(end, size));
    // Bytes after the last newline before `end` are a line still being written.
    let carry = [];
    let carryLen = 0;
    let sawNewline = false;
    let tooLong = false;
    while (pos > stop) {
      const n = Math.min(CHUNK_BYTES, pos - stop);
      const buf = Buffer.alloc(n);
      fsImpl.readSync(fd, buf, 0, n, pos - n);
      pos -= n;
      let hi = n;
      for (let i = n - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (sawNewline && !tooLong) {
          const line = Buffer.concat([buf.subarray(i + 1, hi), ...carry]);
          if (line.length) yield line;
        }
        sawNewline = true;
        tooLong = false;
        carry = [];
        carryLen = 0;
        hi = i;
      }
      if (sawNewline && !tooLong && hi > 0) {
        carryLen += hi;
        if (carryLen > LINE_MAX_BYTES) { tooLong = true; carry = []; } else carry.unshift(buf.subarray(0, hi));
      }
    }
    // The first line is whole only when it starts the file or follows a newline.
    if (sawNewline && !tooLong && carryLen > 0) {
      let whole = stop === 0;
      if (!whole) {
        const prev = Buffer.alloc(1);
        fsImpl.readSync(fd, prev, 0, 1, stop - 1);
        whole = prev[0] === 0x0a;
      }
      if (whole) yield Buffer.concat(carry);
    }
  } catch {
    // Unreadable: no lines.
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Whole lines of `file` from byte offset `start` on, oldest first, as
 * Buffers without their newline. A line `start` splits is left out, as is
 * one longer than LINE_MAX_BYTES; reading stops after RAW_MAX_BYTES.
 */
function* linesForward(file, { start = 0, fsImpl = fs } = {}) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(fd).size;
    let pos = Math.max(0, Math.min(start, size));
    let skip = false;
    if (pos > 0) {
      const prev = Buffer.alloc(1);
      fsImpl.readSync(fd, prev, 0, 1, pos - 1);
      skip = prev[0] !== 0x0a;
    }
    const limit = Math.min(size, pos + RAW_MAX_BYTES);
    let carry = [];
    let carryLen = 0;
    while (pos < limit) {
      const n = Math.min(CHUNK_BYTES, limit - pos);
      const buf = Buffer.alloc(n);
      fsImpl.readSync(fd, buf, 0, n, pos);
      pos += n;
      let lo = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue;
        if (!skip && carryLen + (i - lo) <= LINE_MAX_BYTES) {
          const line = Buffer.concat([...carry, buf.subarray(lo, i)]);
          if (line.length) yield line;
        }
        skip = false;
        carry = [];
        carryLen = 0;
        lo = i + 1;
      }
      if (lo < n && !skip) {
        carryLen += n - lo;
        if (carryLen > LINE_MAX_BYTES) { skip = true; carry = []; carryLen = 0; } else carry.push(buf.subarray(lo));
      }
    }
  } catch {
    // Unreadable: no more lines.
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The newest whole lines of `file` before byte offset `end` that fit in
 * `maxBytes`, as JSONL text, oldest first. A line over SHRINK_LINE_BYTES
 * is parsed and passed through `shrink` (which swaps its images' base64 for
 * references), and one that still does not fit, or does not parse, is
 * skipped: the lines before it are kept.
 */
function historyTail(file, { end = Infinity, maxBytes, shrink = e => e, fsImpl = fs } = {}) {
  const kept = [];
  let used = 0;
  let raw = 0;
  for (const buf of linesBackward(file, { end, fsImpl })) {
    raw += buf.length + 1;
    if (raw > RAW_MAX_BYTES) break;
    let line;
    if (buf.length <= SHRINK_LINE_BYTES) {
      line = buf.toString('utf8');
    } else {
      try { line = JSON.stringify(shrink(JSON.parse(buf.toString('utf8')))); } catch { continue; }
    }
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) continue;
    if (used + bytes > maxBytes) break;
    used += bytes;
    kept.push(line);
  }
  return kept.length ? `${kept.reverse().join('\n')}\n` : '';
}

module.exports = { CHUNK_BYTES, LINE_MAX_BYTES, RAW_MAX_BYTES, SHRINK_LINE_BYTES, historyTail, linesBackward, linesForward };
