'use strict';
/**
 * Images in simple-UI chat messages. The
 * backend sends them with chat-send as base64; they are kept on this box
 * under ~/.termag/chat-images/<chat key>/<sha256>.<ext>, named by their own
 * bytes, and go to Claude as stream-json image content blocks, which Claude
 * Code passes to the model as images (a file path in a text prompt would
 * need a Read call, which an untrusted turn may not be allowed).
 *
 * Claude Code's transcript keeps each image's base64. Events and history
 * leave this box with that data swapped for a `termag` source naming the
 * stored file, which the browser fetches through GET /api/projects/:id/image
 * (the read-image RPC), so a chat's frames and history stay small.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sniffImageMime } = require('./read-image');

const CAPABILITIES = ['chat-images-v1'];
const MAX_IMAGES = 4;
// The Messages API takes at most 5 MB of base64 per image.
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID_RE = /^[0-9a-f]{64}$/;
const IMAGES_ROOT = '.termag/chat-images';

/** Where a chat's images live, as the `~/` path the browser asks read-image for. */
function homePath(chatKey, id, mediaType) {
  return `~/${IMAGES_ROOT}/${chatKey}/${id}.${EXT[mediaType]}`;
}

/**
 * The images a chat-send carries, checked: at most MAX_IMAGES, each base64
 * of a PNG, JPEG, GIF or WebP (by its bytes, not the declared type) of at
 * most MAX_IMAGE_BYTES. Returns the decoded images; throws `image-refused:`.
 */
function decodeImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new Error('image-refused: images must be a list');
  if (images.length > MAX_IMAGES) throw new Error(`image-refused: at most ${MAX_IMAGES} images per message`);
  return images.map((img, i) => {
    const data = img && typeof img.data === 'string' ? img.data : null;
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`image-refused: image ${i + 1} is not base64`);
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image-refused: image ${i + 1} is larger than ${MAX_IMAGE_BYTES} bytes`);
    const mediaType = sniffImageMime(buf);
    if (!mediaType) throw new Error(`image-refused: image ${i + 1} is not a PNG, JPEG, GIF or WebP`);
    return { buf, mediaType };
  });
}

function createImageStore(home, fsImpl = fs) {
  const dirFor = chatKey => path.join(home, IMAGES_ROOT, chatKey);
  const fileFor = (chatKey, id, mediaType) => path.join(dirFor(chatKey), `${id}.${EXT[mediaType]}`);

  /** Keep one image for a chat; returns its reference. Idempotent: the name is the bytes' hash. */
  function save(chatKey, buf, mediaType) {
    const id = crypto.createHash('sha256').update(buf).digest('hex');
    const file = fileFor(chatKey, id, mediaType);
    if (!fsImpl.existsSync(file)) {
      fsImpl.mkdirSync(dirFor(chatKey), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, buf, { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    }
    return { id, mediaType, path: homePath(chatKey, id, mediaType) };
  }

  /** The stream-json image block for a stored reference, or null when the file is gone. */
  function block(chatKey, ref) {
    if (!ref || !ID_RE.test(ref.id) || !EXT[ref.mediaType]) return null;
    let buf;
    try { buf = fsImpl.readFileSync(fileFor(chatKey, ref.id, ref.mediaType)); } catch { return null; }
    return { type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: buf.toString('base64') } };
  }

  /**
   * A message's content with every base64 image (its own, or one inside a
   * tool result) replaced by a reference to the stored copy, saved on the
   * way when this box does not have it yet (an image Read returned).
   */
  function strip(chatKey, content) {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map(part => {
      if (part && part.type === 'image' && part.source && part.source.type === 'base64' && typeof part.source.data === 'string') {
        const buf = Buffer.from(part.source.data, 'base64');
        const mediaType = sniffImageMime(buf);
        changed = true;
        if (!mediaType) return { type: 'image', source: { type: 'termag', media_type: part.source.media_type || null, path: null } };
        const ref = save(chatKey, buf, mediaType);
        return { type: 'image', source: { type: 'termag', media_type: mediaType, id: ref.id, path: ref.path } };
      }
      if (part && part.type === 'tool_result' && Array.isArray(part.content)) {
        const inner = strip(chatKey, part.content);
        if (inner !== part.content) { changed = true; return { ...part, content: inner }; }
      }
      return part;
    });
    return changed ? out : content;
  }

  /** A stream-json event or transcript entry, with its message's images stripped. */
  function stripEvent(chatKey, ev) {
    if (!ev || ev.type !== 'user' || !ev.message || !Array.isArray(ev.message.content)) return ev;
    const content = strip(chatKey, ev.message.content);
    return content === ev.message.content ? ev : { ...ev, message: { ...ev.message, content } };
  }

  return { save, block, strip, stripEvent };
}

/** A user message's content: its images first, then its text (the order the Messages API recommends). */
function userContent(text, blocks) {
  if (!blocks || !blocks.length) return text;
  return [...blocks, ...(text ? [{ type: 'text', text }] : [])];
}

module.exports = { CAPABILITIES, MAX_IMAGES, MAX_IMAGE_BYTES, createImageStore, decodeImages, homePath, userContent };
