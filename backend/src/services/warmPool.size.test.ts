import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reconciler against box-warm-pool-size: lowering the flag retires the
 * pool's surplus on the next tick, and the retirement is guarded so it can
 * never reach a box a claim has handed out in the meantime.
 */

const size = vi.hoisted(() => ({ value: 5 }));

vi.mock('./featureFlags', () => ({
  boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
  numberVariationForContext: vi.fn(async () => size.value),
}));

const terminateBox = vi.hoisted(() => vi.fn());
const provisionPoolBox = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@aws-sdk/client-ec2', () => ({ EC2Client: class {} }));
vi.mock('./boxProvisioner', () => ({
  awsClientConfig: () => ({}),
  buildWarmCloudInit: () => '#!/bin/bash\n',
  discoverLatestAmi: vi.fn(async () => ({ imageId: 'ami-1', hibernationSupported: false })),
  getBoxConfig: () => ({ instanceType: 'm9g.2xlarge', agentWsUrl: 'wss://orchestrator/termag/ws/agent' }),
  provisionPoolBox,
  terminateBox,
}));
vi.mock('./warmPoolClaim', () => ({ resendStalledClaims: vi.fn(async () => {}) }));

type Row = { id: string; status: string; userId: string | null; poolSpecHash: string; createdAt: Date; warmedAt: Date | null; lastConnectedAt: Date | null; agentDisconnectedAt: Date | null; provisioningError: null };
const db = vi.hoisted(() => ({ rows: [] as Row[] }));

// updateMany applies its where clause to the in-memory rows, so a guard that
// stops matching (a claim landed) is exactly what the test exercises.
function matches(row: Row, where: { id: string; userId?: null; status?: string | { in: string[] } }): boolean {
  if (row.id !== where.id) return false;
  if ('userId' in where && row.userId !== where.userId) return false;
  if (typeof where.status === 'string') return row.status === where.status;
  if (where.status) return where.status.in.includes(row.status);
  return true;
}

vi.mock('../db', () => ({
  prisma: {
    instance: {
      findMany: vi.fn(async () => db.rows.filter((r) => r.userId === null && ['warming', 'warm'].includes(r.status)).map((r) => ({ ...r }))),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => db.rows.find((r) => r.id === where.id) ?? null),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async ({ where, data }: { where: Parameters<typeof matches>[1]; data: Partial<Row> }) => {
        const hit = db.rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    $transaction: vi.fn(async () => null),
  },
}));

const { currentPoolSpecHash, reconcileWarmPool, resetPoolSpecCache } = await import('./warmPool');
const { prisma } = await import('../db');

const HOUR = 3_600_000;
let hash: string;

function poolBox(id: string, status: 'warm' | 'warming', ageMs: number): Row {
  const createdAt = new Date(Date.now() - ageMs);
  return {
    id, status, userId: null, poolSpecHash: hash, createdAt,
    warmedAt: status === 'warm' ? createdAt : null,
    lastConnectedAt: createdAt, agentDisconnectedAt: null, provisioningError: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  resetPoolSpecCache();
  hash = await currentPoolSpecHash();
  size.value = 5;
  db.rows = [];
});

describe('lowering box-warm-pool-size', () => {
  it('retires the oldest surplus warm boxes, guarded on no owner and a pool status', async () => {
    db.rows = [poolBox('a', 'warm', 4 * HOUR), poolBox('b', 'warm', 3 * HOUR), poolBox('c', 'warm', 2 * HOUR), poolBox('d', 'warm', HOUR)];
    size.value = 2;

    await reconcileWarmPool();

    expect(vi.mocked(prisma.instance.updateMany).mock.calls.map(([args]) => args.where)).toEqual([
      { id: 'a', userId: null, status: { in: ['warming', 'warm'] } },
      { id: 'b', userId: null, status: { in: ['warming', 'warm'] } },
    ]);
    expect(terminateBox.mock.calls.map(([i]) => i.id)).toEqual(['a', 'b']);
    expect(db.rows.filter((r) => r.status === 'warm').map((r) => r.id)).toEqual(['c', 'd']);
    expect(provisionPoolBox).not.toHaveBeenCalled();
  });

  it('drains the whole pool at 0', async () => {
    db.rows = [poolBox('a', 'warm', HOUR), poolBox('g', 'warming', 60_000)];
    size.value = 0;

    await reconcileWarmPool();

    expect(terminateBox.mock.calls.map(([i]) => i.id).sort()).toEqual(['a', 'g']);
  });

  it('never terminates a box a claim took between the read and the retirement', async () => {
    db.rows = [poolBox('a', 'warm', 2 * HOUR), poolBox('b', 'warm', HOUR)];
    size.value = 1;
    // The claim statement commits after the tick read the pool: the row now
    // has an owner and `ready`.
    vi.mocked(prisma.instance.findMany).mockImplementationOnce(async () => {
      const snapshot = db.rows.map((r) => ({ ...r }));
      Object.assign(db.rows[0], { userId: 'u1', status: 'ready' });
      return snapshot as never;
    });

    await reconcileWarmPool();

    expect(terminateBox).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ userId: 'u1', status: 'ready' });
  });

  it('is not fooled by an owned row still marked warm', async () => {
    db.rows = [poolBox('a', 'warm', 2 * HOUR), poolBox('b', 'warm', HOUR)];
    size.value = 1;
    vi.mocked(prisma.instance.findMany).mockImplementationOnce(async () => {
      const snapshot = db.rows.map((r) => ({ ...r }));
      db.rows[0].userId = 'u1';
      return snapshot as never;
    });

    await reconcileWarmPool();

    expect(terminateBox).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('warm');
  });
});
