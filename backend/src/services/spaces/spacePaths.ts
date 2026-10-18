/**
 * Paths inside a space, and the S3 keys built from them.
 *
 * The client only ever sends a path; the server builds every key as
 * `<spaceId>/<path>` from the space id it authorised, so no request can name
 * another space's objects. A cuid is fixed-length and every prefix built here
 * ends in `/`, so no space's prefix contains another's.
 *
 * Pure: no S3, no Prisma.
 */

export const MAX_KEY_BYTES = 1024;
export const SPACE_NAME_RE = /^[a-z0-9-]{2,40}$/;

export class SpacePathError extends Error {
  readonly code = 'invalid_path';
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * Box agents run `termag space …` through a shell, and a path from a listing
 * is text another member wrote; these are the characters that let such a path
 * run a command or break out of quoting there. Spaces, parentheses and glob
 * characters stay allowed: they are common in filenames and run nothing.
 */
export const SHELL_META_RE = /[$`'";|&<>]/;

function checkSegments(path: string): void {
  if (path.includes('\\')) throw new SpacePathError('Paths cannot contain a backslash');
  if (CONTROL_RE.test(path)) throw new SpacePathError('Paths cannot contain control characters');
  const meta = SHELL_META_RE.exec(path);
  if (meta) throw new SpacePathError(`Paths cannot contain ${meta[0]} (or any of $ \` ' " ; | & < >)`);
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new SpacePathError(`Invalid path segment ${JSON.stringify(seg)}`);
    }
  }
}

/** A file path: NFC, no leading or trailing `/`, no empty, `.` or `..` segment. */
export function normalizeFilePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new SpacePathError('A path is required');
  const path = raw.normalize('NFC');
  if (path.startsWith('/')) throw new SpacePathError('Paths are relative to the space; drop the leading /');
  if (path.endsWith('/')) throw new SpacePathError('A file path cannot end in /');
  checkSegments(path);
  return path;
}

/** A directory prefix: '' for the root, otherwise a normalized path ending in `/`. */
export function normalizePrefix(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '' || raw === '/') return '';
  if (typeof raw !== 'string') throw new SpacePathError('A prefix must be a string');
  const path = raw.normalize('NFC');
  if (path.startsWith('/')) throw new SpacePathError('Paths are relative to the space; drop the leading /');
  const bare = path.endsWith('/') ? path.slice(0, -1) : path;
  checkSegments(bare);
  return `${bare}/`;
}

export function spacePrefix(spaceId: string): string {
  if (!spaceId || spaceId.includes('/')) throw new Error('spacePrefix: bad space id');
  return `${spaceId}/`;
}

/** `<spaceId>/<path>`; `path` must already be normalized (file or prefix). */
export function objectKey(spaceId: string, path: string): string {
  const key = spacePrefix(spaceId) + path;
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new SpacePathError(`Path is too long (the key may be at most ${MAX_KEY_BYTES} bytes)`);
  }
  return key;
}

/** The path inside the space for a key this server built; null if it is not under the space. */
export function pathOfKey(spaceId: string, key: string): string | null {
  const prefix = spacePrefix(spaceId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/**
 * Where `path` lands when moving `from` to `to`. A directory move (`from`
 * ends in `/`) keeps the part below it; a file move is just `to`.
 */
export function movedPath(from: string, to: string, path: string): string {
  if (!from.endsWith('/')) return to;
  if (!path.startsWith(from)) throw new Error('movedPath: path is not under from');
  return to + path.slice(from.length);
}

export function validateSpaceName(raw: unknown): string {
  if (typeof raw !== 'string' || !SPACE_NAME_RE.test(raw)) {
    throw new SpacePathError('A space name is 2-40 characters of a-z, 0-9 and -');
  }
  return raw;
}

const INLINE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dispositionHeader(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The response headers a download URL is signed with. Inline only for
 * images, PDFs and plain text, and then with a content type chosen here from
 * the extension, so an uploader's Content-Type can never make a URL render as
 * HTML or SVG. Everything else is an attachment.
 */
export function downloadResponseHeaders(path: string, inline: boolean): { contentDisposition: string; contentType?: string } {
  const type = INLINE_TYPES[extensionOf(path)];
  if (inline && type) return { contentDisposition: dispositionHeader('inline', baseName(path)), contentType: type };
  return { contentDisposition: dispositionHeader('attachment', baseName(path)) };
}

/** Defaulted and bounded, never trusted for rendering (downloadResponseHeaders decides that). */
export function uploadContentType(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'application/octet-stream';
  const value = raw.trim();
  return /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(value) && value.length <= 200 ? value : 'application/octet-stream';
}
