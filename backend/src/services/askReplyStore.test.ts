import { randomBytes } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from '@aws-crypto/client-node';

// One in-memory ask_replies table, with just the queries the store makes.
const db = vi.hoisted(() => {
  type R = { messageId: string; sealed: boolean; text: Buffer; bytes: number; truncated: boolean; createdAt: Date };
  const rows = new Map<string, R>();
  const prisma = {
    askReply: {
      create: async ({ data }: { data: Omit<R, 'createdAt'> & { createdAt?: Date } }) => {
        if (rows.has(data.messageId)) throw new Error('unique violation');
        rows.set(data.messageId, { createdAt: new Date(), ...data });
      },
      findUnique: async ({ where }: { where: { messageId: string } }) => rows.get(where.messageId) ?? null,
      deleteMany: async ({ where }: { where: { createdAt: { lt: Date } } }) => {
        let count = 0;
        for (const [id, r] of rows) if (r.createdAt < where.createdAt.lt) { rows.delete(id); count++; }
        return { count };
      },
    },
  };
  return { rows, prisma };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

import { ASK_REPLY_MAX_BYTES, ASK_REPLY_PURPOSE, ASK_REPLY_TTL_MS, keptReply, readReply, replyContext, sealReply, storeReply, sweepReplies } from './askReplyStore';

const keyring = (key = randomBytes(32)) => new RawAesKeyringNode({
  keyName: 'test', keyNamespace: 'termag-test', unencryptedMasterKey: key,
  wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
});
const sealing = { materials: keyring(), rawCap: 1 };
const plaintext = { materials: null, rawCap: 1 };
const REPLY = 'The flag is read in server/flags.go. PR #985 pushed.';

describe('askReplyStore: sealed at rest', () => {
  it('seals the reply under (purpose, messageId): the stored bytes hold none of the text, and open back to it', async () => {
    const row = await sealReply(sealing, 'msgseal00001', REPLY);
    expect(row).toMatchObject({ messageId: 'msgseal00001', sealed: true, bytes: Buffer.byteLength(REPLY), truncated: false });
    expect(row.text.includes(Buffer.from('server/flags.go'))).toBe(false);
    await storeReply(row);
    expect(db.rows.get('msgseal00001')!.text.includes(Buffer.from('flags'))).toBe(false);
    expect(await readReply(sealing, 'msgseal00001')).toBe(REPLY);
    expect(replyContext('msgseal00001')).toEqual({ purpose: ASK_REPLY_PURPOSE, messageId: 'msgseal00001' });
  });

  it('a sealed reply copied onto another message does not open as that one', async () => {
    const row = await sealReply(sealing, 'msgcopy00001', REPLY);
    await storeReply({ ...row, messageId: 'msgcopy00002' });
    await expect(readReply(sealing, 'msgcopy00002')).rejects.toThrow('the stored reply was not sealed for message msgcopy00002');
  });

  it('does not open under another key, and the error holds no reply text', async () => {
    await storeReply(await sealReply(sealing, 'msgother0001', REPLY));
    const err = await readReply({ materials: keyring(), rawCap: 1 }, 'msgother0001').catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('flags');
  });

  it('a deployment that seals refuses an unsealed row, and one without a key refuses a sealed row', async () => {
    await storeReply(await sealReply(plaintext, 'msgplain0001', REPLY));
    expect(db.rows.get('msgplain0001')!.sealed).toBe(false);
    expect(await readReply(plaintext, 'msgplain0001')).toBe(REPLY);
    await expect(readReply(sealing, 'msgplain0001')).rejects.toThrow('is unsealed, and this deployment seals');
    await expect(readReply(plaintext, 'msgseal00001')).rejects.toThrow('is sealed, and this deployment has no key');
  });

  it('reads null for a message with no stored reply', async () => {
    expect(await readReply(sealing, 'msgnone00001')).toBeNull();
  });
});

describe('askReplyStore: size', () => {
  it('keeps a reply up to 1 MiB whole, and cuts a longer one on a character boundary with a marker', () => {
    expect(keptReply('short')).toEqual({ text: 'short', truncated: false });
    const long = 'é'.repeat(ASK_REPLY_MAX_BYTES); // 2 MiB
    const kept = keptReply(long);
    expect(kept.truncated).toBe(true);
    expect(Buffer.byteLength(kept.text)).toBeLessThanOrEqual(ASK_REPLY_MAX_BYTES);
    expect(kept.text).not.toContain('�');
    expect(kept.text.endsWith(`[termag: the reply was ${2 * ASK_REPLY_MAX_BYTES} bytes; only its first ${ASK_REPLY_MAX_BYTES} bytes were kept.]`)).toBe(true);
  });
});

describe('askReplyStore: the 14-day sweep', () => {
  it('deletes replies stored more than 14 days ago and keeps the rest', async () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const at = (ms: number) => new Date(now.getTime() - ms);
    db.rows.clear();
    for (const [id, age] of [['msgold000001', ASK_REPLY_TTL_MS + 1000], ['msgedge00001', ASK_REPLY_TTL_MS - 1000], ['msgnew000001', 60_000]] as const) {
      db.rows.set(id, { messageId: id, sealed: false, text: Buffer.from('x'), bytes: 1, truncated: false, createdAt: at(age) });
    }
    expect(await sweepReplies(now)).toBe(1);
    expect([...db.rows.keys()].sort()).toEqual(['msgedge00001', 'msgnew000001']);
  });
});
