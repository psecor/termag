import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: { user: { findMany: vi.fn() }, agentSpawn: { groupBy: vi.fn() } } }));
vi.mock('../spawnBudget', () => ({
  RUNNING_SPAWN_WHERE: { endedAt: null, parkedAt: null, state: { not: 'failed' } },
  spawnLimitsFor: vi.fn(),
}));

const { prisma } = await import('../../db');
const { RUNNING_SPAWN_WHERE, spawnLimitsFor } = await import('../spawnBudget');
const { DEFAULT_SPAWN_LIMITS } = await import('../spawnLimits');
const { limitOverrides, spawnLimitsReport } = await import('./spawnLimitsQueries');

const user = (id: string) => ({ id, googleEmail: `${id}@example.test`, displayName: id, unixUsername: id, defaultAgentProvider: 'claude' });
const counts = (m: Record<string, number>) => Object.entries(m).map(([userId, n]) => ({ userId, _count: { _all: n } }));

describe('limitOverrides', () => {
  it('is empty for the defaults and names every key the flag changed', () => {
    expect(limitOverrides(DEFAULT_SPAWN_LIMITS)).toEqual([]);
    expect(limitOverrides({ ...DEFAULT_SPAWN_LIMITS, perHour: 100, maxConcurrentPerUser: 32, hot: { ...DEFAULT_SPAWN_LIMITS.hot, memPct: 90 } }))
      .toEqual(['perHour', 'maxConcurrentPerUser', 'hot.memPct']);
  });

  it('counts a box capacity set over the default no-cap', () => {
    expect(limitOverrides({ ...DEFAULT_SPAWN_LIMITS, boxCapacity: 12 })).toEqual(['boxCapacity']);
  });
});

describe('spawnLimitsReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists users with spawns, a running spawn or an override, overrides first, with the counts', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(['ada', 'bob', 'cy', 'dee'].map(user) as never);
    // groupBy order: last 30 days, last hour, running.
    vi.mocked(prisma.agentSpawn.groupBy)
      .mockResolvedValueOnce(counts({ bob: 5 }) as never)
      .mockResolvedValueOnce(counts({ bob: 2 }) as never)
      .mockResolvedValueOnce(counts({ bob: 1, cy: 1 }) as never);
    vi.mocked(spawnLimitsFor).mockImplementation(async u => (u.id === 'ada' ? { ...DEFAULT_SPAWN_LIMITS, perHour: 100 } : DEFAULT_SPAWN_LIMITS));

    const r = await spawnLimitsReport(Date.parse('2026-10-23T05:00:00Z'));

    // dee: no spawns, nothing running, defaults → left out. cy: only an old spawn still running → kept.
    expect(r.users.map(u => u.user.unixUsername)).toEqual(['ada', 'bob', 'cy']);
    expect(r.users[0]).toMatchObject({ overrides: ['perHour'], usage: { lastHour: 0, running: 0, last30d: 0 } });
    expect(r.users[1]).toMatchObject({ overrides: [], usage: { lastHour: 2, running: 1, last30d: 5 } });
    expect(r.users[2]).toMatchObject({ usage: { lastHour: 0, running: 1, last30d: 0 } });
    expect(r.defaults).toEqual(DEFAULT_SPAWN_LIMITS);
    expect(r.flag.key).toBe('agent-spawn-limits');
  });

  it('counts running with the predicate the concurrency limit is enforced with, and evaluates each user on no box', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([user('ada')] as never);
    vi.mocked(prisma.agentSpawn.groupBy).mockResolvedValue([] as never);
    vi.mocked(spawnLimitsFor).mockResolvedValue(DEFAULT_SPAWN_LIMITS);
    await spawnLimitsReport(Date.parse('2026-10-23T05:00:00Z'));
    expect(vi.mocked(prisma.agentSpawn.groupBy).mock.calls[2][0]).toMatchObject({ where: RUNNING_SPAWN_WHERE });
    expect(vi.mocked(prisma.agentSpawn.groupBy).mock.calls[1][0]).toMatchObject({ where: { createdAt: { gte: new Date('2026-10-23T04:00:00Z') } } });
    expect(spawnLimitsFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'ada' }), null);
  });
});
