import { randomBytes } from 'crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from '@aws-crypto/client-node';

// In-memory chat_transcripts and chat_transcript_chunks, with just the
// queries the store makes. $transaction runs an array or a callback; a
// callback's throw leaves the tables as they were.
const db = vi.hoisted(() => {
  type T = { projectId: string; workstreamId: string; sessionId: string; rawBytes: bigint; rawCapped: boolean; current: boolean };
  type C = { projectId: string; workstreamId: string; sessionId: string; byteStart: bigint; byteEnd: bigint; sealed: boolean; raw: Buffer | null; entries: Buffer; entryCount: number };
  const state = { transcripts: [] as T[], chunks: [] as C[] };
  const sameChat = (a: { projectId: string; workstreamId: string }, w: { projectId?: string; workstreamId?: string }) =>
    (w.projectId === undefined || a.projectId === w.projectId) && (w.workstreamId === undefined || a.workstreamId === w.workstreamId);
  const pick = <R extends object>(row: R, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map(k => [k, (row as Record<string, unknown>)[k]])) : row;
  const matchT = (t: T, w: Record<string, unknown>) => sameChat(t, w)
    && (w.sessionId === undefined || t.sessionId === w.sessionId)
    && (w.current === undefined || t.current === w.current)
    && (w.rawBytes === undefined || t.rawBytes === w.rawBytes)
    && (w.NOT === undefined || t.sessionId !== (w.NOT as { sessionId: string }).sessionId);
  const matchC = (c: C, w: Record<string, unknown>) => sameChat(c, w)
    && (w.sessionId === undefined || c.sessionId === w.sessionId)
    && (w.byteStart === undefined || c.byteStart >= (w.byteStart as { gte: bigint }).gte);
  const key = (w: { projectId_workstreamId_sessionId: { projectId: string; workstreamId: string; sessionId: string } }) => w.projectId_workstreamId_sessionId;
  const prisma = {
    chatTranscript: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const t = state.transcripts.find(r => matchT(r, where));
        return t ? pick(t, select) : null;
      },
      findUnique: async ({ where, select }: { where: Parameters<typeof key>[0]; select?: Record<string, boolean> }) => {
        const t = state.transcripts.find(r => matchT(r, key(where)));
        return t ? pick(t, select) : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<T> }) => {
        const hit = state.transcripts.filter(r => matchT(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }: { where: Parameters<typeof key>[0]; create: Partial<T>; update: Partial<T> }) => {
        const t = state.transcripts.find(r => matchT(r, key(where)));
        if (t) Object.assign(t, update);
        else state.transcripts.push({ rawBytes: 0n, rawCapped: false, current: true, ...create } as T);
      },
    },
    chatTranscriptChunk: {
      create: async ({ data }: { data: C }) => {
        if (state.chunks.some(c => matchC(c, data) && c.byteStart === data.byteStart)) throw new Error('unique violation');
        state.chunks.push({ ...data });
      },
      findMany: async ({ where, orderBy, select }: { where: Record<string, unknown>; orderBy: { byteStart: 'asc' | 'desc' }; select?: Record<string, boolean> }) => {
        const rows = state.chunks.filter(c => matchC(c, where)).sort((a, b) => Number(a.byteStart - b.byteStart));
        if (orderBy.byteStart === 'desc') rows.reverse();
        return rows.map(r => pick(r, select));
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        state.chunks = state.chunks.filter(c => !matchC(c, where));
      },
      count: async ({ where }: { where: Record<string, unknown> & { raw?: { not: null } } }) =>
        state.chunks.filter(c => matchC(c, where) && (where.raw === undefined || c.raw != null)).length,
      findUnique: async ({ where, select }: { where: { projectId_workstreamId_sessionId_byteStart: { projectId: string; workstreamId: string; sessionId: string; byteStart: bigint } }; select?: Record<string, boolean> }) => {
        const k = where.projectId_workstreamId_sessionId_byteStart;
        const c = state.chunks.find(r => sameChat(r, k) && r.sessionId === k.sessionId && r.byteStart === k.byteStart);
        return c ? pick(c, select) : null;
      },
    },
    async $transaction(arg: unknown) {
      if (Array.isArray(arg)) return Promise.all(arg);
      const saved = structuredClone(state);
      try { return await (arg as (tx: unknown) => Promise<unknown>)(prisma); } catch (err) {
        state.transcripts = saved.transcripts; state.chunks = saved.chunks;
        throw err;
      }
    },
  };
  return { prisma, state };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

import { cachingMaterials } from './sealedMessages';
import {
  appendChunk, encryptionContextFor, getTranscriptStoreConfig, pageChunks, readStoredView, resetSession, storedRawChunks, storedRawOf, transcriptHead,
  type TranscriptStoreConfig,
} from './chatTranscriptStore';

const keyring = () => new RawAesKeyringNode({
  keyName: 'test', keyNamespace: 'termag-test', unencryptedMasterKey: randomBytes(32),
  wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
});
const chat = { projectId: 'proj1', workstreamId: 'ws1' };
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const lines = (...texts: string[]) => Buffer.from(texts.map(t => `${JSON.stringify({ type: 'user', uuid: t, message: { role: 'user', content: t } })}\n`).join(''));

let cfg: TranscriptStoreConfig;
beforeEach(() => {
  db.state.transcripts = [];
  db.state.chunks = [];
  cfg = { materials: keyring(), rawCap: 1024 * 1024 };
});

describe('getTranscriptStoreConfig', () => {
  it('is off without a key unless plaintext is allowed, and never with a key that is not an ARN', () => {
    expect(getTranscriptStoreConfig({})).toBeNull();
    expect(getTranscriptStoreConfig({ CHAT_TRANSCRIPT_ALLOW_PLAINTEXT: '1' })).toEqual({ materials: null, rawCap: 64 * 1024 * 1024 });
    expect(getTranscriptStoreConfig({ CHAT_TRANSCRIPT_KMS_KEY_ID: 'alias/termag-chat-transcripts', CHAT_TRANSCRIPT_ALLOW_PLAINTEXT: '1' })).toBeNull();
    const arn = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
    const on = getTranscriptStoreConfig({ CHAT_TRANSCRIPT_KMS_KEY_ID: arn, CHAT_TRANSCRIPT_RAW_CAP: '100' });
    expect(on?.materials).toBeTruthy();
    expect(on?.rawCap).toBe(100);
  });
});

describe('encryptionContextFor', () => {
  it('names the purpose, the chat, the session and the offset', () => {
    expect(encryptionContextFor({ ...chat, sessionId: S1, byteStart: 42 })).toEqual({
      purpose: 'termag-chat-transcript', projectId: 'proj1', workstreamId: 'ws1', sessionId: S1, byteStart: '42',
    });
    expect(() => encryptionContextFor({ ...chat, sessionId: '../x', byteStart: 0 })).toThrow(/session id/);
    expect(() => encryptionContextFor({ ...chat, sessionId: S1, byteStart: -1 })).toThrow(/offset/);
  });
});

describe('appendChunk and readStoredView', () => {
  it('stores turns in order, sealed, and reads the view back', async () => {
    const a = lines('one', 'two');
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a)).toEqual({ ok: true, rawBytes: a.length });
    const b = lines('three');
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: a.length }, b)).toEqual({ ok: true, rawBytes: a.length + b.length });
    expect(await transcriptHead(chat.projectId, chat.workstreamId)).toEqual({ sessionId: S1, rawBytes: a.length + b.length, rawCapped: false });
    // Nothing readable at rest.
    for (const c of db.state.chunks) {
      expect(c.sealed).toBe(true);
      expect(c.entries.includes(Buffer.from('three'))).toBe(false);
    }
    const view = await readStoredView(cfg, chat.projectId, chat.workstreamId);
    expect(view?.sessionId).toBe(S1);
    expect(view?.entries.map(e => e.message.content)).toEqual(['one', 'two', 'three']);
  });

  it('keeps the raw bytes, gzipped and sealed', async () => {
    const plain = { materials: null, rawCap: cfg.rawCap };
    const a = lines('one');
    await appendChunk(plain, { ...chat, sessionId: S1, byteStart: 0 }, a);
    expect(gunzipSync(db.state.chunks[0].raw!).equals(a)).toBe(true);
    expect(db.state.chunks[0].sealed).toBe(false);
  });

  it('refuses an offset that is not where the session ends, with the one it has', async () => {
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 5 }, lines('x'))).toEqual({ ok: false, expected: 0 });
    const a = lines('one');
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a);
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a)).toEqual({ ok: false, expected: a.length });
    expect(db.state.chunks).toHaveLength(1);
  });

  it('makes a new session the live one and leaves the old one stored', async () => {
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, lines('old'));
    await appendChunk(cfg, { ...chat, sessionId: S2, byteStart: 0 }, lines('new'));
    expect(db.state.transcripts.map(t => [t.sessionId, t.current])).toEqual([[S1, false], [S2, true]]);
    expect((await readStoredView(cfg, chat.projectId, chat.workstreamId))?.entries.map(e => e.message.content)).toEqual(['new']);
  });

  it('covers a line the box skipped with a placeholder, no raw, and a capped session, and stores on after it', async () => {
    const a = lines('before');
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a);
    const huge = 50 * 1024 * 1024;
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: a.length }, Buffer.alloc(0), huge)).toEqual({ ok: true, rawBytes: a.length + huge });
    const skip = db.state.chunks[1];
    expect([skip.byteStart, skip.byteEnd, skip.raw, skip.entryCount]).toEqual([BigInt(a.length), BigInt(a.length + huge), null, 1]);
    expect(db.state.transcripts[0].rawCapped).toBe(true);
    const b = lines('after');
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: a.length + huge }, b)).toEqual({ ok: true, rawBytes: a.length + huge + b.length });
    expect(db.state.chunks[2].raw).toBeNull();
    const view = await readStoredView(cfg, chat.projectId, chat.workstreamId);
    expect(view?.entries.map(e => e.message.content)).toEqual([
      'before', [{ type: 'text', text: '[A message of 50 MB was too large to keep]' }], 'after',
    ]);
  });

  it('stops storing raw bytes past the cap, and keeps the view', async () => {
    cfg.rawCap = 10;
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, lines('a long enough line'));
    expect(db.state.chunks[0].raw).toBeNull();
    expect(db.state.transcripts[0].rawCapped).toBe(true);
    expect((await readStoredView(cfg, chat.projectId, chat.workstreamId))?.entries).toHaveLength(1);
  });

  it('reads only the newest chunks a page needs', async () => {
    let at = 0;
    for (const t of ['a', 'b', 'c', 'd']) {
      const data = lines(`${t}1`, `${t}2`);
      await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: at }, data);
      at += data.length;
    }
    expect((await readStoredView(cfg, chat.projectId, chat.workstreamId, 3))?.entries.map(e => e.message.content)).toEqual(['c2', 'd1', 'd2']);
  });

  it('never opens a chunk moved onto another offset', async () => {
    const a = lines('one');
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a);
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: a.length }, lines('two'));
    const [first, second] = db.state.chunks;
    second.entries = first.entries;
    await expect(readStoredView(cfg, chat.projectId, chat.workstreamId)).rejects.toThrow(/not encrypted for this chat and offset/);
  });

  it('refuses unsealed chunks in a deployment that seals', async () => {
    await appendChunk({ materials: null, rawCap: cfg.rawCap }, { ...chat, sessionId: S1, byteStart: 0 }, lines('one'));
    await expect(readStoredView(cfg, chat.projectId, chat.workstreamId)).rejects.toThrow(/unsealed/);
  });

  it('seals and opens through the data-key cache', async () => {
    const cached = { materials: cachingMaterials(keyring(), { maxAgeMs: 60_000, maxMessages: 10, capacity: 10, partition: 't' }), rawCap: cfg.rawCap };
    const a = lines('one');
    await appendChunk(cached, { ...chat, sessionId: S1, byteStart: 0 }, a);
    await appendChunk(cached, { ...chat, sessionId: S1, byteStart: a.length }, lines('two'));
    expect((await readStoredView(cached, chat.projectId, chat.workstreamId))?.entries.map(e => e.message.content)).toEqual(['one', 'two']);
  });

  it('an empty read only makes the session live', async () => {
    expect(await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, Buffer.alloc(0))).toEqual({ ok: true, rawBytes: 0 });
    expect(db.state.chunks).toHaveLength(0);
    expect(await readStoredView(cfg, chat.projectId, chat.workstreamId)).toBeNull();
  });

  it('resetSession stores the session again from 0', async () => {
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, lines('one'));
    await resetSession(chat.projectId, chat.workstreamId, S1);
    expect(db.state.chunks).toHaveLength(0);
    expect((await transcriptHead(chat.projectId, chat.workstreamId))?.rawBytes).toBe(0);
  });
});

describe('pageChunks', () => {
  it('takes newest chunks until the page is full, oldest first', () => {
    const c = (n: number, entryCount: number) => ({ byteStart: BigInt(n), entryCount });
    expect(pageChunks([c(30, 2), c(20, 2), c(10, 2), c(0, 2)], 3)).toEqual([c(20, 2), c(30, 2)]);
    expect(pageChunks([c(10, 0), c(0, 5)], 3)).toEqual([c(0, 5), c(10, 0)]);
    expect(pageChunks([], 3)).toEqual([]);
  });
});

describe('storedRawOf and storedRawChunks (docs/chat-resume.md)', () => {
  const all = async (it: AsyncIterable<Buffer>) => { const out: Buffer[] = []; for await (const b of it) out.push(b); return Buffer.concat(out); };

  it('gives back the session byte for byte, opened and unzipped, chunk by chunk', async () => {
    const a = lines('one', 'two'), b = lines('three');
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a);
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: a.length }, b);
    const raw = await storedRawOf(chat.projectId, chat.workstreamId);
    expect(raw).toEqual({ sessionId: S1, rawBytes: a.length + b.length, complete: true, ranges: [{ byteStart: 0, byteEnd: a.length }, { byteStart: a.length, byteEnd: a.length + b.length }] });
    expect((await all(storedRawChunks(cfg, chat.projectId, chat.workstreamId, raw!))).equals(Buffer.concat([a, b]))).toBe(true);
  });

  it('is not complete past the raw cap or after a skipped line, and a chunk sealed for another chat does not open', async () => {
    const small = { ...cfg, rawCap: 40 };
    const a = lines('one'), b = lines('a much longer second turn');
    await appendChunk(small, { ...chat, sessionId: S1, byteStart: 0 }, a);
    await appendChunk(small, { ...chat, sessionId: S1, byteStart: a.length }, b);
    expect((await storedRawOf(chat.projectId, chat.workstreamId))?.complete).toBe(false);

    db.state.transcripts = []; db.state.chunks = [];
    await appendChunk(cfg, { ...chat, sessionId: S2, byteStart: 0 }, a);
    await appendChunk(cfg, { ...chat, sessionId: S2, byteStart: a.length }, Buffer.alloc(0), 1000);
    expect((await storedRawOf(chat.projectId, chat.workstreamId))?.complete).toBe(false);

    db.state.transcripts = []; db.state.chunks = [];
    await appendChunk(cfg, { ...chat, sessionId: S1, byteStart: 0 }, a);
    const raw = await storedRawOf(chat.projectId, chat.workstreamId);
    db.state.chunks[0].workstreamId = 'ws2';
    db.state.transcripts[0].workstreamId = 'ws2';
    await expect(all(storedRawChunks(cfg, chat.projectId, 'ws2', raw!))).rejects.toThrow();
  });

  it('is null when nothing is stored', async () => {
    expect(await storedRawOf(chat.projectId, chat.workstreamId)).toBeNull();
  });
});
