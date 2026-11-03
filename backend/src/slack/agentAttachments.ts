/**
 * Files an agent reply asks to attach with `[attach: path]` (agentSession.ts).
 *
 * Claude picks the path, so it is checked before anything is uploaded to a
 * thread other people may read: inside the project or the temp directory
 * (after symlinks; with no project only the temp directory, not the whole
 * home), in a temp directory only this process's user's own files, no
 * dot-directory or dotfile on the way (.ssh, .aws, .env), an image or plain
 * document type (not json, log or html, the types that most often hold config
 * and tokens), and at most 20 MB. Files in the project may belong to its owner's
 * unix user rather than this process's, so ownership is checked in temp only.
 *
 * These checks are the backstop, not the approval: nothing is uploaded until
 * the person the turn is for presses Share on a question that shows the file's
 * name, size and path (offerAttachments). Claude runs with bypassPermissions
 * and could copy any file somewhere allowed, so a check alone would not do.
 */

import { realpath, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'path';
import type { WebClient } from '@slack/web-api';

const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'pdf', 'csv', 'txt', 'md', 'diff', 'patch',
]);
const MAX_BYTES = 20 * 1024 * 1024;

export type AttachmentCheck = { ok: true; path: string; filename: string } | { ok: false; reason: string };

export async function checkAttachment(raw: string, workingDir: string, extraRoots: string[] = [tmpdir(), '/tmp']): Promise<AttachmentCheck> {
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
  const tempRoots = await Promise.all(extraRoots.map(r => realpath(r).catch(() => null)));
  const roots = [...projectRoot, ...tempRoots];
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
  if (tempRoots.includes(inside) && process.getuid && info.uid !== process.getuid()) {
    return { ok: false, reason: "not this user's file" };
  }
  if (info.size > MAX_BYTES) return { ok: false, reason: 'larger than 20 MB' };
  return { ok: true, path, filename: basename(path) };
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
export function attachPromptBlocks(file: { path: string; filename: string; size: number }, forUser: string, workingDir: string) {
  const value = JSON.stringify({ u: forUser, p: file.path, w: workingDir });
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

export function parseAttachValue(value: string): { forUser: string; path: string; workingDir: string } | null {
  try {
    const v = JSON.parse(value);
    return typeof v?.u === 'string' && typeof v?.p === 'string' && typeof v?.w === 'string'
      ? { forUser: v.u, path: v.p, workingDir: v.w }
      : null;
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
  args: { channel: string; threadTs: string; paths: string[]; workingDir: string; forUser: string },
): Promise<void> {
  for (const raw of args.paths) {
    const check = await checkAttachment(raw, args.workingDir);
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
      blocks: attachPromptBlocks({ path: check.path, filename: check.filename, size }, args.forUser, args.workingDir),
    }).catch(err => console.error('[AGENT] could not offer an attachment:', (err as Error).message));
  }
}

/**
 * Uploads a file the person chose to share, checked again first: it may have
 * changed, moved or been replaced since it was offered. Returns why not, or null.
 */
export async function shareAttachment(
  client: Pick<WebClient, 'filesUploadV2'>,
  args: { channel: string; threadTs: string; path: string; workingDir: string },
): Promise<string | null> {
  const check = await checkAttachment(args.path, args.workingDir);
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
