// Where an image in a space file's Markdown points (the simple UI's file
// view, pages/chat/SpaceMarkdownImage.tsx). Only a file in the same space is
// ever fetched: a relative path (resolved against the Markdown file's folder,
// `../` included, never above the space's root), a path from the root
// (`/artifacts/a.png`), `<this space>:<path>`, or this origin's file link
// (`…/termag/files/<this space>/<path>`). Anything else is never fetched: an
// http(s) image, another space's file, or a `space:path` of another space is
// a link; a data: URL, any other scheme, or a path that climbs out of the
// space is its alt text alone. Chat replies don't use this: their images stay
// links (chat/Markdown.tsx).
import { parseSpaceFileLink, spaceFileLink, SPACE_NAME_RE } from '../utils/spaces';

export type SpaceImageTarget =
  /** A file in this space: shown inline. */
  | { kind: 'file'; space: string; path: string }
  /** Not fetched, a link to it. */
  | { kind: 'link'; href: string }
  /** Not fetched and not a link: the alt text alone. */
  | { kind: 'none' };

export interface SpaceImageFrom {
  /** The space the Markdown file is in. */
  space: string;
  /** The Markdown file's path in it. */
  path: string;
  /** `window.location.origin` and Vite's BASE_URL, for file links. */
  origin: string;
  base: string;
}

// Schemes that are never a space's name, though they'd pass SPACE_NAME_RE.
const NOT_SPACES = new Set(['data', 'blob', 'file', 'javascript', 'vbscript', 'about', 'mailto', 'ftp', 'ws', 'wss', 'termag-compose']);
const NONE: SpaceImageTarget = { kind: 'none' };

/** `segments` applied to `start` (folder names); null if a `..` climbs above the root. */
function walk(start: string[], segments: string[]): string[] | null {
  const out = [...start];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

/** A percent-encoded path, decoded and resolved; null if it leaves the space or names a folder. */
function resolvePath(dir: string[], raw: string): string | null {
  const bare = raw.replace(/[?#].*$/, '');
  // Only runs of valid `%XX` are decoded: a bare `%` (`100%.png`) or one that isn't UTF-8 stays in the name.
  const decoded = bare.replace(/(?:%[0-9a-f]{2})+/gi, run => { try { return decodeURIComponent(run); } catch { return run; } });
  if (/[\u0000-\u001f\\]/.test(decoded)) return null;
  const segments = decoded.split('/');
  // A folder (`..`, `./`, `a/`) is no image.
  if (['', '.', '..'].includes(segments[segments.length - 1])) return null;
  const out = walk(dir, segments);
  return out && out.length ? out.join('/') : null;
}

export function resolveSpaceImage(dest: string, from: SpaceImageFrom): SpaceImageTarget {
  const src = dest.trim();
  if (!src) return NONE;
  const dir = from.path.split('/').slice(0, -1).filter(Boolean);
  if (/^https?:\/\//i.test(src)) {
    const file = parseSpaceFileLink(src, from.origin, from.base);
    if (file && file.space === from.space && file.path) return { kind: 'file', space: file.space, path: file.path };
    return { kind: 'link', href: src };
  }
  // A scheme-relative URL is another host's; any other scheme isn't ours to load.
  if (src.startsWith('//')) return NONE;
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(src);
  if (scheme) {
    const [, name, rest] = scheme;
    if (NOT_SPACES.has(name.toLowerCase()) || !SPACE_NAME_RE.test(name) || rest.startsWith('//')) return NONE;
    const path = resolvePath([], rest);
    if (!path) return NONE;
    if (name === from.space) return { kind: 'file', space: name, path };
    return { kind: 'link', href: spaceFileLink(from.origin, from.base, name, path) };
  }
  const path = resolvePath(src.startsWith('/') ? [] : dir, src);
  return path ? { kind: 'file', space: from.space, path } : NONE;
}
