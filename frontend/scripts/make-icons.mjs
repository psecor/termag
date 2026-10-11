#!/usr/bin/env node
// Renders the PWA icons (public/icons/icon-*.png) from the favicon's shapes:
// a dark square, a blue chevron and a green underscore. No image library on
// the build hosts, so this is a tiny rasteriser + PNG encoder over zlib.
// Re-run after changing the favicon:  node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const BG = [0x0d, 0x11, 0x17];
const BLUE = [0x58, 0xa6, 0xff];
const GREEN = [0x3f, 0xb9, 0x50];

// Distance from p to segment ab.
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = ax + t * vx - px, dy = ay + t * vy - py;
  return Math.hypot(dx, dy);
}

function render(size) {
  // The favicon is drawn on a 32-unit grid; the maskable safe zone is the
  // central 80%, so the glyph is scaled to sit inside it.
  const u = size / 32;
  const scale = 0.72;
  const off = (32 * (1 - scale)) / 2;
  const P = (x, y) => [(off + x * scale) * u, (off + y * scale) * u];
  const stroke = 3 * scale * u / 2; // half the favicon's stroke-width 3
  const [c1x, c1y] = P(8, 10.5), [c2x, c2y] = P(14, 16), [c3x, c3y] = P(8, 21.5);
  const [l1x, l1y] = P(16.5, 22), [l2x, l2y] = P(24, 22);

  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const dChev = Math.min(segDist(cx, cy, c1x, c1y, c2x, c2y), segDist(cx, cy, c2x, c2y, c3x, c3y));
      const dLine = segDist(cx, cy, l1x, l1y, l2x, l2y);
      const cover = (d) => Math.max(0, Math.min(1, stroke - d + 0.5)); // 1px anti-alias
      let r = BG[0], g = BG[1], b = BG[2];
      const a1 = cover(dChev);
      r = r + (BLUE[0] - r) * a1; g = g + (BLUE[1] - g) * a1; b = b + (BLUE[2] - b) * a1;
      const a2 = cover(dLine);
      r = r + (GREEN[0] - r) * a2; g = g + (GREEN[1] - g) * a2; b = b + (GREEN[2] - b) * a2;
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const file = join(out, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${file}`);
}
