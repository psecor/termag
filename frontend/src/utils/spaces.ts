// Pure helpers for the spaces UI. The backend is the
// authority on every path and role; these only shape what the browser shows
// and sends.

export type SpaceRole = 'owner' | 'editor' | 'viewer';

export const SPACE_ROLES: SpaceRole[] = ['owner', 'editor', 'viewer'];

// Mirrors backend services/spaces/spacePaths.ts.
export const SPACE_NAME_RE = /^[a-z0-9-]{2,40}$/;
export const SPACE_NAME_HINT = '2-40 characters of a-z, 0-9 and -';

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function roleAtLeast(role: string | undefined, needed: SpaceRole): boolean {
  return role !== undefined && role in RANK && RANK[role as SpaceRole] >= RANK[needed];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export interface Crumb { name: string; prefix: string }

/** `a/b/` → space root, `a/`, `a/b/`. */
export function breadcrumbs(spaceName: string, prefix: string): Crumb[] {
  const out: Crumb[] = [{ name: spaceName, prefix: '' }];
  let acc = '';
  for (const part of prefix.split('/').filter(Boolean)) {
    acc += `${part}/`;
    out.push({ name: part, prefix: acc });
  }
  return out;
}

/**
 * A file's direct browser link, `<origin><base>files/<space>/<path>`, each
 * segment percent-encoded. Mirrors backend services/spaces/spaceLinks.ts; the
 * backend answers it with a redirect to the file for anyone who can read the
 * space. `base` is Vite's BASE_URL (`/termag/`).
 */
export function spaceFileLink(origin: string, base: string, space: string, path: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${origin}${root}files/${encodeURIComponent(space)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The space and path a file link names, for a link on this origin under
 * `base`; null for any other URL. The inverse of spaceFileLink, checked the
 * way backend services/spaces/spaceLinks.ts parseSpaceFileLink checks it.
 */
export function parseSpaceFileLink(href: string, origin: string, base: string): { space: string; path: string } | null {
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  const root = `${base.endsWith('/') ? base : `${base}/`}files/`;
  if (!url.pathname.startsWith(root)) return null;
  const segments = url.pathname.slice(root.length).split('/');
  if (segments.length < 2) return null;
  let decoded: string[];
  try { decoded = segments.map(decodeURIComponent); } catch { return null; }
  const [space, ...rest] = decoded;
  if (!SPACE_NAME_RE.test(space)) return null;
  if (rest.some(s => s === '' || s === '.' || s === '..')) return null;
  return { space, path: rest.join('/') };
}

/** The folder a path sits in: `a/b/c.txt` → `a/b/`. */
export function parentPrefix(path: string): string {
  const bare = path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = bare.lastIndexOf('/');
  return slash < 0 ? '' : bare.slice(0, slash + 1);
}

/**
 * A folder or file name typed into the UI, checked the way the backend
 * normalizes paths: no slashes, no `.`/`..`, no control characters.
 */
export function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'A name is required';
  if (n.includes('/')) return 'A name cannot contain /';
  if (n === '.' || n === '..') return 'That name is reserved';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(n)) return 'A name cannot contain control characters';
  if (new TextEncoder().encode(n).length > 255) return 'That name is too long';
  return null;
}

/** A file dropped or picked for upload, with its path below the folder it lands in. */
export interface DroppedFile { file: File; rel: string }

/** The slice of the File and Directory Entries API a drop walk uses. */
export interface DropEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(ok: (f: File) => void, fail: (err: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: DropEntry[]) => void, fail: (err: unknown) => void): void };
}

async function walkEntry(entry: DropEntry, base: string, out: DroppedFile[]): Promise<void> {
  const rel = base + entry.name;
  if (entry.isFile && entry.file) {
    out.push({ file: await new Promise<File>((ok, fail) => entry.file!(ok, fail)), rel });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // readEntries hands back a batch at a time and an empty batch at the end.
  for (;;) {
    const batch = await new Promise<DropEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return;
    for (const child of batch) await walkEntry(child, `${rel}/`, out);
  }
}

/**
 * Every file in a drop, folders walked, each with its path relative to the
 * drop. `entries` must be taken from the DataTransfer inside the drop event
 * (webkitGetAsEntry); a browser without it gives nulls, and the plain file
 * list is used instead.
 */
export async function collectDropped(entries: Array<DropEntry | null>, files: File[]): Promise<DroppedFile[]> {
  if (entries.length === 0 || entries.some(e => e === null)) return files.map(file => ({ file, rel: file.name }));
  const out: DroppedFile[] = [];
  for (const e of entries) await walkEntry(e!, '', out);
  return out;
}

/** nameError for every segment of a relative path. */
export function relPathError(rel: string): string | null {
  for (const seg of rel.split('/')) {
    const bad = nameError(seg);
    if (bad) return bad;
  }
  return null;
}

export type PreviewKind = 'image' | 'pdf' | 'text' | null;

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'ini', 'sh', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'sql', 'diff', 'patch']);

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * How a file previews. SVG and HTML are deliberately not images or pages
 * here: either can carry script, and a space is written by other people.
 * Text is fetched and shown as text, never rendered.
 */
export function previewKind(path: string): PreviewKind {
  const ext = extension(path);
  if (IMAGE.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT.has(ext)) return 'text';
  return null;
}

/** Text previews stop here; the rest is a download. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

export function prettyText(path: string, text: string): string {
  if (extension(path) !== 'json') return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export interface PartRange { partNumber: number; start: number; end: number }

/** Byte ranges for a multipart upload, numbered from 1 as S3 numbers parts. */
export function partRanges(size: number, partBytes: number, partCount: number): PartRange[] {
  const out: PartRange[] = [];
  for (let i = 0; i < partCount; i++) {
    const start = i * partBytes;
    out.push({ partNumber: i + 1, start, end: Math.min(size, start + partBytes) });
  }
  return out;
}

const ACTIONS: Record<string, string> = {
  'file.put': 'uploaded',
  'file.put.signed': 'started an upload of',
  'file.get': 'downloaded',
  'file.rm': 'deleted',
  'file.mv': 'moved',
  'member.add': 'added member',
  'member.role': 'changed role',
  'member.remove': 'removed member',
  'member.leave': 'left',
  'invite.add': 'invited',
  'invite.remove': 'cancelled invite',
  'box.add': 'added box',
  'box.remove': 'removed box',
  'space.rename': 'renamed space',
  'space.delete': 'deleted space',
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

export function usageLabel(used: number, quota: number): string {
  return `${formatBytes(used)} of ${formatBytes(quota)}`;
}
