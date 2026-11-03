/**
 * Space file changes between orchestrator processes. The process that records a put, move or remove sends it as a
 * Postgres NOTIFY on SPACE_FILE_CHANNEL; every process (both halves of an
 * overlapping deploy) hears it over its one LISTEN connection
 * (services/pgListener.ts) and tells the status sockets of the people who can
 * read the space (spaceFileFeed.ts). The payload names the space by id and the
 * path, never the contents, and stays under NOTIFY_PAYLOAD_MAX: a change whose
 * paths would not fit goes without them, which reads as "something in this
 * space changed".
 */
import { NOTIFY_PAYLOAD_MAX } from '../askReplyBus';

export const SPACE_FILE_CHANNEL = 'termag_space_file';

export type FileChangeKind = 'put' | 'mv' | 'rm';

/**
 * One change. A path ending in `/` is a folder (a move or a recursive
 * remove of everything under it). `to` is a move's destination; `etag` a
 * put's new version.
 */
export interface FileChange {
  spaceId: string;
  kind: FileChangeKind;
  path?: string;
  to?: string;
  etag?: string | null;
}

const KINDS = new Set<FileChangeKind>(['put', 'mv', 'rm']);

export function fileChangePayload(change: FileChange): string {
  const full = JSON.stringify({
    s: change.spaceId, k: change.kind,
    ...(change.path !== undefined ? { p: change.path } : {}),
    ...(change.to !== undefined ? { t: change.to } : {}),
    ...(change.etag ? { e: change.etag } : {}),
  });
  if (Buffer.byteLength(full, 'utf8') <= NOTIFY_PAYLOAD_MAX) return full;
  return JSON.stringify({ s: change.spaceId, k: change.kind });
}

/** The change in a payload, or null for anything malformed. */
export function parseFileChange(payload: string): FileChange | null {
  let v: unknown;
  try { v = JSON.parse(payload); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.s !== 'string' || !o.s || !KINDS.has(o.k as FileChangeKind)) return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
  return {
    spaceId: o.s, kind: o.k as FileChangeKind,
    ...(str(o.p) !== undefined ? { path: str(o.p) } : {}),
    ...(str(o.t) !== undefined ? { to: str(o.t) } : {}),
    ...(str(o.e) ? { etag: str(o.e) } : {}),
  };
}

/**
 * The live change a recorded SpaceEvent stands for, or null: `file.put`,
 * `file.mv` (its path is `<from> -> <to>`; a path can't hold `>`, see
 * spacePaths.ts) and `file.rm`.
 */
export function fileChangeOf(spaceId: string, action: string, path: string | null, etag: string | null): FileChange | null {
  if (path === null) return null;
  // A confirm's restore (routes/spaces.ts checkLanded) makes a new current version too.
  if (action === 'file.put' || action === 'file.put.reverted') return { spaceId, kind: 'put', path, ...(etag ? { etag } : {}) };
  if (action === 'file.rm') return { spaceId, kind: 'rm', path };
  if (action === 'file.mv') {
    const at = path.indexOf(' -> ');
    return at < 0 ? null : { spaceId, kind: 'mv', path: path.slice(0, at), to: path.slice(at + 4) };
  }
  return null;
}
