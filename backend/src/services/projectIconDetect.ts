/**
 * Finding a repository's icons ("Detecting
 * icons"): read with the owner's own `gh` token through GitHub's contents API,
 * on the default branch, never through a box. Looks in a fixed set of
 * directories for favicons, app icons and logos, and follows a web manifest's
 * icons and an index.html's <link rel="icon">. Bounded: 128 KiB a file, 8
 * images and 24 requests a repository, 10 s a request. What it returns is only
 * bytes and paths; projectIcons.ts checks each image before it's stored.
 */
import { ICON_MAX_BYTES, pngSize, sniffIcon } from './projectIcons';

/**
 * Where icons live, in the order they're looked at. A directory is listed only when its parent's listing
 * has it, so every parent of a nested one is in the list too, ahead of it (ICON_DIRS test).
 */
export const ICON_DIRS = ['', 'public', 'static', 'assets', '.github', 'app', 'src', 'src/assets', 'web', 'web/public', 'frontend', 'frontend/public', 'site', 'docs'];
export const ICON_MAX_IMAGES = 8;
export const ICON_MAX_REQUESTS = 24;
const REQUEST_MS = 10_000;
/** A manifest or index.html read for its icons. */
const PAGE_MAX_BYTES = 64 * 1024;

// Not .svg until step 6 takes SVGs: fetching one only to drop it would spend the request budget rasters need.
const ICON_NAME = /^(favicon|icon|logo|app-icon|apple-touch-icon|android-chrome|mstile)([-_.@][\w.@-]*)?\.(ico|png|jpe?g|webp|gif)$/i;
const MANIFEST_NAME = /^(manifest\.json|site\.webmanifest|manifest\.webmanifest)$/i;
const INDEX_NAME = /^index\.html?$/i;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function isIconName(name: string): boolean { return ICON_NAME.test(name); }

/** A GitHub repository's owner/name as a repo key: an owner of letters, digits and hyphens, a name of [\w.-] but not . or .. */
export function isRepoKey(key: string): boolean {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+)$/.exec(key);
  return m !== null && m[2] !== '.' && m[2] !== '..';
}

/**
 * A path from a manifest's `src` or a link's `href`, resolved in the
 * repository, or null for one outside it (another host, a data: URL, `..` past
 * the root). A root-relative ref ("/favicon.svg", "%PUBLIC_URL%/x.png") is
 * relative to the site root, which is each of `roots` in turn.
 */
export function resolveIconRef(ref: string, fromDir: string, roots: readonly string[]): string[] {
  let r = ref.trim().replace(/[?#].*$/, '');
  if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('//')) return [];
  r = r.replace(/^%PUBLIC_URL%/, '');
  const bases = r.startsWith('/') ? roots : [fromDir];
  const out: string[] = [];
  for (const base of bases) {
    const parts: string[] = base ? base.split('/') : [];
    let ok = true;
    for (const seg of r.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length === 0) { ok = false; break; } parts.pop(); continue; }
      parts.push(seg);
    }
    const path = parts.join('/');
    if (ok && path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** A web manifest's icons, as repository paths (root-relative ones against the manifest's own directory). */
export function manifestIconRefs(manifestPath: string, text: string): string[] {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return []; }
  const icons = (json as { icons?: unknown })?.icons;
  if (!Array.isArray(icons)) return [];
  const dir = dirOf(manifestPath);
  return icons.slice(0, 16).flatMap(i => (i && typeof (i as { src?: unknown }).src === 'string'
    ? resolveIconRef((i as { src: string }).src, dir, [dir]) : []));
}

/**
 * An index.html's icon links (rel icon, shortcut icon, apple-touch-icon; not
 * Safari's one-colour mask-icon). Root-relative hrefs are tried in the page's
 * `public/` first (Vite serves it at the root), then beside the page.
 */
export function htmlIconRefs(htmlPath: string, text: string): string[] {
  const dir = dirOf(htmlPath);
  const roots = dir === '' ? ['public', ''] : [dir];
  const out: string[] = [];
  for (const m of text.slice(0, PAGE_MAX_BYTES).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (value) for (const p of resolveIconRef(value, dir, roots)) if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 8);
}

/** How likely a file is the repository's icon, by name alone: which ones are fetched first. */
export function nameScore(path: string): number {
  const n = baseName(path).toLowerCase();
  const svg = n.endsWith('.svg');
  if (/^(favicon|icon)\b/.test(n)) return svg ? 100 : n.endsWith('.ico') ? 70 : 80;
  if (/^(apple-touch-icon|android-chrome|app-icon)/.test(n)) return 90;
  if (n.startsWith('mstile')) return 40;
  if (n.startsWith('logo')) return svg ? 60 : 50;
  return 30;
}

/**
 * A fetched image's rank for automatic, or null when it can't be the icon: one
 * of a type it doesn't take (an SVG, until step 6), a wordmark (not roughly
 * square), or a raster under 16 px. A square app icon of 64 px or more first,
 * then a PNG favicon, favicon.ico, a logo.
 */
export function iconScore(path: string, data: Uint8Array, linked = false): number | null {
  const mime = sniffIcon(data);
  if (!mime) return null;
  const base = nameScore(path) + (linked ? 5 : 0);
  const size = pngSize(data);
  if (size) {
    if (size.width < 16 || size.height < 16) return null;
    const aspect = size.width / size.height;
    if (aspect > 1.25 || aspect < 0.8) return null;
    // A large square raster is a better icon than its name says (an app icon); a small one a worse.
    if (Math.min(size.width, size.height) >= 64) return Math.max(base, 90) + Math.min(size.width, 512) / 1000;
    if (Math.min(size.width, size.height) < 32) return base - 15;
  }
  return base;
}

export interface FoundIcon { path: string; data: Buffer; score: number }

export type Detected =
  | { status: 'ok'; icons: FoundIcon[] }
  /** The token can't read the repository (gone, renamed, or never theirs): look again next week. */
  | { status: 'no-access' }
  /** GitHub failed, timed out or rate-limited: try again later, keep what's stored. */
  | { status: 'error'; why: string };

export interface DetectDeps {
  fetch?: typeof fetch;
  apiBase?: string;
  /** For tests: the per-request timeout. */
  requestMs?: number;
}

class Budget extends Error {}
class Retry extends Error {}
class NoAccess extends Error {}

/** Read a repository's icon candidates with `token`, best first. Never throws. */
export async function detectRepoIcons(repoKey: string, token: string, deps: DetectDeps = {}): Promise<Detected> {
  const fetchImpl = deps.fetch ?? fetch;
  const api = (deps.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const [owner, repo] = repoKey.split('/');
  if (!isRepoKey(repoKey)) return { status: 'no-access' };
  let requests = 0;

  /**
   * One request, its body read by `read` under the same deadline: a server that sends its headers and then
   * stalls is aborted at REQUEST_MS like one that never answers. Null for a 404 or another non-2xx.
   */
  async function get<T>(path: string, raw: boolean, read: (res: Response) => Promise<T>): Promise<T | null> {
    if (++requests > ICON_MAX_REQUESTS) throw new Budget();
    const url = `${api}/repos/${owner}/${repo}/contents${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.requestMs ?? REQUEST_MS);
    timer.unref?.();
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        // Not followed: a moved repository or a file served elsewhere is skipped, and the token goes nowhere else.
        redirect: 'manual',
        headers: {
          Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'termag',
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return null; }
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        const limited = res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0';
        throw limited || res.status >= 500 || res.status === 401 ? new Retry(`GitHub answered ${res.status}`) : new NoAccess();
      }
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
      return await read(res);
    } catch (err) {
      if (err instanceof Retry || err instanceof NoAccess || err instanceof Budget) throw err;
      throw new Retry(ctrl.signal.aborted ? 'timed out' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function bytes(res: Response, max: number): Promise<Buffer | null> {
    const length = Number(res.headers.get('content-length') ?? NaN);
    if (length > max) { await res.body?.cancel().catch(() => undefined); return null; }
    if (!res.body) return Buffer.from(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function list(dir: string): Promise<Array<{ name: string; path: string; type: string; size: number }>> {
    // The text first, so an abort mid-body is a timeout and only a body that isn't JSON is an empty listing.
    const body = await get(dir, false, async res => { try { return JSON.parse(await res.text()) as unknown; } catch (err) { if (err instanceof SyntaxError) return null; throw err; } });
    if (!Array.isArray(body)) return [];
    return body.slice(0, 1000).flatMap(e => (e && typeof e.name === 'string' && typeof e.path === 'string'
      ? [{ name: e.name as string, path: e.path as string, type: String(e.type), size: Number(e.size) || 0 }] : []));
  }

  try {
    // The directories: root first, then each one its parent's listing has.
    const files: Array<{ path: string; size: number }> = [];
    const pages: string[] = [];
    const listed = new Map<string, Set<string>>();
    for (const dir of ICON_DIRS) {
      if (dir !== '') {
        const parent = listed.get(dirOf(dir));
        if (!parent?.has(baseName(dir))) continue;
      }
      const entries = await list(dir);
      listed.set(dir, new Set(entries.filter(e => e.type === 'dir').map(e => e.name)));
      for (const e of entries) {
        if (e.type !== 'file') continue;
        if (ICON_NAME.test(e.name) && e.size > 0 && e.size <= ICON_MAX_BYTES) files.push({ path: e.path, size: e.size });
        else if ((MANIFEST_NAME.test(e.name) || INDEX_NAME.test(e.name)) && e.size > 0 && e.size <= PAGE_MAX_BYTES) pages.push(e.path);
      }
    }
    // Icons a manifest or a page names, which may sit in a directory not listed.
    const linked = new Set<string>();
    for (const page of pages.slice(0, 3)) {
      const data = await get(page, true, res => bytes(res, PAGE_MAX_BYTES));
      if (!data) continue;
      const text = data.toString('utf8');
      const refs = INDEX_NAME.test(baseName(page)) ? htmlIconRefs(page, text) : manifestIconRefs(page, text);
      for (const r of refs) linked.add(r);
    }
    const known = new Set(files.map(f => f.path));
    const order = [
      ...files.map(f => ({ path: f.path, linked: linked.has(f.path) })),
      ...[...linked].filter(p => !known.has(p) && /\.(ico|png|jpe?g|webp|gif)$/i.test(p)).map(path => ({ path, linked: true })),
    ].sort((a, b) => nameScore(b.path) + (b.linked ? 5 : 0) - nameScore(a.path) - (a.linked ? 5 : 0) || a.path.localeCompare(b.path));
    const icons: FoundIcon[] = [];
    const seen = new Set<string>();
    for (const c of order) {
      if (icons.length >= ICON_MAX_IMAGES || seen.has(c.path)) continue;
      seen.add(c.path);
      let data: Buffer | null;
      try { data = await get(c.path, true, res => bytes(res, ICON_MAX_BYTES)); } catch (err) { if (err instanceof Budget) break; throw err; }
      if (!data) continue;
      const score = iconScore(c.path, data, c.linked);
      if (score !== null) icons.push({ path: c.path, data, score });
    }
    icons.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { status: 'ok', icons };
  } catch (err) {
    if (err instanceof NoAccess) return { status: 'no-access' };
    if (err instanceof Budget) return { status: 'error', why: 'request budget' };
    if (err instanceof Retry) return { status: 'error', why: err.message };
    return { status: 'error', why: (err as Error).message };
  }
}
