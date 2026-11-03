/**
 * Stored ask replies (askReplyStore.ts, docs/agent-messaging.md "Stored
 * replies") against a real Postgres, through askService: the box's result
 * stores the reply, sealed, in the transaction that finishes the message; only
 * the sender reads it, after the fact and from another process; the inbox says
 * it is stored and unread; and the ask sweep deletes it after 14 days.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_ask_replies_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_ask_replies_${process.pid}$1`); });

// The transcript store's key, as a raw AES keyring instead of KMS.
const keys = vi.hoisted(() => ({ cfg: null as unknown }));
vi.mock('./chatTranscriptStore', async orig => ({
  ...(await orig<typeof import('./chatTranscriptStore')>()),
  getTranscriptStoreConfig: () => keys.cfg,
}));
vi.mock('./agentRegistry', () => ({
  instanceAgentSettled: vi.fn(() => true),
  instanceAgentTransport: vi.fn(() => null),
  onBoxAgentHello: vi.fn(() => () => {}),
  sendToInstanceAgent: vi.fn(async () => ({ ok: false })),
}));
vi.mock('./boxLifecycle', () => ({ registerBoxBusyCheck: vi.fn() }));
vi.mock('./askReplyListener', () => ({ startReplyListener: vi.fn(), stopReplyListener: vi.fn() }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false), stringVariation: vi.fn(async () => ''), isLdEnabled: vi.fn(() => false) }));

const REPLY = 'Fixed in server/flags.go; the PR is pushed.';
const ada = { id: 'u-ada', unixUsername: 'ada', displayName: 'Ada', googleEmail: 'ada@example.com' };
const bob = { id: 'u-bob', unixUsername: 'bob', displayName: 'Bob', googleEmail: 'bob@example.com' };
const result = (text: string) => ({
  result: text, sessionId: null, isError: false, numTurns: 2, exitReason: null, baseSha: null, repo: null,
  bundle: false, prDescription: null, prDescriptions: {}, pushes: null,
});

describe.skipIf(!adminUrl)('stored ask replies against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let ask: typeof import('./askService');
  const logs: string[] = [];

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    const { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } = await import('@aws-crypto/client-node');
    keys.cfg = {
      rawCap: 1,
      materials: new RawAesKeyringNode({
        keyName: 'test', keyNamespace: 'termag-test', unencryptedMasterKey: randomBytes(32),
        wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
      }),
    };
    ({ prisma } = await import('../db'));
    ask = await import('./askService');
    for (const u of [ada, bob]) await prisma.user.create({ data: { id: u.id, googleId: `g-${u.id}`, googleEmail: u.googleEmail, unixUsername: u.unixUsername, displayName: u.displayName } });
    await prisma.project.create({ data: { id: 'p1', name: 'api', userId: ada.id } });
    await prisma.agentThread.create({ data: { id: 'thr000000001', originUserId: ada.id, projectId: 'p1', instanceId: 'box1' } });
    for (const log of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, log).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    }
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  async function working(id: string) {
    await prisma.agentMessage.create({
      data: { id, threadId: 'thr000000001', senderUserId: ada.id, projectId: 'p1', workstream: 'main', instanceId: 'box1', hop: 1, status: 'working', promptBytes: 3, startedAt: new Date() },
    });
  }

  async function finished(id: string) {
    for (let i = 0; i < 200; i++) {
      const m = await prisma.agentMessage.findUnique({ where: { id }, select: { completedAt: true } });
      if (m?.completedAt) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`${id} never finished`);
  }

  it('stores the reply sealed, in the transaction that finishes the message', async () => {
    await working('msgstore0001');
    expect((await ask.prismaCliAsk.recordResult('box1', 'msgstore0001', result(REPLY))).status).toBe(202);
    await finished('msgstore0001');
    const m = await prisma.agentMessage.findUnique({ where: { id: 'msgstore0001' }, include: { storedReply: true } });
    expect(m).toMatchObject({ status: 'completed', publish: 'none', replyBytes: Buffer.byteLength(REPLY) });
    // Written with the finish: a message that reads finished has its reply stored.
    expect(m!.storedReply).toMatchObject({ sealed: true, bytes: Buffer.byteLength(REPLY), truncated: false });
    expect(m!.storedReply!.createdAt.getTime()).toBeLessThanOrEqual(m!.completedAt!.getTime() + 1000);
    // At rest it is ciphertext: no part of the reply is in the column.
    const raw = await prisma.$queryRaw<Array<{ text: Buffer }>>`SELECT "text" FROM ask_replies WHERE "messageId" = 'msgstore0001'`;
    expect(raw[0].text.includes(Buffer.from('flags.go'))).toBe(false);
    // Never logged: the [ASK] line has the size, not the text.
    expect(logs.some(l => l.includes('msgstore0001') && l.includes('(stored)'))).toBe(true);
    expect(logs.some(l => l.includes('flags.go'))).toBe(false);
  });

  it('only the sender reads it: anyone else gets a 404 and the reply stays unread', async () => {
    const r = await ask.prismaCliAsk.getMessage(bob as never, 'msgstore0001', 0);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('flags.go');
    expect((await prisma.agentMessage.findUnique({ where: { id: 'msgstore0001' } }))!.readAt).toBeNull();
  });

  it('the inbox says the reply is stored and nobody has read it', async () => {
    const r = await ask.prismaCliAsk.inbox(ada as never);
    const row = (r.body as { messages: Array<Record<string, unknown>> }).messages.find(m => m.message === 'msgstore0001');
    expect(row).toMatchObject({ replyStored: true, replyKept: true, replyDelivered: false, reply: null });
    const bobs = await ask.prismaCliAsk.inbox(bob as never);
    expect((bobs.body as { messages: unknown[] }).messages).toEqual([]);
  });

  it('the sender reads it after the fact, from a process that never held it, and that marks it read', async () => {
    vi.resetModules();
    const other = await import('./askService');
    const r = await other.prismaCliAsk.getMessage(ada as never, 'msgstore0001', 0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ message: 'msgstore0001', status: 'completed', reply: REPLY, replyStored: true, replyKept: true, replyDelivered: true, publish: { status: 'none' } });
    expect((await prisma.agentMessage.findUnique({ where: { id: 'msgstore0001' } }))!.readAt).not.toBeNull();
    // Still stored: a second read gets it again.
    expect((await other.prismaCliAsk.getMessage(ada as never, 'msgstore0001', 0)).body).toMatchObject({ reply: REPLY });
    const { prisma: otherDb } = await import('../db');
    await otherDb.$disconnect();
  });

  it('the chat asks route says stored for an unread stored reply', async () => {
    await working('msgchat00001');
    await ask.prismaCliAsk.recordResult('box1', 'msgchat00001', result('another'));
    await finished('msgchat00001');
    const { replyState } = await import('./chatAsks');
    const m = await prisma.agentMessage.findUnique({ where: { id: 'msgchat00001' }, include: { storedReply: { select: { bytes: true } } } });
    expect(replyState(m!)).toBe('stored');
    expect(replyState({ ...m!, readAt: new Date() })).toBe('delivered');
    expect(replyState({ ...m!, storedReply: null })).toBe('dropped');
  });

  it('a poll right after the finish waits for the full reply over NOTIFY rather than return the cut stored copy', async () => {
    const long = 'x'.repeat(1024 * 1024 + 10);
    await working('msglong00001');
    await ask.prismaCliAsk.recordResult('box1', 'msglong00001', result(long));
    await finished('msglong00001');
    expect((await prisma.askReply.findUnique({ where: { messageId: 'msglong00001' } }))!.truncated).toBe(true);
    // Another process: it holds nothing yet, and its NOTIFY arrives 200 ms into the poll.
    vi.resetModules();
    const other = await import('./askService');
    const { startReplyListener } = await import('./askReplyListener');
    other.startAskReplies();
    const deliver = vi.mocked(startReplyListener).mock.calls[0][0] as (id: string, text: string) => void;
    setTimeout(() => deliver('msglong00001', long), 200);
    const r = await other.prismaCliAsk.getMessage(ada as never, 'msglong00001', 10);
    expect((r.body as { reply: string }).reply.length).toBe(long.length);
    const { prisma: otherDb } = await import('../db');
    await otherDb.$disconnect();
  });

  it('the ask sweep deletes a reply after 14 days; the message keeps its size', async () => {
    const now = new Date();
    await prisma.askReply.update({ where: { messageId: 'msgstore0001' }, data: { createdAt: new Date(now.getTime() - 15 * 24 * 3600_000) } });
    await ask.sweepAsks(now);
    expect(await prisma.askReply.findUnique({ where: { messageId: 'msgstore0001' } })).toBeNull();
    expect(await prisma.askReply.findUnique({ where: { messageId: 'msgchat00001' } })).not.toBeNull();
    const m = await prisma.agentMessage.findUnique({ where: { id: 'msgstore0001' } });
    expect(m!.replyBytes).toBe(Buffer.byteLength(REPLY));
    const r = await ask.prismaCliAsk.getMessage(ada as never, 'msgstore0001', 0);
    expect(r.body).toMatchObject({ replyStored: false, replyKept: true });
    expect(logs.some(l => l.includes('1 stored repl(ies) past 14 days deleted'))).toBe(true);
  });

  it('deleting the message deletes its stored reply', async () => {
    await prisma.agentMessage.delete({ where: { id: 'msgchat00001' } });
    expect(await prisma.askReply.findUnique({ where: { messageId: 'msgchat00001' } })).toBeNull();
  });
});
