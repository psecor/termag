// Pure pieces of the simple UI's file explorer (pages/chat/FileExplorer.tsx)
// and file view (pages/chat/SpaceFileView.tsx).
import type { SpaceViewRender, SpaceViewUrl } from '../services/api';

/** A search reads at most this many files per space (paged `tree?recursive=1`); the rest is not searched. */
export const SEARCH_MAX_FILES_PER_SPACE = 2000;
export const SEARCH_MAX_RESULTS = 200;

export interface SearchFile { space: string; path: string; size: number; modifiedAt: string | null }

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Files, at any depth, whose name contains every word of the query,
 * case-insensitively; folder names don't match. A name that is the query
 * ranks first, then one that starts with it, then shorter paths.
 */
export function searchFiles(files: readonly SearchFile[], query: string, max = SEARCH_MAX_RESULTS): SearchFile[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const whole = words.join(' ');
  const scored: Array<{ f: SearchFile; score: number }> = [];
  for (const f of files) {
    const name = fileName(f.path).toLowerCase();
    if (!words.every(w => name.includes(w))) continue;
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    const rank = name === whole || stem === whole ? 2 : name.startsWith(words[0]) ? 1 : 0;
    scored.push({ f, score: rank * 10_000 - f.path.length });
  }
  scored.sort((a, b) => b.score - a.score || a.f.space.localeCompare(b.f.space) || a.f.path.localeCompare(b.f.path));
  return scored.slice(0, max).map(s => s.f);
}

/** `name` cut into runs, `hit` where a word of the query matches, for highlighting. */
export function matchParts(name: string, query: string): Array<{ text: string; hit: boolean }> {
  const lower = name.toLowerCase();
  const marks = new Array<boolean>(name.length).fill(false);
  for (const w of queryWords(query)) {
    for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + w.length)) marks.fill(true, at, at + w.length);
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < name.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += name[i];
    else parts.push({ text: name[i], hit: marks[i] });
  }
  return parts;
}

/** The folders (tree prefixes, '' for the root) that hold `path`, outermost first. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return ['', ...parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`)];
}

/**
 * How the file view shows a file, as the server decided it. `frame`: the
 * signed URL goes in an iframe, unsandboxed, for the browser's own image,
 * PDF, media and text viewers (Chrome refuses its PDF viewer in a sandboxed
 * frame). The rest are fetched as text: Markdown is rendered by termag, HTML
 * becomes an iframe's `srcdoc` sandboxed with no allowances, SVG a `data:`
 * URL in an `<img>`. No type the server can't show is framed.
 */
export type FileShow = { kind: SpaceViewRender } | { kind: 'download' };

export function fileShow(view: SpaceViewUrl['view']): FileShow {
  return view ? { kind: view.render } : { kind: 'download' };
}

/** Fetched as text and rendered here rather than framed. */
export function fetchesText(show: FileShow): boolean {
  return show.kind === 'markdown' || show.kind === 'html' || show.kind === 'svg';
}

/** An `<img>` src for SVG text: a data URL has an opaque origin, and SVG in an image runs no script. */
export function svgDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}
