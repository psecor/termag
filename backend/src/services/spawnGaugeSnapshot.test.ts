import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findMany: vi.fn(), groupBy: vi.fn() },
  instance: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./spawnBudget', async () => {
  const { DEFAULT_SPAWN_LIMITS } = await import('./spawnLimits');
  return {
    BOX_SELECT: {},
    spawnLimitsFor: vi.fn(async () => DEFAULT_SPAWN_LIMITS),
    readings: vi.fn(async (rows: Array<{ id: string; name: string; memUsedPct: number; diskUsedPct: number; load1: number; hostSampledAt: Date }>) =>
      rows.map(r => ({ ...r, sampledAt: r.hostSampledAt, cores: 2, liveAgents: 3 }))),
  };
});

import { buildGaugeSnapshot } from './spawnGaugeSnapshot';

const now = Date.parse('2026-10-18T12:00:00Z');

describe('buildGaugeSnapshot', () => {
  beforeEach(() => {
    prisma.agentSpawn.findMany.mockResolvedValue([
      { userId: 'u1', childInstanceId: 'b1', state: 'running', reportedAt: null },
      { userId: 'u1', childInstanceId: 'b1', state: 'done', reportedAt: new Date(now - 2 * 3600_000) },
      { userId: 'u2', childInstanceId: 'b2', state: 'done', reportedAt: new Date(now - 60_000) },
    ]);
    prisma.agentSpawn.groupBy.mockResolvedValue([{ userId: 'u1', _count: { _all: 5 } }]);
    prisma.instance.findMany.mockResolvedValue([
      { id: 'b1', name: 'box-1', kind: 'ec2', userId: 'u1', memUsedPct: 91, diskUsedPct: 40, load1: 1, hostSampledAt: new Date(now - 60_000) },
      { id: 'w1', name: 'pool', kind: 'ec2', userId: null, memUsedPct: 10, diskUsedPct: 10, load1: 0, hostSampledAt: new Date(now - 60_000) },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', googleEmail: 'a@x', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' },
      { id: 'u2', googleEmail: 'b@x', displayName: 'B', unixUsername: 'b', defaultAgentProvider: 'claude' },
    ]);
  });

  it('counts running per user and box, and finished ones only after they sat idle', async () => {
    const s = await buildGaugeSnapshot(now);
    expect(s.running).toEqual([{ userId: 'u1', instanceId: 'b1', value: 2 }, { userId: 'u2', instanceId: 'b2', value: 1 }]);
    expect(s.finishedRunning).toEqual([{ userId: 'u1', value: 1 }]);
  });

  it('reports per-user limit use against the served limits', async () => {
    const s = await buildGaugeSnapshot(now);
    expect(s.limits).toContainEqual({ userId: 'u1', limit: 'hour', used: 5, value: 20 });
    expect(s.limits).toContainEqual({ userId: 'u1', limit: 'running', used: 2, value: 8 });
    expect(s.limits).toContainEqual({ userId: 'u2', limit: 'hour', used: 0, value: 20 });
  });

  it('reads boxes as utilizations, flags a hot one, and leaves unclaimed pool boxes out', async () => {
    const s = await buildGaugeSnapshot(now);
    expect(s.boxes).toEqual([{
      instanceId: 'b1', ownerId: 'u1', memoryUtilization: 0.91, diskUtilization: 0.4, loadPerCore: 0.5,
      liveAgents: 3, capacity: null, hot: true,
    }]);
  });
});
