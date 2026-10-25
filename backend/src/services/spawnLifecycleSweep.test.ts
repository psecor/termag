import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  agentSpawn: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
  user: { findMany: vi.fn() },
  instance: { findMany: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('./spawnBudget', async () => {
  const { DEFAULT_SPAWN_LIMITS } = await import('./spawnLimits');
  return { spawnLimitsFor: vi.fn(async () => DEFAULT_SPAWN_LIMITS) };
});
vi.mock('./status', () => ({ getStatus: vi.fn() }));
vi.mock('./spawnActions', () => ({
  parkSpawn: vi.fn(async () => ({ ok: true })),
  retireSpawn: vi.fn(async () => ({ ok: true })),
  checkoutCheck: vi.fn(),
}));

import { runLifecycleTick } from './spawnLifecycleSweep';
import { boolVariation } from './featureFlags';
import { getStatus } from './status';
import { checkoutCheck, parkSpawn, retireSpawn } from './spawnActions';

const now = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ck1', userId: 'u1', rootSpawnId: 'ck1', relationship: 'delegate', state: 'done', provider: 'claude',
  childProjectId: 'p1', childProjectName: 'proj', childWorkstream: 'ws', childInstanceId: 'box1',
  reportedAt: new Date(now - 60 * MIN), parkedAt: null, retiredAt: null, endedAt: null, keptReason: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([{ id: 'u1', unixUsername: 'me', googleEmail: 'me@x', displayName: 'Me', defaultAgentProvider: 'claude' }]);
  prisma.instance.findMany.mockResolvedValue([{ id: 'box1', name: 'b', kind: 'ec2' }]);
  vi.mocked(getStatus).mockReturnValue({ status: 'idle', updatedAt: new Date(now - 40 * MIN) } as never);
  vi.mocked(boolVariation).mockResolvedValue(true);
});

describe('runLifecycleTick', () => {
  it('pages through the candidates and leaves parked peers out, so they cannot crowd out newer spawns', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, k) => row({ id: `s${String(from + k).padStart(4, '0')}` }));
    prisma.agentSpawn.findMany.mockResolvedValueOnce(page(500, 0)).mockResolvedValueOnce(page(2, 500));
    vi.mocked(boolVariation).mockResolvedValue(false);
    await runLifecycleTick(now);
    const [first, second] = prisma.agentSpawn.findMany.mock.calls.map(c => c[0]);
    expect(first.where.NOT).toEqual({ parkedAt: { not: null }, relationship: { not: 'delegate' } });
    expect(first).toMatchObject({ orderBy: { id: 'asc' }, take: 500 });
    expect(second).toMatchObject({ cursor: { id: 's0499' }, skip: 1 });
  });

  it('does nothing while spawn-lifecycle-enabled is off for the child\'s box', async () => {
    prisma.agentSpawn.findMany.mockResolvedValue([row()]);
    vi.mocked(boolVariation).mockResolvedValue(false);
    expect(await runLifecycleTick(now)).toEqual({ parked: 0, retired: 0 });
    expect(vi.mocked(boolVariation).mock.calls[0][0]).toBe('spawn-lifecycle-enabled');
    expect(parkSpawn).not.toHaveBeenCalled();
  });

  it('parks a delegate done and idle past 30 minutes, and leaves a busy one', async () => {
    prisma.agentSpawn.findMany.mockResolvedValue([row()]);
    expect(await runLifecycleTick(now)).toEqual({ parked: 1, retired: 0 });
    vi.mocked(getStatus).mockReturnValue({ status: 'working', updatedAt: new Date(now) } as never);
    vi.mocked(parkSpawn).mockClear();
    prisma.agentSpawn.findMany.mockResolvedValue([row({ id: 'ck2' })]);
    await runLifecycleTick(now);
    expect(parkSpawn).not.toHaveBeenCalled();
  });

  it('retires a parked delegate whose work landed, and records why one is kept', async () => {
    vi.mocked(getStatus).mockReturnValue({ status: 'not_running', updatedAt: new Date(now - 10 * MIN) } as never);
    prisma.agentSpawn.findMany.mockResolvedValue([row({ id: 'r1', parkedAt: new Date(now - 10 * MIN) })]);
    vi.mocked(checkoutCheck).mockResolvedValue({ ok: true, why: 'nothing_beyond_base' });
    expect(await runLifecycleTick(now)).toEqual({ parked: 0, retired: 1 });
    vi.mocked(checkoutCheck).mockResolvedValue({ ok: false, reason: 'uncommitted changes' });
    prisma.agentSpawn.findMany.mockResolvedValue([row({ id: 'k1', parkedAt: new Date(now - 10 * MIN) })]);
    vi.mocked(retireSpawn).mockClear();
    await runLifecycleTick(now);
    expect(vi.mocked(retireSpawn).mock.calls[0][2]).toEqual({ ok: false, reason: 'uncommitted changes' });
  });

  it('waits out the delay for work that is only pushed, and reads a checkout at most every 10 minutes', async () => {
    vi.mocked(getStatus).mockReturnValue({ status: 'not_running', updatedAt: new Date(now - 60 * MIN) } as never);
    prisma.agentSpawn.findMany.mockResolvedValue([row({ id: 'w1', parkedAt: new Date(now - 60 * MIN) })]);
    vi.mocked(checkoutCheck).mockResolvedValue({ ok: true, why: 'pushed' });
    expect(await runLifecycleTick(now)).toEqual({ parked: 0, retired: 0 });
    await runLifecycleTick(now + 5 * MIN);
    expect(checkoutCheck).toHaveBeenCalledTimes(1);
    await runLifecycleTick(now + 11 * MIN);
    expect(checkoutCheck).toHaveBeenCalledTimes(2);
  });
});
