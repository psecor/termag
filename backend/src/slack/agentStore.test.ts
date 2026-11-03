import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  prisma: {
    slackAgentThread: { findMany: vi.fn(), deleteMany: vi.fn(async () => ({ count: 0 })), upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    slackAgentDmLast: { findMany: vi.fn(), deleteMany: vi.fn(async () => ({ count: 0 })), upsert: vi.fn(async () => ({})) },
  },
}));
vi.mock('../db', () => db);

import { AGENT_THREAD_RETENTION_DAYS, flushAgentWrites, loadAgentThreads, prismaAgentThreadStore } from './agentStore';
import { RUN_HOLDER, RUN_STALE_MS } from './agentSession';
import { claimThread, claudeSessionFor, resetAgentThreadsForTests } from './agentSession';

const now = new Date('2026-10-30T12:00:00Z');
const since = new Date(now.getTime() - AGENT_THREAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentThreadsForTests();
});

describe('loadAgentThreads', () => {
  it('loads the recent threads into memory and prunes the expired ones', async () => {
    db.prisma.slackAgentThread.findMany.mockResolvedValue([
      { channelId: 'C1', threadTs: '1.0', ownerSlackId: 'UA', claudeSessionId: 's1', workingDir: '/p', resetAt: null, updatedAt: now },
    ]);
    db.prisma.slackAgentDmLast.findMany.mockResolvedValue([]);
    expect(await loadAgentThreads(now)).toBe(1);
    expect(db.prisma.slackAgentThread.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { updatedAt: { gte: since } } }));
    expect(db.prisma.slackAgentThread.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lt: since } } });
    expect(claudeSessionFor('C1:1.0', '/p')?.sessionId).toBe('s1');
    expect(claimThread('C1:1.0', 'UB')).toBe('UA');
  });
});

describe('prismaAgentThreadStore', () => {
  it('commits one thread\'s writes in the order they were made', async () => {
    const order: string[] = [];
    db.prisma.slackAgentThread.updateMany.mockImplementation((async (args: any) => {
      // The first write is slower; the second must still land after it.
      await new Promise(r => setTimeout(r, args.data.ownerSlackId ? 20 : 0));
      order.push(args.data.ownerSlackId ? 'owner' : 'session');
      return { count: 1 };
    }) as any);
    prismaAgentThreadStore.saveThread('C2', '1.0', { ownerSlackId: 'UA' });
    prismaAgentThreadStore.saveThread('C2', '1.0', { claudeSessionId: 's', workingDir: '/p', resetAt: null });
    await flushAgentWrites();
    expect(order).toEqual(['owner', 'session']);
    db.prisma.slackAgentThread.updateMany.mockImplementation((async () => ({ count: 1 })) as any);
  });

  it('writes a thread only while no other process holds it', async () => {
    db.prisma.slackAgentThread.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaAgentThreadStore.saveThread('C4', '1.0', { claudeSessionId: 's' });
    await flushAgentWrites();
    const where = (db.prisma.slackAgentThread.updateMany.mock.calls[0] as any)[0].where;
    expect(where).toMatchObject({ channelId: 'C4', threadTs: '1.0' });
    // The same rule as a claim: free, this process's, or lapsed.
    expect(where.OR).toEqual([{ runHolder: null }, { runHolder: RUN_HOLDER }, { runBeatAt: { lt: expect.any(Date) } }]);
    expect(Math.abs(Date.now() - where.OR[2].runBeatAt.lt.getTime() - RUN_STALE_MS)).toBeLessThan(1000);
  });

  it('creates a missing row, and decides again when the row appeared meanwhile', async () => {
    // No row: update finds nothing, create races with another insert and loses,
    // and the update is tried again on the row that now exists.
    db.prisma.slackAgentThread.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any);
    const create = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    (db.prisma.slackAgentThread as any).create = create;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaAgentThreadStore.saveThread('C5', '1.0', { ownerSlackId: 'UA' });
    await flushAgentWrites();
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.prisma.slackAgentThread.updateMany).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('run claims', () => {
  it('claims in one conditional update: free, already ours, or lapsed', async () => {
    db.prisma.slackAgentThread.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    expect(await prismaAgentThreadStore.claimRun('C3', '1.0', 'proc-a')).toBe(true);
    const where = (db.prisma.slackAgentThread.updateMany.mock.calls[0] as any)[0].where;
    expect(where).toMatchObject({ channelId: 'C3', threadTs: '1.0' });
    expect(where.OR).toEqual([
      { runHolder: null }, { runHolder: 'proc-a' }, { runBeatAt: { lt: expect.any(Date) } },
    ]);
    const lapsed = Date.now() - where.OR[2].runBeatAt.lt.getTime();
    expect(Math.abs(lapsed - RUN_STALE_MS)).toBeLessThan(1000);
  });

  it('says no when another live holder has the thread', async () => {
    db.prisma.slackAgentThread.updateMany.mockResolvedValueOnce({ count: 0 } as any);
    expect(await prismaAgentThreadStore.claimRun('C3', '1.0', 'proc-b')).toBe(false);
  });
});

