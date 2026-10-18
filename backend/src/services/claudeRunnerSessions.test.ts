import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { discardRunnerStart, nextSessionSeq, parseRunnerEvent, recordRunnerEnd, recordRunnerStart, recordRunnerStarted, recordRunnerTitle, recordRunnerUsage, titleFromPrompt } from './claudeRunnerSessions';

vi.mock('../db', () => ({ prisma: {
  claudeRunnerSession: { upsert: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  user: { update: vi.fn() },
} }));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', orderId: 'ord.1', userId: 'u1', sessionId: 'cse_01A', instanceId: 'box-a', slot: 2,
  startedAt: new Date('2026-10-08T10:00:00Z'), endedAt: null, exitStatus: null, exitReason: null, title: null,
  user: { unixUsername: 'ada' }, instance: { name: 'ada-box' }, ...over,
});
const who = { userId: 'u1', who: 'ada', sessionId: 'cse_01A', instanceId: 'box-a', boxName: 'ada-box', slot: 2 };

describe('recordRunnerStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.claudeRunnerSession.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({ claudeSessionSeq: 5 } as never);
  });

  it("upserts on the order id: a relaunch moves the row to the new box and slot and reopens it, numbering a new session from the owner's counter", async () => {
    const startedAt = new Date('2026-10-08T10:00:00Z');
    await recordRunnerStart({ orderId: 'ord.1', sessionId: 'cse_01A', userId: 'u1', instanceId: 'box-b', slot: 3, startedAt });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { claudeSessionSeq: { increment: 1 } }, select: { claudeSessionSeq: true } });
    expect(prisma.claudeRunnerSession.upsert).toHaveBeenCalledWith({
      where: { orderId: 'ord.1' },
      create: { orderId: 'ord.1', sessionId: 'cse_01A', userId: 'u1', instanceId: 'box-b', slot: 3, startedAt, sessionSeq: 5 },
      update: { userId: 'u1', instanceId: 'box-b', slot: 3, startedAt, sessionId: 'cse_01A', endedAt: null, exitStatus: null, exitReason: null, sessionSeq: 5,
        // A relaunch is a new run: the earlier launch's token totals are not its.
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreateTokens: null, usageCalls: null, model: null, usageAt: null, checkoutBytes: null, kept: null },
    });
  });

  it('carries the title and the number of an earlier run of the same session into the new run', async () => {
    vi.mocked(prisma.claudeRunnerSession.findFirst)
      .mockResolvedValueOnce({ title: 'Fix the flaky auth test' } as never)
      .mockResolvedValueOnce({ sessionSeq: 2 } as never);
    const startedAt = new Date('2026-10-08T12:00:00Z');
    await recordRunnerStart({ orderId: 'ord.2', sessionId: 'cse_01A', userId: 'u1', instanceId: 'box-a', slot: 2, startedAt });
    expect(prisma.claudeRunnerSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'cse_01A', title: { not: null } } }));
    expect(prisma.claudeRunnerSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'cse_01A', sessionSeq: { not: null } } }));
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.claudeRunnerSession.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ orderId: 'ord.2', title: 'Fix the flaky auth test', sessionSeq: 2 }),
      update: expect.objectContaining({ title: 'Fix the flaky auth test', sessionSeq: 2 }),
    }));
  });

  it('looks neither title nor number up for a start without a session id', async () => {
    await recordRunnerStart({ orderId: 'ord.3', sessionId: null, userId: 'u1', instanceId: 'box-a', slot: 2, startedAt: new Date() });
    expect(prisma.claudeRunnerSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.claudeRunnerSession.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.not.objectContaining({ sessionSeq: expect.anything() }) }));
  });

  it('draws the number from the owner counter, which the run rows\' retention never resets', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({ claudeSessionSeq: 1 } as never);
    expect(await nextSessionSeq('u2')).toBe(1);
  });

  it('discards the row of a launch that failed', async () => {
    await discardRunnerStart('ord.1');
    expect(prisma.claudeRunnerSession.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'ord.1' } });
  });
});

describe('parseRunnerEvent', () => {
  const now = new Date('2026-10-08T11:00:00Z');

  it('takes the box clock when it is inside the trust window', () => {
    expect(parseRunnerEvent({ event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'completed', endedAt: '2026-10-08T10:59:30Z' }, now))
      .toEqual({ event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'completed', endedAt: new Date('2026-10-08T10:59:30Z'), checkoutBytes: null, kept: null });
  });

  it('uses now for a box clock more than ten minutes off, and null for no reason', () => {
    expect(parseRunnerEvent({ event: 'ended', orderId: 'ord.1', exitStatus: 1, endedAt: '2026-10-08T09:00:00Z' }, now))
      .toEqual({ event: 'ended', orderId: 'ord.1', exitStatus: 1, exitReason: null, endedAt: now, checkoutBytes: null, kept: null });
  });

  it('parses a started report, platform and time optional, the time inside the trust window', () => {
    expect(parseRunnerEvent({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'web_claude_ai', at: '2026-10-08T10:59:00Z' }, now))
      .toEqual({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'web_claude_ai', at: new Date('2026-10-08T10:59:00Z') });
    expect(parseRunnerEvent({ event: 'started', orderId: 'ord.1', sessionId: ' cse_01A ', clientPlatform: '' }, now))
      .toEqual({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: null, at: null });
    expect(parseRunnerEvent({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', at: '2026-10-08T08:00:00Z' }, now)).toMatchObject({ at: now });
    expect(parseRunnerEvent({ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', at: 'soon' }, now)).toEqual({ error: 'at must be an ISO-8601 timestamp' });
  });

  it('parses a title down to the first line, collapsed and cut', () => {
    expect(parseRunnerEvent({ event: 'title', orderId: 'ord.1', title: '\n  Fix   the\tauth bug\nin login.ts' }, now))
      .toEqual({ event: 'title', orderId: 'ord.1', title: 'Fix the auth bug' });
    const long = 'x'.repeat(300);
    const parsed = parseRunnerEvent({ event: 'title', orderId: 'ord.1', title: long }, now);
    expect('title' in parsed && parsed.title.length).toBe(120);
    expect(titleFromPrompt('   \n\n')).toBeNull();
  });

  it.each([
    [{ event: 'serving', orderId: 'ord.1' }, "event must be 'ended', 'started', 'title' or 'usage'"],
    [{ event: 'started', orderId: 'ord.1' }, 'sessionId missing or not a session id'],
    [{ event: 'started', orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'Web App!' }, 'clientPlatform must be a short lowercase token'],
    [{ event: 'title', orderId: 'ord.1', title: '  ' }, 'title missing or empty'],
    [{ event: 'ended', orderId: '../x', exitStatus: 0 }, 'orderId missing or not a safe identifier'],
    [{ event: 'ended', orderId: 'ord.1', exitStatus: 256 }, 'exitStatus must be an integer from 0 to 255'],
    [{ event: 'ended', orderId: 'ord.1', exitStatus: '0' }, 'exitStatus must be an integer from 0 to 255'],
    [{ event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'Oops!' }, 'exitReason must be a short lowercase token'],
    [{ event: 'ended', orderId: 'ord.1', exitStatus: 0, endedAt: 'yesterday' }, 'endedAt must be an ISO-8601 timestamp'],
    ['nope', 'body must be a JSON object'],
  ])('refuses %j', (body, error) => {
    expect(parseRunnerEvent(body, now)).toEqual({ error });
  });
});

describe('recordRunnerEnd', () => {
  const end = { orderId: 'ord.1', exitStatus: 0, exitReason: 'completed', endedAt: new Date('2026-10-08T11:23:20Z') };
  beforeEach(() => vi.clearAllMocks());

  it('stamps the end once and reports owner, box, slot and duration', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 });
    expect(await recordRunnerEnd('box-a', end)).toEqual({
      kind: 'ended', ...who, durationSec: 5000, exitStatus: 0, exitReason: 'completed',
    });
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', endedAt: null }, data: { endedAt: end.endedAt, exitStatus: 0, exitReason: 'completed' },
    });
  });

  it('answers repeat when the end is already stamped (two reports of one end)', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 0 });
    expect(await recordRunnerEnd('box-a', end)).toEqual({ kind: 'repeat' });
  });

  it('ignores a report from before the current launch (a relaunched order; the earlier run reporting late)', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ startedAt: new Date('2026-10-08T11:30:00Z') }) as never);
    expect(await recordRunnerEnd('box-a', end)).toEqual({ kind: 'stale', startedAt: new Date('2026-10-08T11:30:00Z') });
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });

  it('answers unknown for an order whose start was never recorded', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(null);
    expect(await recordRunnerEnd('box-a', end)).toEqual({ kind: 'unknown' });
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });

  it("writes nothing for another box's order", async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ instanceId: 'box-b' }) as never);
    expect(await recordRunnerEnd('box-a', end)).toEqual({ kind: 'other-box' });
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('recordRunnerStarted', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the platform, keeps the spawn\'s session id and reports the run', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'ios', at: null }))
      .toEqual({ kind: 'started', ...who, clientPlatform: 'ios' });
    expect(prisma.claudeRunnerSession.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { sessionId: 'cse_01A', clientPlatform: 'ios' } });
  });

  it('fills a missing session id from the box and warns when the two disagree', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ sessionId: null }) as never);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01B', clientPlatform: null, at: null })).toMatchObject({ kind: 'started', sessionId: 'cse_01B' });
    expect(prisma.claudeRunnerSession.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { sessionId: 'cse_01B' } });
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01B', clientPlatform: null, at: null })).toMatchObject({ sessionId: 'cse_01A' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("keeping the spawn's"));
  });

  it('ignores a started report from before the current launch of a relaunched order', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ startedAt: new Date('2026-10-08T11:30:00Z') }) as never);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: 'ios', at: new Date('2026-10-08T11:00:00Z') }))
      .toEqual({ kind: 'stale', startedAt: new Date('2026-10-08T11:30:00Z') });
    expect(prisma.claudeRunnerSession.update).not.toHaveBeenCalled();
  });

  it("answers unknown and other-box without writing", async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValueOnce(null);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: null, at: null })).toEqual({ kind: 'unknown' });
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValueOnce(row({ instanceId: 'box-b' }) as never);
    expect(await recordRunnerStarted('box-a', { orderId: 'ord.1', sessionId: 'cse_01A', clientPlatform: null, at: null })).toEqual({ kind: 'other-box' });
    expect(prisma.claudeRunnerSession.update).not.toHaveBeenCalled();
  });
});

describe('recordRunnerTitle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets the title once; the first prompt wins', async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValueOnce({ count: 1 });
    expect(await recordRunnerTitle('box-a', { orderId: 'ord.1', title: 'Fix the auth bug' })).toEqual({ kind: 'set', ...who });
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', title: null }, data: { title: 'Fix the auth bug' } });
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValueOnce({ count: 0 });
    expect(await recordRunnerTitle('box-a', { orderId: 'ord.1', title: 'Second prompt' })).toEqual({ kind: 'kept', ...who });
  });

  it("refuses another box's order", async () => {
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ instanceId: 'box-b' }) as never);
    expect(await recordRunnerTitle('box-a', { orderId: 'ord.1', title: 'x' })).toEqual({ kind: 'other-box' });
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('usage', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const body = { event: 'usage', orderId: 'ord.1', input: 1200, output: 340, cacheRead: 90000, cacheCreate: 5000, calls: 14, model: 'claude-opus-5-5', at: '2026-10-09T11:59:00Z' };

  it('parses a cumulative summary: whole non-negative counts, an optional call count and model, the box clock within trust', () => {
    expect(parseRunnerEvent(body, now)).toEqual({
      event: 'usage', orderId: 'ord.1', input: 1200n, output: 340n, cacheRead: 90000n, cacheCreate: 5000n, calls: 14, model: 'claude-opus-5-5', at: new Date('2026-10-09T11:59:00Z'),
    });
    expect(parseRunnerEvent({ ...body, calls: undefined, model: undefined, at: undefined }, now)).toMatchObject({ calls: null, model: null, at: now });
    // A clock an hour off is replaced by the server's now.
    expect(parseRunnerEvent({ ...body, at: '2026-10-09T10:00:00Z' }, now)).toMatchObject({ at: now });
    expect(parseRunnerEvent({ ...body, input: -1 }, now)).toHaveProperty('error');
    expect(parseRunnerEvent({ ...body, input: 1.5 }, now)).toHaveProperty('error');
    expect(parseRunnerEvent({ ...body, calls: 'many' }, now)).toHaveProperty('error');
    expect(parseRunnerEvent({ ...body, model: 'a model with spaces' }, now)).toHaveProperty('error');
    expect(parseRunnerEvent({ ...body, at: 'yesterday' }, now)).toHaveProperty('error');
  });

  it('records the newest summary only, for the box that ran the order', async () => {
    vi.clearAllMocks();
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 } as never);
    const usage = parseRunnerEvent(body, now) as Extract<ReturnType<typeof parseRunnerEvent>, { event: 'usage' }>;
    expect(await recordRunnerUsage('box-a', usage)).toMatchObject({ kind: 'set', ...who });
    expect(prisma.claudeRunnerSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', OR: [{ usageAt: null }, { usageAt: { lt: usage.at } }] },
      data: { inputTokens: 1200n, outputTokens: 340n, cacheReadTokens: 90000n, cacheCreateTokens: 5000n, usageCalls: 14, model: 'claude-opus-5-5', usageAt: usage.at },
    });
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 0 } as never);
    expect(await recordRunnerUsage('box-a', usage)).toMatchObject({ kind: 'stale' });
    expect(await recordRunnerUsage('box-b', usage)).toEqual({ kind: 'other-box' });
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(null);
    expect(await recordRunnerUsage('box-a', usage)).toEqual({ kind: 'unknown' });
    // The order was relaunched at 11:58 and this summary was summed at 10:00 by the earlier launch: not this run's.
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row({ startedAt: new Date('2026-10-09T11:58:00Z') }) as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockClear();
    expect(await recordRunnerUsage('box-a', { ...usage, at: new Date('2026-10-09T10:00:00Z') })).toMatchObject({ kind: 'stale' });
    expect(prisma.claudeRunnerSession.updateMany).not.toHaveBeenCalled();
    // Within a minute of the launch it still counts (box clocks drift by seconds).
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 } as never);
    expect(await recordRunnerUsage('box-a', { ...usage, at: new Date('2026-10-09T11:57:30Z') })).toMatchObject({ kind: 'set' });
  });
});

describe('ended with the checkout size and kept flag', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  it('parses both when present, neither from an older wrapper, and refuses nonsense', () => {
    const base = { event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'completed' };
    expect(parseRunnerEvent(base, now)).toMatchObject({ checkoutBytes: null, kept: null });
    expect(parseRunnerEvent({ ...base, checkoutBytes: 8000000000, kept: true }, now)).toMatchObject({ checkoutBytes: 8000000000n, kept: true });
    expect(parseRunnerEvent({ ...base, checkoutBytes: -1 }, now)).toHaveProperty('error');
    expect(parseRunnerEvent({ ...base, kept: 'yes' }, now)).toHaveProperty('error');
  });
  it('stamps them on the row with the end, and leaves them alone when the wrapper sent none', async () => {
    vi.clearAllMocks();
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    vi.mocked(prisma.claudeRunnerSession.updateMany).mockResolvedValue({ count: 1 } as never);
    const end = parseRunnerEvent({ event: 'ended', orderId: 'ord.1', exitStatus: 0, exitReason: 'completed', endedAt: '2026-10-09T11:59:00Z', checkoutBytes: 4096, kept: false }, now) as Extract<ReturnType<typeof parseRunnerEvent>, { event: 'ended' }>;
    await recordRunnerEnd('box-a', end);
    expect(vi.mocked(prisma.claudeRunnerSession.updateMany).mock.calls[0][0]).toMatchObject({ data: { exitReason: 'completed', checkoutBytes: 4096n, kept: false } });
    vi.mocked(prisma.claudeRunnerSession.findUnique).mockResolvedValue(row() as never);
    const bare = parseRunnerEvent({ event: 'ended', orderId: 'ord.1', exitStatus: 0 }, now) as Extract<ReturnType<typeof parseRunnerEvent>, { event: 'ended' }>;
    await recordRunnerEnd('box-a', bare);
    const data = vi.mocked(prisma.claudeRunnerSession.updateMany).mock.calls[1][0].data as Record<string, unknown>;
    expect('checkoutBytes' in data).toBe(false);
    expect('kept' in data).toBe(false);
  });
});
