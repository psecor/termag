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

const TEXT_PLAIN = 'text/plain; charset=utf-8';

/**
 * Only types a browser displays without running anything: images, PDF,
 * video, audio, and text-like files, which are always text/plain (never
 * their "real" types) so they display as source. Never add html, htm, svg,
 * xml, xhtml, js, mjs or anything else a browser executes or renders as
 * active content.
 */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  txt: TEXT_PLAIN, md: TEXT_PLAIN, markdown: TEXT_PLAIN, json: TEXT_PLAIN, csv: TEXT_PLAIN, tsv: TEXT_PLAIN,
  log: TEXT_PLAIN, diff: TEXT_PLAIN, patch: TEXT_PLAIN, yaml: TEXT_PLAIN, yml: TEXT_PLAIN, toml: TEXT_PLAIN,
};

export function extensionOf(path: string): string {
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
 * images, PDFs, video, audio and text-like files (INLINE_TYPES), and then
 * with a content type chosen here from the extension, so an uploader's
 * Content-Type can never make a URL render as HTML or SVG. Everything else
 * is an attachment.
 */
export function downloadResponseHeaders(path: string, inline: boolean): { contentDisposition: string; contentType?: string } {
  const type = INLINE_TYPES[extensionOf(path)];
  if (inline && type) return { contentDisposition: dispositionHeader('inline', baseName(path)), contentType: type };
  return { contentDisposition: dispositionHeader('attachment', baseName(path)) };
}

const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml',
  'sh', 'bash', 'zsh', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'swift', 'sql', 'css', 'scss', 'tf', 'hcl', 'proto', 'graphql', 'diff', 'patch',
];
const VIEW_TYPES: Record<string, string> = {
  ...INLINE_TYPES,
  ...Object.fromEntries(TEXT_EXTENSIONS.map(ext => [ext, TEXT_PLAIN])),
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
};
const RENDERED: Record<string, Exclude<ViewRender, 'frame'>> = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', svg: 'svg' };

/**
 * How the file view shows a file. `frame`: the URL goes straight into an
 * iframe for the browser's own viewer. The rest are fetched as text and
 * rendered by the client: `markdown` by termag's renderer, `html` as the
 * `srcdoc` of an iframe sandboxed without `allow-same-origin`, `svg` as a
 * `data:` URL in an `<img>`.
 */
export type ViewRender = 'frame' | 'markdown' | 'html' | 'svg';

/**
 * The response headers a file-viewer URL is signed with and how the client
 * renders it, or null when the browser has no viewer for the type (the
 * client offers a download). The type comes from the extension, as for
 * downloadResponseHeaders. HTML and SVG are signed as `text/plain`, like
 * Markdown, so the URL itself never renders markup or runs script, even
 * opened in a tab; download and "open" links keep using
 * downloadResponseHeaders, which makes them an octet-stream attachment.
 */
export function viewResponseHeaders(path: string): { contentDisposition: string; contentType: string; render: ViewRender } | null {
  const ext = extensionOf(path);
  const rendered = RENDERED[ext];
  const render: ViewRender = rendered ?? 'frame';
  const type = rendered ? TEXT_PLAIN : VIEW_TYPES[ext];
  if (!type) return null;
  return { contentDisposition: dispositionHeader('inline', baseName(path)), contentType: type, render };
}

/** Defaulted and bounded, never trusted for rendering (downloadResponseHeaders decides that). */
export function uploadContentType(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'application/octet-stream';
  const value = raw.trim();
  return /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(value) && value.length <= 200 ? value : 'application/octet-stream';
}
