import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { deleteStatus, setStatus, setStatusTransitionCallback, updateStatusMeta } from './status';
import { AUTO_IDLE_MS } from './statusPersistence';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const S = 'u-p-ws-agent';

describe('the status transition callback (spawn status history)', () => {
  const seen = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
    setStatusTransitionCallback(seen);
  });
  afterEach(() => {
    setStatusTransitionCallback(null);
    deleteStatus(S, 'i1');
    vi.useRealTimers();
  });

  it('fires on a change of status only, not on a repeat or a metadata write', () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    setStatus(S, 'working', { message: 'still' }, undefined, 'i1');
    updateStatusMeta(S, { contextTokens: 5 }, 'i1');
    setStatus(S, 'waiting', {}, undefined, 'i1');
    expect(seen.mock.calls).toEqual([[S, 'i1', undefined, 'working'], [S, 'i1', 'working', 'waiting']]);
  });

  it('fires on the auto-idle safety net', () => {
    setStatus(S, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS + 1);
    expect(seen).toHaveBeenLastCalledWith(S, 'i1', 'working', 'idle');
  });
});
