import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { deleteStatus, getStatus, moveStatus, setStatus } from './status';
import { MILESTONE_TTL_MS } from './milestone';
import { resetTurnsForTests, settleTurnPost } from './sessionTurns';
import { statusKey } from './statusKey';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

describe('moveStatus (workstream rename)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
  });
  afterEach(() => {
    deleteStatus('u-p-old-agent', 'i1');
    deleteStatus('u-p-new-agent', 'i1');
    vi.useRealTimers();
  });

  it('carries status and meta to the new name and clears the old', () => {
    setStatus('u-p-old-agent', 'waiting', { contextTokens: 1234, waitingReason: 'permission' }, undefined, 'i1');
    expect(moveStatus('u-p-old-agent', 'u-p-new-agent', 'i1')).toBe(true);
    expect(getStatus('u-p-old-agent', 'i1').status).toBe('not_running');
    const moved = getStatus('u-p-new-agent', 'i1');
    expect(moved.status).toBe('waiting');
    expect(moved.contextTokens).toBe(1234);
    expect(moved.waitingReason).toBe('permission');
  });

  it('keeps a desktop thread that is still working counted under the new name', () => {
    resetTurnsForTests();
    settleTurnPost(statusKey('i1', 'u-p-old-agent'), { status: 'working', source: 't3:claude', threadId: 'A' });
    setStatus('u-p-old-agent', 'working', { source: 't3:claude' }, undefined, 'i1');
    expect(moveStatus('u-p-old-agent', 'u-p-new-agent', 'i1')).toBe(true);
    // Another thread's Stop under the new name: A still works.
    expect(settleTurnPost(statusKey('i1', 'u-p-new-agent'), { status: 'idle', source: 't3:claude', threadId: 'B' }).status).toBe('working');
  });

  it('returns false and writes nothing when the old session had no live status', () => {
    expect(moveStatus('u-p-old-agent', 'u-p-new-agent', 'i1')).toBe(false);
    expect(getStatus('u-p-new-agent', 'i1').status).toBe('not_running');
  });

  it('re-arms the pending milestone so it still expires under the new name', () => {
    const at = new Date(Date.now() - 10 * 60 * 1000); // 10 min into the 30 min TTL
    setStatus('u-p-old-agent', 'idle', { milestone: { kind: 'pr_created', url: null, at, contextTokens: null } }, undefined, 'i1');
    moveStatus('u-p-old-agent', 'u-p-new-agent', 'i1');
    expect(getStatus('u-p-new-agent', 'i1').milestone?.kind).toBe('pr_created');
    vi.advanceTimersByTime(MILESTONE_TTL_MS - 10 * 60 * 1000 - 1000);
    expect(getStatus('u-p-new-agent', 'i1').milestone?.kind).toBe('pr_created');
    vi.advanceTimersByTime(2000);
    expect(getStatus('u-p-new-agent', 'i1').milestone ?? null).toBeNull();
  });
});
