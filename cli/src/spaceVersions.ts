import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkInSpaces } from './spacesPath.js';

/**
 * The version of each space file this user last read on this box,
 * so a later write can say which one it
 * replaces: `termag space get`, `space memory ls`/`cat` and the memory sync
 * record it, and `space put`, `mv`, `rm` and `memory edit` send it as
 * If-Match. A write that would replace any other version is refused (exit 6).
 *
 * One file per space, ~/.termag/spaces/.versions/<space>.json, outside the
 * memory copy (~/.termag/spaces/<space>/), which a sync swaps out whole.
 * Last writer wins between two CLIs at once: the cache is a hint, the
 * orchestrator's check is the guard.
 */

const SPACE_NAME_RE = /^[a-z0-9-]{2,40}$/;
const MAX_ENTRIES = 5000;

export interface ReadVersion { etag: string; versionId?: string | null; at: string; via: string }
interface VersionFile { version: 1; files: Record<string, ReadVersion> }

export function versionsPath(home: string, space: string): string {
  if (!SPACE_NAME_RE.test(space)) throw new Error(`Not a space name: ${JSON.stringify(space)}`);
  return join(home, '.termag', 'spaces', '.versions', `${space}.json`);
}

function read(home: string, space: string): VersionFile {
  try {
    const v = JSON.parse(readFileSync(versionsPath(home, space), 'utf8')) as VersionFile;
    if (v && v.version === 1 && v.files && typeof v.files === 'object') return v;
  } catch { /* none yet, or unreadable: start over */ }
  return { version: 1, files: {} };
}

function write(home: string, space: string, v: VersionFile): void {
  // Inside ~/.termag/spaces and through no symlink (a planted `.versions` link would take the write elsewhere).
  const file = checkInSpaces(home, versionsPath(home, space));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  checkInSpaces(home, file);
  const entries = Object.entries(v.files);
  if (entries.length > MAX_ENTRIES) {
    // Oldest reads go first: they are the ones least likely to be written back.
    v.files = Object.fromEntries(entries.sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, MAX_ENTRIES));
  }
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The version of `space:path` this client read last, or null. */
export function versionOf(home: string, space: string, path: string): ReadVersion | null {
  return read(home, space).files[path] ?? null;
}

/** Records reads (or writes, whose result is the version now known) of several paths at once. */
export function rememberVersions(home: string, space: string, seen: Array<{ path: string; etag: string | null | undefined; versionId?: string | null }>, via: string): void {
  const known = seen.filter(s => typeof s.etag === 'string' && s.etag);
  if (!known.length) return;
  const v = read(home, space);
  const at = new Date().toISOString();
  for (const s of known) v.files[s.path] = { etag: s.etag!, ...(s.versionId ? { versionId: s.versionId } : {}), at, via };
  write(home, space, v);
}

export function rememberVersion(home: string, space: string, path: string, etag: string | null | undefined, versionId: string | null | undefined, via: string): void {
  rememberVersions(home, space, [{ path, etag, versionId }], via);
}

/** Forgets `path`, or everything under a folder `path` ending in `/`. */
export function forgetVersions(home: string, space: string, path: string): void {
  const v = read(home, space);
  const before = Object.keys(v.files).length;
  for (const p of Object.keys(v.files)) if (p === path || (path.endsWith('/') && p.startsWith(path)) || path === '') delete v.files[p];
  if (Object.keys(v.files).length !== before) write(home, space, v);
}
