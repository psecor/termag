// Other files attached in a chat that belongs to a space
// : behind chat-file-attachments-enabled, a
// file that would be kept on the box goes to the chat's own space instead,
// uploaded by the browser through the spaces API under the person's own
// session (services/spaceTransfer.ts uploadFile), so the orchestrator checks
// their role, the path, the quota and the size as for any upload. The message
// links it: `space:path` for the agent (`termag space get`), the file's browser
// link for people. Where the space can't take it, the box keeps it as before,
// and the chip says so.
import type { SpaceView, SpaceWriteCondition } from '../services/api';
import { roleAtLeast, spaceFileLink } from '../utils/spaces';
import { formatFileSize } from './chatTextFiles';

/** The folder of a space that chat attachments go under. */
export const SPACE_ATTACHMENTS_DIR = 'attachments';

/**
 * A file's name fit for a space path an agent names in a shell: its last
 * segment, plain characters, bounded, no leading dot or dash. The same rule
 * as the box's (agent/chat-files.js safeName), so a file is named alike
 * wherever it is kept.
 */
export function spaceFileName(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() || '';
  const name = base.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120).replace(/^[.-]+/, '');
  return name || 'file';
}

/** `20261107T101500Z`: the time, in UTC, to the second. */
function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/** Six random base-36 characters. */
function randomTag(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => (b % 36).toString(36)).join('');
}

/**
 * Where a file attached in a chat goes in its space:
 * `attachments/<workstream id>/<UTC stamp>-<random>/<name>`. The workstream
 * id (a cuid) keeps each chat's files together, the stamp orders them, the
 * random tag keeps two attached in the same second apart, and the file keeps
 * its own name, so `termag space get` saves it as it was called. The upload
 * says the path must be new (If-None-Match: *), so it never overwrites.
 */
export function spaceAttachmentPath(workstreamId: string, name: string, now: Date = new Date(), tag: string = randomTag()): string {
  const chat = workstreamId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'chat';
  return `${SPACE_ATTACHMENTS_DIR}/${chat}/${stamp(now)}-${tag}/${spaceFileName(name)}`;
}

/**
 * Why `space` can't take a file of `size` bytes, said before anything is
 * sent, or null where it may: the person only reads it, or it is full. A role
 * the list doesn't say is left to the orchestrator, which checks both again, and its refusal falls back the same way.
 */
export function spaceUploadRefusal(space: Pick<SpaceView, 'name' | 'role' | 'readOnly' | 'usedBytes' | 'quotaBytes'>, size: number): string | null {
  if (space.readOnly || (space.role !== undefined && !roleAtLeast(space.role, 'editor'))) return `you can only read ${space.name}`;
  if (space.quotaBytes > 0 && space.usedBytes + size > space.quotaBytes) return `${space.name} is full (${formatFileSize(space.usedBytes)} of ${formatFileSize(space.quotaBytes)})`;
  return null;
}

/** A file kept for a message: on the box (`path` under the checkout), or in `space` at `path`, linked by `url`. */
export interface KeptChatFile {
  path: string;
  name: string;
  size: number;
  /** The space it is in; absent when the box keeps it. */
  space?: string;
  /** Its browser link (spaceFileLink), when it is in a space. */
  url?: string;
  /** Why it is on the box although the chat has a space. */
  fellBack?: string;
}

/** How a file is under way: bytes sent so far, and to which space (null: to the box). */
export interface UploadProgress { sent: number; space: string | null }

type ChatFileSpace = Pick<SpaceView, 'name' | 'role' | 'readOnly' | 'usedBytes' | 'quotaBytes'>;

export interface KeepChatFileDeps {
  /** The chat's own space (chat/chatSpaces.ts chatHomeSpace), as the person's space list has it; null for none. A promise while that list loads. */
  space: ChatFileSpace | null | Promise<ChatFileSpace | null>;
  workstreamId: string;
  /**
   * The space as it is now (spacesApi.get). The chat's list is loaded once, so
   * its role and quota may be stale: where they refuse a file, this is asked
   * before the box keeps it, and its answer decides. Absent, or failing, the
   * upload is tried and the orchestrator's own checks decide.
   */
  current?: (space: string) => Promise<ChatFileSpace>;
  /** services/spaceTransfer.ts uploadFile. */
  toSpace: (space: string, path: string, file: File, onProgress: (sent: number) => void, signal: AbortSignal | undefined, condition: SpaceWriteCondition) => Promise<void>;
  /** Today's upload to the box (POST …/chat/files), which says when it waits for the box to wake. */
  toBox: (file: File, waiting: () => void) => Promise<{ path: string; name: string; size: number }>;
  /** The page's origin and base (Vite's BASE_URL), for the file's link. */
  origin: string;
  base: string;
  now?: () => Date;
}

/** An upload error's words: the orchestrator's `error`, or the error's message. */
function reasonOf(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { error?: string } } })?.response;
  if (res?.data?.error) return res.data.error;
  if (res?.status === 403) return "you can't write there";
  return (err as Error)?.message || 'the upload failed';
}

/**
 * Keeps one file for a message: in the chat's space when it has one that
 * can take it, else on the box, saying why the space didn't. A box upload
 * that fails after a space refused says both.
 */
export async function keepChatFile(file: File, waiting: () => void, progress: (p: UploadProgress) => void, deps: KeepChatFileDeps): Promise<KeptChatFile> {
  const space = await deps.space;
  let fellBack: string | undefined;
  if (space) {
    let refusal = spaceUploadRefusal(space, file.size);
    // The list's snapshot may be stale (room freed, role raised): its refusal
    // isn't the last word. The space as it is now decides; where that can't be
    // had, the upload is tried and the orchestrator refuses it if it must.
    if (refusal) {
      try {
        refusal = deps.current ? spaceUploadRefusal(await deps.current(space.name), file.size) : null;
      } catch {
        refusal = null;
      }
    }
    if (!refusal) {
      const path = spaceAttachmentPath(deps.workstreamId, file.name || 'file', deps.now?.() ?? new Date());
      try {
        progress({ sent: 0, space: space.name });
        await deps.toSpace(space.name, path, file, sent => progress({ sent, space: space.name }), undefined, { ifNoneMatch: '*' });
        return { path, name: path.slice(path.lastIndexOf('/') + 1), size: file.size, space: space.name, url: spaceFileLink(deps.origin, deps.base, space.name, path) };
      } catch (err) {
        fellBack = `${space.name} didn't take it: ${reasonOf(err)}`;
      }
    } else {
      fellBack = refusal;
    }
    progress({ sent: 0, space: null });
  }
  try {
    const kept = await deps.toBox(file, waiting);
    return fellBack ? { ...kept, fellBack } : kept;
  } catch (err) {
    throw fellBack ? new Error(`${(err as Error).message} (and ${fellBack})`) : err;
  }
}
