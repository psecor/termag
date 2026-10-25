'use strict';
/**
 * The `read-image` RPC: hand an image file on this box back as base64, for
 * the web terminal's hover preview of image paths an agent printed (a
 * Playwright screenshot in its scratchpad, say).
 *
 * Only images leave: the type comes from the file's magic bytes, never its
 * name, and only raster types a browser renders without running anything
 * (no SVG). Whoever may reach the session already has a shell on this box,
 * so the path itself is not restricted beyond being absolute (or `~/`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAPABILITIES = ['read-image-v1'];
const READ_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const SIGNATURES = [
  { mime: 'image/png', test: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
  { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

/** The image type `buf` starts with, or null. */
function sniffImageMime(buf) {
  const hit = SIGNATURES.find((s) => s.test(buf));
  return hit ? hit.mime : null;
}

/** `~/x` → `$HOME/x`; anything not absolute after that is refused. */
function resolveImagePath(p, home = os.homedir()) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error('path required');
  const expanded = p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  return path.normalize(expanded);
}

/**
 * `{ path }` → `{ ok: true, mime, data, size }`, or `{ ok: true, data: null }`
 * when there is no such file. Throws (the agent answers with the message) on a
 * relative path, a directory, a file over `maxBytes`, or one that is not an image.
 */
async function readImageRpc(msg, { remapPath = (p) => p, maxBytes = READ_IMAGE_MAX_BYTES, home } = {}) {
  const p = remapPath(resolveImagePath(msg && msg.path, home));
  let st;
  try {
    st = await fs.promises.stat(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { ok: true, data: null };
    throw err;
  }
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > maxBytes) throw new Error(`image too large (limit ${maxBytes} bytes)`);
  const buf = await fs.promises.readFile(p);
  // Checked again on what was read: the file may have grown since the stat.
  if (buf.length > maxBytes) throw new Error(`image too large (limit ${maxBytes} bytes)`);
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error('not an image');
  return { ok: true, mime, data: buf.toString('base64'), size: buf.length };
}

module.exports = { CAPABILITIES, READ_IMAGE_MAX_BYTES, sniffImageMime, resolveImagePath, readImageRpc };
