/**
 * Project icons' images: the pure checks an
 * image passes before it's stored, whether it was read from a repository or
 * uploaded. Its type comes from its bytes, never a file name or a header, and
 * it's one of five raster types: SVG icons are a later step of their own (the
 * allowlist they must pass). The orchestrator
 * never serves an icon from a URL of its own: a project's icons travel inline,
 * as data: URIs in the project view its owner reads (iconSrc).
 */
import { createHash } from 'node:crypto';

/**
 * The most an icon's image may be: a favicon is a few KiB (termag's own are 0.4 to 4), and every icon a
 * project shows travels inline in its owner's project list, so a larger app icon is simply not a candidate.
 */
export const ICON_MAX_BYTES = 32 * 1024;

export type IconMime = 'image/png' | 'image/x-icon' | 'image/gif' | 'image/jpeg' | 'image/webp';

const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0) => bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** What an image is, from its first bytes; null for anything that isn't one of the five. */
export function sniffIcon(b: Uint8Array): IconMime | null {
  if (b.length >= 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // ICO: reserved 0, type 1, then at least one image.
  if (b.length >= 6 && startsWith(b, [0, 0, 1, 0]) && (b[4] | (b[5] << 8)) > 0) return 'image/x-icon';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 3 && startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A PNG's size from its header, or null when it's not a PNG with one. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || !startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || ascii(b, 12, 16) !== 'IHDR') return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** An icon as the browser draws it: a data: URI, inline in the view that names it. */
export function iconSrc(icon: { mimeType: string; data: Uint8Array }): string {
  return `data:${icon.mimeType};base64,${Buffer.from(icon.data).toString('base64')}`;
}

export type CheckedIcon = { ok: true; mimeType: IconMime; sha256: string; data: Buffer } | { ok: false; error: string };

/** The checks every stored icon passes: its size and its type, from its bytes. */
export function checkIcon(input: Uint8Array): CheckedIcon {
  if (input.length === 0) return { ok: false, error: 'The image is empty' };
  if (input.length > ICON_MAX_BYTES) return { ok: false, error: `Keep the image to ${ICON_MAX_BYTES / 1024} KB` };
  const mimeType = sniffIcon(input);
  if (!mimeType) return { ok: false, error: 'That is not a PNG, ICO, GIF, JPEG or WebP image' };
  const data = Buffer.from(input);
  return { ok: true, mimeType, sha256: createHash('sha256').update(data).digest('hex'), data };
}

// ── The choice ──────────────────────────────────────────────────────────────

/** What a project shows: automatic (each repository's detected icon, else its letter), the letters, or an image. */
export type IconChoice = 'auto' | 'letter' | 'image';

/** The stored iconChoice as the API says it: null is automatic, and an image that's gone is automatic too. */
export function iconChoiceOf(row: { iconChoice: string | null; iconId: string | null }): { choice: IconChoice; imageId: string | null } {
  if (row.iconChoice === 'letter') return { choice: 'letter', imageId: null };
  if (row.iconChoice === 'image' && row.iconId) return { choice: 'image', imageId: row.iconId };
  return { choice: 'auto', imageId: null };
}

export type IconChoicePlan =
  | { ok: true; iconChoice: string | null; iconId: string | null }
  | { ok: false; error: string };

/** A PUT …/icon body: `{ choice: 'auto' | 'letter' }` or `{ choice: 'image', iconId }`. */
export function planIconChoice(body: unknown): IconChoicePlan {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (b.choice === 'auto') return { ok: true, iconChoice: null, iconId: null };
  if (b.choice === 'letter') return { ok: true, iconChoice: 'letter', iconId: null };
  if (b.choice === 'image') {
    if (typeof b.iconId !== 'string' || !b.iconId.trim() || b.iconId.length > 64) return { ok: false, error: 'Name the image: iconId' };
    return { ok: true, iconChoice: 'image', iconId: b.iconId.trim() };
  }
  return { ok: false, error: "choice is 'auto', 'letter' or 'image'" };
}
