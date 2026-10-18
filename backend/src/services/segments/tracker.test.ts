import { beforeEach, describe, expect, it, vi } from 'vitest';

const upserts: Array<{ userId: string; date: string; segment: string }> = [];

vi.mock('../../db', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    userSegmentDaily: {
      upsert: vi.fn(async (args: { create: { userId: string; date: string; segment: string } }) => {
        upserts.push(args.create);
        return args.create;
      }),
      findFirst: vi.fn(async () => null),
      groupBy: vi.fn(),
    },
  },
}));

import { prisma } from '../../db';
import { rebuildSegments, segmentTrackerStatus } from './tracker';

const rawUsers = [
  { id: 'u-early', createdAt: new Date('2026-10-01T00:00:00Z') },
  { id: 'u-quiet', createdAt: new Date('2026-09-20T00:00:00Z') },
];

describe('rebuildSegments', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    upserts.length = 0;
    vi.mocked(prisma.user.findMany).mockResolvedValue(rawUsers as never);
  });

  it('banks a New window for a fresh join and Dormant later when quiet', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    const r = await rebuildSegments();
    expect(r.users).toBe(2);
    const early = upserts.filter(u => u.userId === 'u-early');
    expect(early[0]).toMatchObject({ date: '2026-10-01', segment: 'New' });
    expect(early[3]).toMatchObject({ date: '2026-10-04', segment: 'Dormant' });
    const quiet = upserts.filter(u => u.userId === 'u-quiet');
    expect(quiet.slice(0, 3).every(u => u.segment === 'New')).toBe(true); // the New gate does not require activity
    expect(quiet.slice(3).every(u => u.segment === 'Dormant')).toBe(true);
  });

  it('activity signals turn an account Active without creations', async () => {
    // u-early: active on Oct 6, 8, 10 (any signal type) → Active on 10-10+
    vi.mocked(prisma.user.findMany as never).mockResolvedValue(rawUsers as never);
    const signalRows = [
      { user_id: 'u-early', day: '2026-10-06', agent_ms: 0, human_ms: 100, token_rows: 0, visited: false },
      { user_id: 'u-early', day: '2026-10-08', agent_ms: 0, human_ms: 0, token_rows: 2, visited: false },
      { user_id: 'u-early', day: '2026-10-10', agent_ms: 400_000, human_ms: 0, token_rows: 0, visited: false },
    ];
    vi.mocked(prisma.$queryRaw).mockImplementation((query: unknown) => {
      const q = String(query);
      if (q.includes('work_time_entries')) return Promise.resolve(signalRows) as never;
      return Promise.resolve([]) as never; // creations empty
    });
    await rebuildSegments();
    const early = upserts.filter(u => u.userId === 'u-early');
    expect(early.find(u => u.date === '2026-10-10')?.segment).toBe('Active');
    expect(early.find(u => u.date === '2026-10-03')?.segment).toBe('New'); // the New gate is tenure-only
    expect(early.find(u => u.date === '2026-10-07')?.segment).toBe('Passive'); // Oct-6 signal is inside the 7d window
  });

  it('passive and Power honor the creation volume', async () => {
    const signalRows = [{ user_id: 'u-early', day: '2026-10-10', agent_ms: 400_000, human_ms: 0, token_rows: 0, visited: false }];
    vi.mocked(prisma.$queryRaw).mockImplementation((query: unknown) => {
      const q = String(query);
      if (q.includes('work_time_entries')) return Promise.resolve(signalRows) as never;
      if (q.includes('instances')) {
        return Promise.resolve([{ user_id: 'u-early', day: '2026-10-10', boxes: 2, projects: 0, workstreams: 0 }]) as never;
      }
      return Promise.resolve([]) as never;
    });
    await rebuildSegments();
    const early = upserts.filter(u => u.userId === 'u-early');
    // only 1 active day: Passive (the Power creation test needs the cadence too)
    expect(early.find(u => u.date === '2026-10-10')?.segment).toBe('Passive');
  });

  it('status reflects a completed run', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    await rebuildSegments();
    expect(segmentTrackerStatus().lastRunAt).not.toBeNull();
    expect(segmentTrackerStatus().state).toBe('idle');
  });
});
