/**
 * An agent's working time is banked under its owner's day (services/status.ts
 * with services/userTimeZone.ts): a span or a credited auto-idle tail across
 * the owner's midnight is split between the two days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zones = vi.hoisted(() => ({} as Record<string, string>));
vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    workTimeEntry: { upsert: vi.fn() },
  },
}));
vi.mock('./tmux', () => ({ isAgentRunning: vi.fn() }));
vi.mock('./userTimeZone', () => ({ timeZoneFor: (username: string) => zones[username] }));

const { prisma } = await import('../db');
const { deleteStatus, setStatus } = await import('./status');
const { AUTO_IDLE_MS } = await import('./statusPersistence');

const SESSION = 'psecor-proj-agent';
type Upsert = { where: { username_project_provider_date_instanceId: { date: string } }; update: { totalMs: { increment: number }; sessions?: { increment: number } } };
const banked = () => vi.mocked(prisma.workTimeEntry.upsert).mock.calls
  .map(c => c[0] as unknown as Upsert)
  .map(u => [u.where.username_project_provider_date_instanceId.date, u.update.totalMs.increment, u.update.sessions?.increment ?? 0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetAllMocks();
  vi.mocked(prisma.sessionStatus.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.sessionStatus.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.workTimeEntry.upsert).mockResolvedValue({} as never);
  for (const k of Object.keys(zones)) delete zones[k];
  zones.psecor = 'America/New_York';
});
afterEach(() => {
  deleteStatus(SESSION, 'i1');
  vi.useRealTimers();
});

describe("an agent's working time, banked by its owner's day", () => {
  it("lands on the owner's day", () => {
    vi.setSystemTime(new Date('2026-10-30T01:00:00Z')); // 9 PM on the 29th in New York
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(3 * 60_000);
    setStatus(SESSION, 'idle', {}, undefined, 'i1');
    expect(banked()).toEqual([['2026-10-29', 3 * 60_000, 1]]);
  });

  it("is split at the owner's midnight, the session counted on the day it ended", () => {
    vi.setSystemTime(new Date('2026-10-30T03:58:00Z')); // 11:58 PM
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(4 * 60_000);
    setStatus(SESSION, 'idle', {}, undefined, 'i1');
    expect(banked()).toEqual([
      ['2026-10-29', 2 * 60_000, 0],
      ['2026-10-30', 2 * 60_000, 1],
    ]);
  });

  it('splits a credited auto-idle tail the same way', () => {
    vi.setSystemTime(new Date('2026-10-30T03:52:00Z'));
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    vi.advanceTimersByTime(AUTO_IDLE_MS); // cut at 11:57 PM
    vi.advanceTimersByTime(6 * 60_000); // working again at 12:03 AM
    setStatus(SESSION, 'working', {}, undefined, 'i1');
    expect(banked()).toEqual([
      ['2026-10-29', AUTO_IDLE_MS, 1],
      ['2026-10-29', 3 * 60_000, 0],
      ['2026-10-30', 3 * 60_000, 0],
    ]);
  });
});
