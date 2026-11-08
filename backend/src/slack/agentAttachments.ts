/**
 * Files an agent reply asks to attach with `[attach: path]` (agentSession.ts).
 *
 * Claude picks the path, so it is checked before anything is uploaded to a
 * thread other people may read: inside the project or this turn's own temp
 * directory (after symlinks; with no project only that directory, not the
 * whole home), in that directory only this process's user's own files, no
 * dot-directory or dotfile on the way (.ssh, .aws, .env), an image or plain
 * document type (not json, log or html, the types that most often hold config
 * and tokens), and at most 20 MB. Files in the project may belong to its owner's
 * unix user rather than this process's, so ownership is checked in temp only.
 *
 * The temp directory is per run (createRunTempDir), not the shared /tmp: every
 * operator's turn runs as the same unix user, so an ownership check there could
 * not tell one person's files from another's, and one person's turn could offer
 * a file another person's turn wrote.
 *
 * These checks are the backstop, not the approval: nothing is uploaded until
 * the person the turn is for presses Share on a question that shows the file's
 * name, size and path (offerAttachments). Claude runs with bypassPermissions
 * and could copy any file somewhere allowed, so a check alone would not do.
 */

import { mkdtemp, readdir, realpath, rm, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { WebClient } from '@slack/web-api';

const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'pdf', 'csv', 'txt', 'md', 'diff', 'patch',
]);
const MAX_BYTES = 20 * 1024 * 1024;

export type AttachmentCheck = { ok: true; path: string; filename: string } | { ok: false; reason: string };

/** The names of per-run temp directories, directly under the OS temp directory. */
const RUN_DIR_PREFIX = 'termag-slack-run-';
/**
 * How long a run's temp directory is kept: its files wait behind a Share
 * question the person may answer hours later. Older ones are removed when a
 * new run starts, and sharing from them then says the file is gone.
 */
export const RUN_DIR_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A new, empty temp directory for one agent run (mode 0700, from mkdtemp), the
 * only temp location its attachments may come from. Directories older than
 * RUN_DIR_TTL_MS are removed first, best effort.
 */
export async function createRunTempDir(base: string = tmpdir(), now: number = Date.now()): Promise<string> {
  await pruneRunTempDirs(base, now).catch(err => console.error('[AGENT] could not prune run temp dirs:', (err as Error).message));
  return mkdtemp(join(base, RUN_DIR_PREFIX));
}

export async function pruneRunTempDirs(base: string = tmpdir(), now: number = Date.now()): Promise<void> {
  for (const name of await readdir(base)) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const dir = join(base, name);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && now - info.mtimeMs > RUN_DIR_TTL_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Whether `dir` is a run temp directory: directly under the OS temp directory,
 * with the run prefix. A Share click names one from the button, which is ours,
 * but nothing else is ever taken as a temp root.
 */
export function isRunTempDir(dir: string, base: string = tmpdir()): boolean {
  return isAbsolute(dir) && resolve(dirname(dir)) === resolve(base) && basename(dir).startsWith(RUN_DIR_PREFIX);
}

/**
 * `tempRoots`: the run's own temp directory (or none). The shared temp
 * directory is never a root on its own.
 */
export async function checkAttachment(raw: string, workingDir: string, tempRoots: string[] = []): Promise<AttachmentCheck> {
  const requested = isAbsolute(raw) ? raw : resolve(workingDir, raw);
  let path: string;
  try {
    path = await realpath(requested);
  } catch {
    return { ok: false, reason: 'no such file' };
  }
  // The resolved name, so a link called notes.png cannot stand in for config.yaml.
  const ext = extname(path).slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return { ok: false, reason: `.${ext || '(none)'} files are not attached` };

  const project = await realpath(workingDir).catch(() => null);
  const home = await realpath(homedir()).catch(() => null);
  const projectRoot = project && project !== home ? [project] : [];
  const temps = await Promise.all(tempRoots.map(r => realpath(r).catch(() => null)));
  const roots = [...projectRoot, ...temps];
  const inside = roots.find((root): root is string => {
    if (!root) return false;
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside) return { ok: false, reason: 'outside the project and temp directories' };
  if (relative(inside, path).split(sep).some(part => part.startsWith('.'))) {
    return { ok: false, reason: 'hidden files and directories are not attached' };
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { ok: false, reason: 'not a file' };
  // Other users' files in a shared /tmp are not ours to post.
  if (temps.includes(inside) && process.getuid && info.uid !== process.getuid()) {
    return { ok: false, reason: "not this user's file" };
  }
  if (info.size > MAX_BYTES) return { ok: false, reason: 'larger than 20 MB' };
  return { ok: true, path, filename: basename(path) };
}

function runRoots(runDir: string | undefined): string[] {
  return runDir && isRunTempDir(runDir) ? [runDir] : [];
}

export const ATTACH_ACTION = /^agent_attach_(share|skip)$/;

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The question a file waits behind: its name, size and path, and Share / Don't
 * share for the person the turn is for. Nothing is uploaded from Claude's
 * reply alone, since a prompt injected through what it read could otherwise
 * post a file nobody asked for into a thread others read.
 */
export function attachPromptBlocks(file: { path: string; filename: string; size: number }, forUser: string, workingDir: string, runDir?: string) {
  const value = JSON.stringify({ u: forUser, p: file.path, w: workingDir, ...(runDir && { t: runDir }) });
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Share *${file.filename}* (${readableSize(file.size)}) in this thread?\n\`${file.path}\`` },
    },
    {
      type: 'actions',
      block_id: 'agent_attach',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Share' }, action_id: 'agent_attach_share', value },
        { type: 'button', text: { type: 'plain_text', text: "Don't share" }, action_id: 'agent_attach_skip', value },
      ],
    },
  ];
}

export function parseAttachValue(value: string): { forUser: string; path: string; workingDir: string; runDir?: string } | null {
  try {
    const v = JSON.parse(value);
    if (typeof v?.u !== 'string' || typeof v?.p !== 'string' || typeof v?.w !== 'string') return null;
    // An offer from before per-run temp dirs has no `t`: only the project counts then.
    return typeof v.t === 'string'
      ? { forUser: v.u, path: v.p, workingDir: v.w, runDir: v.t }
      : { forUser: v.u, path: v.p, workingDir: v.w };
  } catch {
    return null;
  }
}

/**
 * Offers each attachment a turn asked for: one that passes checkAttachment
 * becomes a Share / Don't share question for `forUser`; a refused one gets a
 * one-line note saying why.
 */
export async function offerAttachments(
  client: Pick<WebClient, 'chat'>,
  args: { channel: string; threadTs: string; paths: string[]; workingDir: string; forUser: string; runDir?: string },
): Promise<void> {
  for (const raw of args.paths) {
    const check = await checkAttachment(raw, args.workingDir, runRoots(args.runDir));
    if (!check.ok) {
      console.error(`[AGENT] attach ${raw}: ${check.reason}`);
      await client.chat.postMessage({
        channel: args.channel, thread_ts: args.threadTs, text: `_Couldn't attach \`${basename(raw)}\`: ${check.reason}._`,
      }).catch(() => {});
      continue;
    }
    const size = (await stat(check.path).catch(() => null))?.size ?? 0;
    await client.chat.postMessage({
      channel: args.channel, thread_ts: args.threadTs,
      text: `Share ${check.filename} in this thread?`,
      blocks: attachPromptBlocks({ path: check.path, filename: check.filename, size }, args.forUser, args.workingDir, args.runDir),
    }).catch(err => console.error('[AGENT] could not offer an attachment:', (err as Error).message));
  }
}

/**
 * Uploads a file the person chose to share, checked again first: it may have
 * changed, moved or been replaced since it was offered. Returns why not, or null.
 */
export async function shareAttachment(
  client: Pick<WebClient, 'filesUploadV2'>,
  args: { channel: string; threadTs: string; path: string; workingDir: string; runDir?: string },
): Promise<string | null> {
  const check = await checkAttachment(args.path, args.workingDir, runRoots(args.runDir));
  if (!check.ok) return check.reason;
  try {
    await client.filesUploadV2({ channel_id: args.channel, thread_ts: args.threadTs, file: check.path, filename: check.filename });
    return null;
  } catch (err) {
    const code = (err as { data?: { error?: string } }).data?.error;
    return code === 'missing_scope'
      ? 'the Slack app needs the files:write scope (add it and reinstall)'
      : code ?? (err as Error).message;
  }
}
