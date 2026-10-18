import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { comesToRest, deleteStatus, getStatus, moveStatus, setStatus, updateStatusMeta } from './status';
import { AUTO_IDLE_MS, hydrateStatus, toRow } from './statusPersistence';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const S = 'u-p-ws-agent';

describe('stoppedAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
  });
  afterEach(() => {
    deleteStatus(S, 'i1');
    deleteStatus('u-p-new-agent', 'i1');
    vi.useRealTimers();
  });

  it('counts only busy → at-rest transitions', () => {
    expect(comesToRest('working', 'idle')).toBe(true);
    expect(comesToRest('waiting', 'idle')).toBe(true);
    expect(comesToRest('working', 'not_running')).toBe(true);
    expect(comesToRest('working', 'waiting')).toBe(false);
    expect(comesToRest('idle', 'not_running')).toBe(false);
    expect(comesToRest(undefined, 'idle')).toBe(false);
  });

  it('is stamped when the agent stops and survives later writes', () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    expect(getStatus(S, 'i1').stoppedAt ?? null).toBeNull();
    vi.advanceTimersByTime(60_000);
    setStatus(S, 'idle', {}, undefined, 'i1');
    const stopped = getStatus(S, 'i1').stoppedAt;
    expect(stopped?.toISOString()).toBe('2026-10-13T12:01:00.000Z');

    vi.advanceTimersByTime(60_000);
    setStatus(S, 'idle', { message: 'again' }, undefined, 'i1');
    updateStatusMeta(S, { contextTokens: 10 }, 'i1');
    setStatus(S, 'working', {}, undefined, 'i1');
    expect(getStatus(S, 'i1').stoppedAt).toEqual(stopped);
  });

  it('is stamped by the auto-idle safety net', () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS + 1);
    expect(getStatus(S, 'i1').status).toBe('idle');
    expect(getStatus(S, 'i1').stoppedAt?.getTime()).toBe(new Date('2026-10-13T12:00:00Z').getTime() + AUTO_IDLE_MS);
  });

  it('moves with a renamed workstream', () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    setStatus(S, 'idle', {}, undefined, 'i1');
    const stopped = getStatus(S, 'i1').stoppedAt;
    vi.advanceTimersByTime(60_000);
    moveStatus(S, 'u-p-new-agent', 'i1');
    expect(getStatus('u-p-new-agent', 'i1').stoppedAt).toEqual(stopped);
  });

  it('round-trips through the row, and a working row idled at hydration stops at its deadline', () => {
    const at = new Date('2026-10-13T11:00:00Z');
    const row = toRow('i1', S, { status: 'idle', updatedAt: at, stoppedAt: at }, undefined);
    expect(row.stoppedAt).toEqual(at);
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(hydrateStatus([row], now)[0].status.stoppedAt).toEqual(at);

    const working = { ...toRow('i1', S, { status: 'working', updatedAt: at }, undefined) };
    const [h] = hydrateStatus([working], now);
    expect(h.status.status).toBe('idle');
    expect(h.status.stoppedAt?.getTime()).toBe(at.getTime() + AUTO_IDLE_MS);
  });
});
