import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { deleteStatus, getStatus, hydrateStatuses, moveStatus, rehydrateStatuses, setStatus } from './status';
import { AUTO_IDLE_MESSAGE, AUTO_IDLE_MS, AUTO_IDLE_TAIL_CREDIT_MS } from './statusPersistence';

vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));

const SESSION = 'psecor-proj-agent';
const RENAMED = 'psecor-proj-renamed-agent';

function worktimeUpserts() {
  return vi.mocked(prisma.workTimeEntry.upsert).mock.calls.map(c => c[0] as {
    update: { totalMs: { increment: number }; sessions?: { increment: number } };
    create: { totalMs: number; sessions: number };
  });
}

// The auto-idle safety net cuts an open span at the deadline. When the reason
// for the silence was just a slow tool call (working resumes soon after), the
// cut span's tail is credited on resume; real stop boundaries are not.
describe('working-time auto-idle tail credit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    vi.resetAllMocks();
    vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
  });
  afterEach(() => {
    deleteStatus(SESSION, 'i1');
    deleteStatus(RENAMED, 'i1');
    vi.useRealTimers();
  });

  it('credits the silent gap when working resumes within the credit window', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS); // timer fires exactly at the deadline
    expect(getStatus(SESSION, 'i1').status).toBe('idle');
    expect(worktimeUpserts()).toHaveLength(1);
    expect(worktimeUpserts()[0].create.totalMs).toBe(AUTO_IDLE_MS);

    vi.advanceTimersByTime(60_000); // resume 1 min after the cut
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    const ups = worktimeUpserts();
    expect(ups).toHaveLength(2);
    // tail credit: the gap only, no bogus extra span
    expect(ups[1].update.totalMs.increment).toBe(60_000);
    expect(ups[1].update.sessions).toBeUndefined();
    expect(ups[1].create.totalMs).toBe(60_000);
    expect(ups[1].create.sessions).toBe(0);
  });

  it('does not credit a resume beyond the credit window', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS);
    vi.advanceTimersByTime(AUTO_IDLE_TAIL_CREDIT_MS + 60_000);
    setStatus(SESSION, 'working', {}, undefined, 'i1'); // nearly silent hour: real pause
    expect(worktimeUpserts()).toHaveLength(1); // only the cut bank

    // the new span banks normally when it ends
    vi.advanceTimersByTime(60_000);
    setStatus(SESSION, 'idle', {}, undefined, 'i1');
    const ups = worktimeUpserts();
    expect(ups).toHaveLength(2);
    expect(ups[1].create.totalMs).toBe(60_000);
    expect(ups[1].update.sessions).toBeDefined();
  });

  it('real Stop boundaries leave no tail and bank only transitions', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(2 * 60_000);
    setStatus(SESSION, 'idle', {}, undefined, 'i1'); // Stop hook
    expect(worktimeUpserts()).toHaveLength(1);
    expect(worktimeUpserts()[0].create.totalMs).toBe(2 * 60_000);

    vi.advanceTimersByTime(3 * 60_000); // user reads for 3 min, comes back
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    expect(worktimeUpserts()).toHaveLength(1); // no phantom credit
    vi.advanceTimersByTime(60_000);
    setStatus(SESSION, 'idle', {}, undefined, 'i1');
    const ups = worktimeUpserts();
    expect(ups).toHaveLength(2);
    expect(ups[1].create.totalMs).toBe(60_000);
  });

  it('session deletion discards a pending tail', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS);
    expect(worktimeUpserts()).toHaveLength(1);
    deleteStatus(SESSION, 'i1');
    vi.advanceTimersByTime(30_000);
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    expect(worktimeUpserts()).toHaveLength(1); // tail was dropped with the session
  });

  it('a real signal after the cut (agent exits, late Stop) drops the tail', () => {
    for (const after of ['not_running', 'idle', 'waiting'] as const) {
      vi.mocked(prisma.workTimeEntry.upsert).mockClear();
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      vi.advanceTimersByTime(AUTO_IDLE_MS);
      setStatus(SESSION, after, {}, undefined, 'i1');
      vi.advanceTimersByTime(60_000);
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      expect(worktimeUpserts()).toHaveLength(1); // the cut bank only
      deleteStatus(SESSION, 'i1');
    }
  });

  it('credits each incident of a cut → resume → cut → resume cycle', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS);
    vi.advanceTimersByTime(60_000);
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS);
    vi.advanceTimersByTime(2 * 60_000);
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    const tails = worktimeUpserts().filter(u => u.create.sessions === 0).map(u => u.create.totalMs);
    expect(tails).toEqual([60_000, 2 * 60_000]);
  });

  it('a workstream rename between cut and resume keeps the tail', () => {
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS);
    moveStatus(SESSION, RENAMED, 'i1');
    vi.advanceTimersByTime(60_000);
    setStatus(RENAMED, 'working', {}, undefined, 'i1');
    const last = worktimeUpserts().at(-1)!;
    expect(last.create).toMatchObject({ totalMs: 60_000, sessions: 0, project: 'proj' });
  });

  describe('across a restart', () => {
    const row = (over: Record<string, unknown>) => ({
      instanceKey: 'i1', session: SESSION, workingStartedAt: null, provider: null, source: null,
      message: null, waitingReason: null, threadId: null, contextTokens: null, rateLimited: null, milestone: null,
      ...over,
    });

    it('an auto-idled row seeds the tail, so a resume after the restart is credited', async () => {
      const cutAt = Date.now() - 2 * 60_000;
      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'idle', updatedAt: new Date(cutAt), message: AUTO_IDLE_MESSAGE }),
      ] as never);
      await hydrateStatuses(Date.now());
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      expect(worktimeUpserts()).toHaveLength(1);
      expect(worktimeUpserts()[0].create).toMatchObject({ totalMs: 2 * 60_000, sessions: 0 });
    });

    it('a working row past its deadline is cut at hydration and credited on resume', async () => {
      const lastHook = Date.now() - AUTO_IDLE_MS - 60_000;
      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'working', updatedAt: new Date(lastHook), workingStartedAt: new Date(lastHook - 60_000), provider: 'claude' }),
      ] as never);
      await hydrateStatuses(Date.now());
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      const ups = worktimeUpserts();
      expect(ups.map(u => u.create.sessions)).toEqual([1, 0]);
      expect(ups[1].create.totalMs).toBe(60_000);
    });

    it('a late Stop after the cut rewrites the row, so a restart has no tail to re-seed', async () => {
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      vi.advanceTimersByTime(AUTO_IDLE_MS);
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(prisma.sessionStatus.upsert).mockClear();
      setStatus(SESSION, 'idle', {}, undefined, 'i1');
      await vi.advanceTimersByTimeAsync(0);
      const written = vi.mocked(prisma.sessionStatus.upsert).mock.calls.map(c => (c[0] as { update: { message: string | null } }).update.message);
      expect(written).toEqual([null]);
    });

    it('a takeover row that replaces the session drops the tail this process held', async () => {
      const cutAt = Date.now() - 60_000;
      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'idle', updatedAt: new Date(cutAt), message: AUTO_IDLE_MESSAGE }),
      ] as never);
      await hydrateStatuses(Date.now());
      vi.advanceTimersByTime(10_000);
      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'not_running', updatedAt: new Date(Date.now()) }),
      ] as never);
      vi.advanceTimersByTime(1);
      expect(await rehydrateStatuses(Date.now())).toBe(1);
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      expect(worktimeUpserts()).toHaveLength(0);
    });

    it('neither a plain idle row nor an auto-idle past the window seeds one', async () => {
      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'idle', updatedAt: new Date(Date.now() - 60_000) }),
      ] as never);
      await hydrateStatuses(Date.now());
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      expect(worktimeUpserts()).toHaveLength(0);
      deleteStatus(SESSION, 'i1');

      vi.mocked(prisma.sessionStatus.findMany).mockResolvedValue([
        row({ status: 'idle', updatedAt: new Date(Date.now() - AUTO_IDLE_TAIL_CREDIT_MS - 60_000), message: AUTO_IDLE_MESSAGE }),
      ] as never);
      await hydrateStatuses(Date.now());
      setStatus(SESSION, 'working', {}, undefined, 'i1');
      expect(worktimeUpserts()).toHaveLength(0);
    });
  });
});
