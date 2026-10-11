import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { deleteStatus, getStatus, hydrateStatuses, rehydrateStatuses, setStatus, setStatusChangeCallback, setStatusTimersSuspended } from './status';
import { AUTO_IDLE_MS } from './statusPersistence';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const upsert = vi.mocked(prisma.sessionStatus.upsert);
const deleteMany = vi.mocked(prisma.sessionStatus.deleteMany);
const findMany = vi.mocked(prisma.sessionStatus.findMany);
const workUpsert = vi.mocked(prisma.workTimeEntry.upsert);

const upsertedStatuses = () => upsert.mock.calls.map(([a]) => (a as { update: { status: string } }).update.status);

describe('session_statuses write-through', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    upsert.mockResolvedValue({} as never);
    deleteMany.mockResolvedValue({ count: 0 } as never);
    workUpsert.mockResolvedValue({} as never);
  });
  afterEach(() => vi.useRealTimers());

  it('retries a failed write from the current status, even when nothing else is posted', async () => {
    upsert.mockRejectedValueOnce(new Error('connection reset'));
    setStatus('alice-retry-agent', 'waiting', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(upsertedStatuses()).toEqual(['waiting']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(upsertedStatuses()).toEqual(['waiting', 'waiting']);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('backs off while the database stays down', async () => {
    upsert.mockRejectedValue(new Error('down'));
    setStatus('alice-backoff-agent', 'idle', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upsert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(upsert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it('keeps backing off while repeated working hooks arrive during an outage', async () => {
    upsert.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 20; i++) {
      setStatus('alice-hooks-agent', 'working', { message: `tool ${i}` }, undefined, 'box-1');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // The first write, then the 5 s and 10 s retries: not one write per hook.
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it('still writes a real transition ahead of a pending retry', async () => {
    upsert.mockRejectedValueOnce(new Error('connection reset'));
    setStatus('alice-transition-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(1_000);
    setStatus('alice-transition-agent', 'waiting', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(upsertedStatuses()).toEqual(['working', 'waiting']);
  });

  it('drops the retry once a newer write succeeds', async () => {
    upsert.mockRejectedValueOnce(new Error('connection reset'));
    setStatus('alice-newer-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    setStatus('alice-newer-agent', 'waiting', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(upsertedStatuses()).toEqual(['working', 'waiting']);
  });

  it('retries a failed delete as a delete when the session is gone', async () => {
    deleteMany.mockRejectedValueOnce(new Error('connection reset'));
    setStatus('alice-gone-agent', 'idle', {}, undefined, 'box-1');
    deleteStatus('alice-gone-agent', 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('not_running drops a rateLimited badge; other transitions keep it', async () => {
    setStatus('alice-badge-agent', 'waiting', { rateLimited: 'pi: model error' }, undefined, 'box-1');
    setStatus('alice-badge-agent', 'idle', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    const last = () => (upsert.mock.calls.at(-1)![0] as { update: { rateLimited: string | null } }).update.rateLimited;
    expect(last()).toBe('pi: model error');

    // The agent quit (and will come back as a process that never saw the badge).
    setStatus('alice-badge-agent', 'not_running', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBeNull();
    setStatus('alice-badge-agent', 'idle', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBeNull();
  });

  it('banks a span that auto-idled during the downtime on the day it ended', async () => {
    const deadline = new Date(2026, 9, 6, 23, 55);
    const now = new Date(2026, 9, 7, 0, 10).getTime();
    findMany.mockResolvedValue([{
      instanceKey: 'box-1', session: 'alice-midnight-agent', status: 'working',
      updatedAt: new Date(deadline.getTime() - AUTO_IDLE_MS), workingStartedAt: new Date(2026, 9, 6, 23, 0),
      provider: 'claude', source: null, message: null, waitingReason: null, threadId: null,
      contextTokens: null, rateLimited: null, milestone: null,
    }] as never);
    await hydrateStatuses(now);
    expect(workUpsert).toHaveBeenCalledTimes(1);
    const { create } = workUpsert.mock.calls[0][0] as { create: { date: string; totalMs: number } };
    expect(create).toMatchObject({ date: '2026-10-06', totalMs: 55 * 60_000 });
  });
});

describe('rehydrateStatuses (after a lease takeover)', () => {
  const row = (session: string, status: string, updatedAt: Date) => ({
    instanceKey: 'box-1', session, status, updatedAt, workingStartedAt: status === 'working' ? updatedAt : null,
    provider: 'claude', source: null, message: null, waitingReason: null, threadId: null,
    contextTokens: null, rateLimited: null, milestone: null,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    upsert.mockResolvedValue({} as never);
    deleteMany.mockResolvedValue({ count: 0 } as never);
    workUpsert.mockResolvedValue({} as never);
  });
  afterEach(() => {
    setStatusChangeCallback(() => {});
    vi.useRealTimers();
  });

  it('takes a newer row the displaced process wrote, and drops the span it banked', async () => {
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    setStatus('alice-takeover-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    const changed: string[] = [];
    setStatusChangeCallback(session => changed.push(session));

    vi.setSystemTime(new Date('2026-10-09T10:01:00Z'));
    findMany.mockResolvedValue([row('alice-takeover-agent', 'idle', new Date('2026-10-09T10:00:30Z'))] as never);
    expect(await rehydrateStatuses()).toBe(1);
    expect(getStatus('alice-takeover-agent', 'box-1').status).toBe('idle');
    expect(changed).toEqual(['alice-takeover-agent']);

    // The working span is gone without banking, and its auto-idle never fires.
    setStatus('alice-takeover-agent', 'waiting', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS * 2);
    expect(workUpsert).not.toHaveBeenCalled();
    expect(getStatus('alice-takeover-agent', 'box-1').status).toBe('waiting');
  });

  it('keeps an entry this process wrote after the row', async () => {
    vi.setSystemTime(new Date('2026-10-09T11:00:00Z'));
    setStatus('alice-fresher-agent', 'waiting', {}, undefined, 'box-1');
    findMany.mockResolvedValue([row('alice-fresher-agent', 'idle', new Date('2026-10-09T10:59:00Z'))] as never);
    expect(await rehydrateStatuses()).toBe(0);
    expect(getStatus('alice-fresher-agent', 'box-1').status).toBe('waiting');
  });

  it('keeps a live working session whose row is a stale working write', async () => {
    const written = new Date('2026-10-09T11:30:00Z').getTime();
    vi.setSystemTime(new Date(written + 20_000));
    setStatus('alice-live-agent', 'working', {}, undefined, 'box-1');
    vi.setSystemTime(new Date(written + AUTO_IDLE_MS + 10_000));
    findMany.mockResolvedValue([row('alice-live-agent', 'working', new Date(written))] as never);
    expect(await rehydrateStatuses()).toBe(0);
    expect(getStatus('alice-live-agent', 'box-1').status).toBe('working');
  });

  it('loads a session this process has not seen, with its working span', async () => {
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    findMany.mockResolvedValue([row('alice-unseen-agent', 'working', new Date('2026-10-09T11:59:00Z'))] as never);
    expect(await rehydrateStatuses()).toBe(1);
    expect(getStatus('alice-unseen-agent', 'box-1').status).toBe('working');
    setStatus('alice-unseen-agent', 'idle', {}, undefined, 'box-1');
    expect(workUpsert).toHaveBeenCalledTimes(1);
  });
});

describe('a draining process runs no status timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    upsert.mockResolvedValue({} as never);
    deleteMany.mockResolvedValue({ count: 0 } as never);
    workUpsert.mockResolvedValue({} as never);
  });
  afterEach(() => {
    setStatusTimersSuspended(false);
    vi.useRealTimers();
  });

  const autoIdleWrites = (session: string) => upsert.mock.calls.filter(([arg]) => {
    const { create } = arg as { create: { session: string; message: string | null } };
    return create.session === session && create.message === 'Auto-idled after inactivity';
  });

  it('does not auto-idle (or write the row) while draining', async () => {
    vi.setSystemTime(new Date('2026-10-09T13:00:00Z'));
    setStatus('alice-drain-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    setStatusTimersSuspended(true);
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS * 2);
    expect(getStatus('alice-drain-agent', 'box-1').status).toBe('working');
    expect(autoIdleWrites('alice-drain-agent')).toHaveLength(0);
  });

  it('still persists hook writes while draining, but arms no auto-idle for them', async () => {
    vi.setSystemTime(new Date('2026-10-09T14:00:00Z'));
    setStatusTimersSuspended(true);
    setStatus('alice-grace-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS * 2);
    expect(autoIdleWrites('alice-grace-agent')).toHaveLength(0);
  });

  it('re-arms auto-idle from the entry when it serves again (failover)', async () => {
    vi.setSystemTime(new Date('2026-10-09T15:00:00Z'));
    setStatus('alice-failback-agent', 'working', {}, undefined, 'box-1');
    await vi.advanceTimersByTimeAsync(0);
    setStatusTimersSuspended(true);
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS - 60_000);
    setStatusTimersSuspended(false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(getStatus('alice-failback-agent', 'box-1').status).toBe('working');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getStatus('alice-failback-agent', 'box-1').status).toBe('idle');
    expect(autoIdleWrites('alice-failback-agent')).toHaveLength(1);
  });

  it('a new holder hydrated while suspended does not stomp the displaced process\'s newer row', async () => {
    const written = new Date('2026-10-09T16:00:00Z').getTime();
    const row = (status: string, updatedAt: Date) => ({
      instanceKey: 'box-1', session: 'alice-handoff-agent', status, updatedAt,
      workingStartedAt: status === 'working' ? new Date(written) : null,
      provider: 'claude', source: null, message: null, waitingReason: null, threadId: null,
      contextTokens: null, rateLimited: null, milestone: null,
    });
    // Booted a minute before its auto-idle deadline, timers suspended (lease mode).
    vi.setSystemTime(new Date(written + AUTO_IDLE_MS - 60_000));
    setStatusTimersSuspended(true);
    findMany.mockResolvedValue([row('working', new Date(written))] as never);
    await hydrateStatuses();

    // The drain window: the deadline passes; the displaced process takes a waiting hook.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(autoIdleWrites('alice-handoff-agent')).toHaveLength(0);
    findMany.mockResolvedValue([row('waiting', new Date(written + AUTO_IDLE_MS))] as never);
    expect(await rehydrateStatuses()).toBe(1);
    setStatusTimersSuspended(false);
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS * 2);
    expect(getStatus('alice-handoff-agent', 'box-1').status).toBe('waiting');
    expect(autoIdleWrites('alice-handoff-agent')).toHaveLength(0);
  });

  it('a new holder hydrated while suspended arms the hydrated auto-idle once it serves', async () => {
    const written = new Date('2026-10-09T17:00:00Z').getTime();
    vi.setSystemTime(new Date(written + 60_000));
    setStatusTimersSuspended(true);
    findMany.mockResolvedValue([{
      instanceKey: 'box-1', session: 'alice-armed-agent', status: 'working', updatedAt: new Date(written),
      workingStartedAt: new Date(written), provider: 'claude', source: null, message: null, waitingReason: null,
      threadId: null, contextTokens: null, rateLimited: null, milestone: null,
    }] as never);
    await hydrateStatuses();
    await vi.advanceTimersByTimeAsync(AUTO_IDLE_MS);
    expect(getStatus('alice-armed-agent', 'box-1').status).toBe('working');

    findMany.mockResolvedValue([] as never);
    expect(await rehydrateStatuses()).toBe(0);
    setStatusTimersSuspended(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus('alice-armed-agent', 'box-1').status).toBe('idle');
    expect(autoIdleWrites('alice-armed-agent')).toHaveLength(1);
  });
});
