/**
 * Chat transcripts in Postgres: each chat-runner
 * session's Claude Code JSONL as per-turn chunks, each chunk holding the raw
 * bytes (gzipped) and the elided view entries they render as
 * (chatTranscriptView.ts), both sealed with the AWS Encryption SDK under
 * CHAT_TRANSCRIPT_KMS_KEY_ID, as user_credentials are (sealedMessages.ts).
 *
 * The encryption context is (purpose, projectId, workstreamId, sessionId,
 * byteStart), and opening checks it against the row, so a chunk copied onto
 * another chat or offset never opens as that one. A chunk's raw bytes and
 * entries share one data key; a data key opened in the last few minutes
 * opens again without KMS.
 *
 * Off unless CHAT_TRANSCRIPT_KMS_KEY_ID holds a KMS key ARN. Where there is no
 * key (e2e, dev), CHAT_TRANSCRIPT_ALLOW_PLAINTEXT=1 stores chunks unsealed,
 * and only such a deployment reads unsealed chunks back.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import type { KeyringNode, NodeMaterialsManager } from '@aws-crypto/client-node';
import { prisma } from '../db';
import { cachingMaterials, KMS_KEY_ARN, kmsKeyring, openBytes, sealBytes } from './sealedMessages';
import { tooLargeEntry, transcriptEntries, type ViewEntry } from './chatTranscriptView';

export const TRANSCRIPT_PURPOSE = 'termag-chat-transcript';
/** The newest entries a stored view returns, as the box's chat-history does. */
export const VIEW_MAX_ENTRIES = 600;
const DEFAULT_RAW_CAP = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface TranscriptStoreConfig {
  /** Seals with this keyring, or stores unsealed when null (CHAT_TRANSCRIPT_ALLOW_PLAINTEXT). */
  materials: KeyringNode | NodeMaterialsManager | null;
  /** Past this many raw bytes a session stops storing its raw JSONL. */
  rawCap: number;
}

let warnedNotArn = false;
const materialsByArn = new Map<string, NodeMaterialsManager>();

export function getTranscriptStoreConfig(env: NodeJS.ProcessEnv = process.env): TranscriptStoreConfig | null {
  const cap = Number(env.CHAT_TRANSCRIPT_RAW_CAP);
  const rawCap = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_RAW_CAP;
  const arn = env.CHAT_TRANSCRIPT_KMS_KEY_ID?.trim();
  if (arn) {
    if (!KMS_KEY_ARN.test(arn)) {
      if (!warnedNotArn) {
        console.warn('[TRANSCRIPT] CHAT_TRANSCRIPT_KMS_KEY_ID must be a KMS key ARN (not an alias or key id); transcripts are not stored');
        warnedNotArn = true;
      }
      return null;
    }
    let materials = materialsByArn.get(arn);
    if (!materials) {
      materials = cachingMaterials(kmsKeyring(arn), { maxAgeMs: 5 * 60_000, maxMessages: 100, capacity: 1000, partition: TRANSCRIPT_PURPOSE });
      materialsByArn.set(arn, materials);
    }
    return { materials, rawCap };
  }
  return env.CHAT_TRANSCRIPT_ALLOW_PLAINTEXT === '1' ? { materials: null, rawCap } : null;
}

export interface ChunkKey {
  projectId: string;
  workstreamId: string;
  sessionId: string;
  byteStart: number;
}

export function encryptionContextFor(k: ChunkKey): Record<string, string> {
  if (!ID.test(k.projectId) || !ID.test(k.workstreamId)) throw new Error('invalid chat for the transcript store');
  if (!SESSION_ID.test(k.sessionId)) throw new Error('invalid session id for the transcript store');
  if (!Number.isSafeInteger(k.byteStart) || k.byteStart < 0) throw new Error('invalid transcript offset');
  return { purpose: TRANSCRIPT_PURPOSE, projectId: k.projectId, workstreamId: k.workstreamId, sessionId: k.sessionId, byteStart: String(k.byteStart) };
}

export interface TranscriptHead {
  sessionId: string;
  rawBytes: number;
  rawCapped: boolean;
}

/** The chat's live session as stored, or null when nothing is stored yet. */
export async function transcriptHead(projectId: string, workstreamId: string): Promise<TranscriptHead | null> {
  const row = await prisma.chatTranscript.findFirst({
    where: { projectId, workstreamId, current: true },
    select: { sessionId: true, rawBytes: true, rawCapped: true },
  });
  return row ? { sessionId: row.sessionId, rawBytes: Number(row.rawBytes), rawCapped: row.rawCapped } : null;
}

export type AppendResult = { ok: true; rawBytes: number } | { ok: false; expected: number };

/**
 * Store whole JSONL lines [byteStart, byteStart + data.length) of a session.
 * A session not stored yet becomes the chat's live one, and must start at 0.
 * Refused with the offset the store has when byteStart is not where the
 * session ends, so the caller reads again from there. An empty `data` only
 * makes the session live.
 *
 * `skipped` is a line the box would not read (over its line limit): the
 * chunk covers its bytes with a "too large to keep" entry and no raw, and the
 * session is capped, since its raw copy is no longer the file byte for byte.
 */
export async function appendChunk(cfg: TranscriptStoreConfig, k: ChunkKey, data: Buffer, skipped = 0, view: { boxNotices?: boolean } = {}): Promise<AppendResult> {
  const context = encryptionContextFor(k);
  const { projectId, workstreamId, sessionId, byteStart } = k;
  const existing = await prisma.chatTranscript.findUnique({
    where: { projectId_workstreamId_sessionId: { projectId, workstreamId, sessionId } },
    select: { rawBytes: true, rawCapped: true, current: true },
  });
  const stored = existing ? Number(existing.rawBytes) : 0;
  if (stored !== byteStart) return { ok: false, expected: stored };
  if (!existing || !existing.current) {
    await prisma.$transaction([
      prisma.chatTranscript.updateMany({ where: { projectId, workstreamId, current: true, NOT: { sessionId } }, data: { current: false } }),
      prisma.chatTranscript.upsert({
        where: { projectId_workstreamId_sessionId: { projectId, workstreamId, sessionId } },
        create: { projectId, workstreamId, sessionId },
        update: { current: true },
      }),
    ]);
  }
  if (!data.length && !skipped) return { ok: true, rawBytes: stored };
  const byteEnd = byteStart + (skipped || data.length);
  const capped = (existing?.rawCapped ?? false) || byteEnd > cfg.rawCap || skipped > 0;
  const entries = skipped ? [tooLargeEntry(skipped)] : transcriptEntries(data.toString('utf8'), view);
  const entriesJson = Buffer.from(JSON.stringify(entries), 'utf8');
  const raw = capped ? null : gzipSync(data);
  const seal = (b: Buffer) => (cfg.materials ? sealBytes(cfg.materials, b, context) : Promise.resolve(b));
  const [sealedEntries, sealedRaw] = await Promise.all([seal(entriesJson), raw ? seal(raw) : Promise.resolve(null)]);
  try {
    await prisma.$transaction(async tx => {
      // Only from the offset this read saw: a concurrent append for the same session loses here.
      const moved = await tx.chatTranscript.updateMany({
        where: { projectId, workstreamId, sessionId, rawBytes: BigInt(byteStart) },
        data: { rawBytes: BigInt(byteEnd), rawCapped: capped },
      });
      if (moved.count !== 1) throw new OffsetMoved();
      await tx.chatTranscriptChunk.create({
        data: {
          projectId, workstreamId, sessionId, byteStart: BigInt(byteStart), byteEnd: BigInt(byteEnd),
          sealed: cfg.materials != null, raw: sealedRaw, entries: sealedEntries, entryCount: entries.length,
        },
      });
    });
  } catch (err) {
    if (!(err instanceof OffsetMoved)) throw err;
    const head = await prisma.chatTranscript.findUnique({
      where: { projectId_workstreamId_sessionId: { projectId, workstreamId, sessionId } }, select: { rawBytes: true },
    });
    return { ok: false, expected: head ? Number(head.rawBytes) : 0 };
  }
  return { ok: true, rawBytes: byteEnd };
}

class OffsetMoved extends Error {}

/** Forget a session's stored bytes (its file on the box shrank), so it is stored again from 0. */
export async function resetSession(projectId: string, workstreamId: string, sessionId: string): Promise<void> {
  await prisma.$transaction([
    prisma.chatTranscriptChunk.deleteMany({ where: { projectId, workstreamId, sessionId } }),
    prisma.chatTranscript.updateMany({ where: { projectId, workstreamId, sessionId }, data: { rawBytes: 0n, rawCapped: false } }),
  ]);
}

/** The newest chunks whose entries add up to at least `max`, oldest first. */
export function pageChunks<T extends { byteStart: bigint; entryCount: number }>(newestFirst: readonly T[], max: number): T[] {
  const out: T[] = [];
  let total = 0;
  for (const c of newestFirst) {
    if (total >= max) break;
    out.push(c);
    total += c.entryCount;
  }
  return out.reverse();
}

export interface StoredView {
  sessionId: string;
  entries: ViewEntry[];
}

/**
 * The chat's newest `max` entries from the store, or null when its live
 * session has none. A chunk sealed under any other context, or unsealed in
 * a deployment that seals, throws: the caller falls back to the box.
 */
export async function readStoredView(cfg: TranscriptStoreConfig, projectId: string, workstreamId: string, max = VIEW_MAX_ENTRIES): Promise<StoredView | null> {
  const head = await transcriptHead(projectId, workstreamId);
  if (!head) return null;
  const { sessionId } = head;
  const index = await prisma.chatTranscriptChunk.findMany({
    where: { projectId, workstreamId, sessionId },
    orderBy: { byteStart: 'desc' },
    select: { byteStart: true, entryCount: true },
  });
  const page = pageChunks(index, max);
  if (!page.length) return null;
  const rows = await prisma.chatTranscriptChunk.findMany({
    where: { projectId, workstreamId, sessionId, byteStart: { gte: page[0].byteStart } },
    orderBy: { byteStart: 'asc' },
    select: { byteStart: true, sealed: true, entries: true },
  });
  const opened = await Promise.all(rows.map(async row => {
    const k = { projectId, workstreamId, sessionId, byteStart: Number(row.byteStart) };
    if (row.sealed !== (cfg.materials != null)) throw new Error(`transcript chunk at ${k.byteStart} is ${row.sealed ? 'sealed' : 'unsealed'}, and this deployment ${cfg.materials ? 'seals' : 'has no key'}`);
    const bytes = cfg.materials
      ? await openBytes(cfg.materials, row.entries, encryptionContextFor(k), 'stored transcript chunk was not encrypted for this chat and offset')
      : Buffer.from(row.entries);
    return JSON.parse(bytes.toString('utf8')) as ViewEntry[];
  }));
  return { sessionId, entries: opened.flat().slice(-max) };
}

export interface StoredRaw {
  sessionId: string;
  /** Bytes of the session stored so far. */
  rawBytes: number;
  /** The raw copy covers the whole of them, byte for byte, from 0: the session can be restored. */
  complete: boolean;
  /** The chunks' byte ranges, oldest first, for storedRawChunks. */
  ranges: Array<{ byteStart: number; byteEnd: number }>;
}

/**
 * Whether the chat's live session can be rebuilt from the store:
 * every chunk from 0 to rawBytes, contiguous, each
 * with its raw bytes. A session past CHAT_TRANSCRIPT_RAW_CAP, or with a line
 * the box would not read, is not complete. Null when nothing is stored.
 */
export async function storedRawOf(projectId: string, workstreamId: string): Promise<StoredRaw | null> {
  const head = await transcriptHead(projectId, workstreamId);
  if (!head) return null;
  const { sessionId } = head;
  const index = await prisma.chatTranscriptChunk.findMany({
    where: { projectId, workstreamId, sessionId },
    orderBy: { byteStart: 'asc' },
    select: { byteStart: true, byteEnd: true },
  });
  const withRaw = await prisma.chatTranscriptChunk.count({ where: { projectId, workstreamId, sessionId, raw: { not: null } } });
  const ranges = index.map(c => ({ byteStart: Number(c.byteStart), byteEnd: Number(c.byteEnd) }));
  let at = 0;
  for (const r of ranges) {
    if (r.byteStart !== at) break;
    at = r.byteEnd;
  }
  const complete = !head.rawCapped && head.rawBytes > 0 && at === head.rawBytes && withRaw === ranges.length;
  return { sessionId, rawBytes: head.rawBytes, complete, ranges };
}

/** The session's raw JSONL, one opened and unzipped chunk at a time, oldest first. */
export async function* storedRawChunks(cfg: TranscriptStoreConfig, projectId: string, workstreamId: string, raw: StoredRaw): AsyncGenerator<Buffer> {
  const { sessionId } = raw;
  for (const { byteStart, byteEnd } of raw.ranges) {
    const row = await prisma.chatTranscriptChunk.findUnique({
      where: { projectId_workstreamId_sessionId_byteStart: { projectId, workstreamId, sessionId, byteStart: BigInt(byteStart) } },
      select: { sealed: true, raw: true },
    });
    if (!row?.raw) throw new Error(`transcript chunk at ${byteStart} has no raw bytes`);
    if (row.sealed !== (cfg.materials != null)) throw new Error(`transcript chunk at ${byteStart} is ${row.sealed ? 'sealed' : 'unsealed'}, and this deployment ${cfg.materials ? 'seals' : 'has no key'}`);
    const k = { projectId, workstreamId, sessionId, byteStart };
    const gz = cfg.materials
      ? await openBytes(cfg.materials, row.raw, encryptionContextFor(k), 'stored transcript chunk was not encrypted for this chat and offset')
      : Buffer.from(row.raw);
    const data = gunzipSync(gz);
    if (data.length !== byteEnd - byteStart) throw new Error(`transcript chunk at ${byteStart} holds ${data.length} bytes, not ${byteEnd - byteStart}`);
    yield data;
  }
}
