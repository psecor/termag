/**
 * Stored ask replies: each
 * finished message's final reply, in `ask_replies`, so `termag ask --reply`
 * can read it after the fact. Sealed with the chat transcript store's key and
 * construction (chatTranscriptStore.ts getTranscriptStoreConfig, which is
 * CHAT_TRANSCRIPT_KMS_KEY_ID, or unsealed under CHAT_TRANSCRIPT_ALLOW_PLAINTEXT),
 * under the encryption context (purpose, messageId), and opening checks it, so
 * a reply copied onto another message never opens as that one's.
 *
 * With neither variable set nothing is stored, and replies go only to a
 * waiting poll, as before. The text is never logged: errors name the message
 * and never hold any of it.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { TranscriptStoreConfig } from './chatTranscriptStore';
import { openBytes, sealBytes } from './sealedMessages';

export const ASK_REPLY_PURPOSE = 'termag-ask-reply';
/** A stored reply is deleted this long after its message finished. */
export const ASK_REPLY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** The most bytes of a reply kept; a longer one is cut there, with a marker. */
export const ASK_REPLY_MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function replyContext(messageId: string): Record<string, string> {
  if (!ID.test(messageId)) throw new Error('invalid message id for the reply store');
  return { purpose: ASK_REPLY_PURPOSE, messageId };
}

/** The reply as kept: at most ASK_REPLY_MAX_BYTES, cut on a character boundary with a marker saying so. */
export function keptReply(text: string, max = ASK_REPLY_MAX_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  const marker = `\n\n[termag: the reply was ${buf.length} bytes; only its first ${max} bytes were kept.]`;
  let end = max - Buffer.byteLength(marker, 'utf8');
  // Back up to a character's first byte, so the cut never splits one.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8') + marker, truncated: true };
}

export interface SealedReply {
  messageId: string;
  sealed: boolean;
  text: Buffer;
  bytes: number;
  truncated: boolean;
}

/** The row to write in the finishing transaction. Sealing calls KMS, so it runs before that transaction opens. */
export async function sealReply(cfg: TranscriptStoreConfig, messageId: string, reply: string): Promise<SealedReply> {
  const context = replyContext(messageId);
  const kept = keptReply(reply);
  const plain = Buffer.from(kept.text, 'utf8');
  const text = cfg.materials ? await sealBytes(cfg.materials, plain, context) : plain;
  return { messageId, sealed: cfg.materials != null, text, bytes: plain.length, truncated: kept.truncated };
}

export function storeReply(row: SealedReply): Prisma.PrismaPromise<unknown> {
  return prisma.askReply.create({ data: row });
}

/**
 * The stored reply's text, or null when none is stored. The caller has
 * already checked that the asker is the message's sender. A reply sealed under
 * another context, or unsealed in a deployment that seals, throws.
 */
export async function readReply(cfg: TranscriptStoreConfig, messageId: string): Promise<string | null> {
  const row = await prisma.askReply.findUnique({ where: { messageId }, select: { sealed: true, text: true } });
  if (!row) return null;
  if (row.sealed !== (cfg.materials != null)) {
    throw new Error(`the stored reply to ${messageId} is ${row.sealed ? 'sealed' : 'unsealed'}, and this deployment ${cfg.materials ? 'seals' : 'has no key'}`);
  }
  const bytes = cfg.materials
    ? await openBytes(cfg.materials, row.text, replyContext(messageId), `the stored reply was not sealed for message ${messageId}`)
    : Buffer.from(row.text);
  return bytes.toString('utf8');
}

/** Deletes replies stored before `now - ASK_REPLY_TTL_MS`; the message keeps its replyBytes. */
export async function sweepReplies(now: Date): Promise<number> {
  const { count } = await prisma.askReply.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ASK_REPLY_TTL_MS) } } });
  return count;
}
