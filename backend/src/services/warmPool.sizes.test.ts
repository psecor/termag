import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from './featureFlags';

/**
 * The reconciler holding each size apart (services/warmPoolSizes.ts): with
 * box-default-size on for the pool and box-warm-pool-sizes serving an object,
 * its count of each size (their sum the total, box-warm-pool-size not a cap,
 * within the code's total ceiling of 20), each size on its own spec hash and launched at
 * its own size. With box-warm-pool-sizes unset or malformed, the single-size
 * pool of box-warm-pool-size; with sizes off, one pool of the configured type. The pool's rows live in memory, and the insert's serializable
 * re-count reads them, so the shared in-flight cap and the per-size supply
 * check are what the test exercises.
 */

const flag = vi.hoisted(() => ({
  defaultSize: '',
  poolSize: 5,
  poolSizes: null as unknown,
  contexts: [] as Array<{ key: string; ctx: FlagContext }>,
}));

vi.mock('./featureFlags', () => ({
  boolVariationForContext: vi.fn(async (_key: string, _ctx: FlagContext, fallback: boolean) => fallback),
  numberVariationForContext: vi.fn(async (key: string, _ctx: FlagContext, fallback: number) => (key === 'box-warm-pool-size' ? flag.poolSize : fallback)),
  stringVariationForContext: vi.fn(async (key: string, ctx: FlagContext, fallback: string) => {
    if (key !== 'box-default-size') return fallback;
    flag.contexts.push({ key, ctx });
    return flag.defaultSize;
  }),
  jsonVariationForContext: vi.fn(async (key: string, ctx: FlagContext, fallback: unknown) => {
    if (key !== 'box-warm-pool-sizes') return fallback;
    flag.contexts.push({ key, ctx });
    return flag.poolSizes;
  }),
}));

const ami = vi.hoisted(() => ({ imageId: 'ami-1', rootDeviceName: '/dev/sda1', rootVolumeGb: 120, hibernationSupported: false, termagSha: null, createdAt: null }));
const provisionPoolBox = vi.hoisted(() => vi.fn(async () => true));
const terminateBox = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ec2', () => ({ EC2Client: class {} }));
vi.mock('./boxProvisioner', () => ({
  awsClientConfig: () => ({}),
  buildWarmCloudInit: () => '#!/bin/bash\n',
  discoverLatestAmi: vi.fn(async () => ami),
  getBoxConfig: () => ({ instanceType: 'm9g.2xlarge', agentWsUrl: 'wss://orchestrator/termag/ws/agent' }),
  provisionPoolBox,
  terminateBox,
}));
vi.mock('./warmPoolClaim', () => ({ resendStalledClaims: vi.fn(async () => {}) }));
vi.mock('./claimUpdate', () => ({ expireStaleClaimUpdates: vi.fn(async () => {}) }));

type Row = {
  id: string; status: string; userId: string | null; poolSpecHash: string | null; size: string | null;
  createdAt: Date; warmedAt: Date | null; lastConnectedAt: Date | null; agentDisconnectedAt: Date | null; provisioningError: string | null;
};
const db = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));

type Where = { id?: string; userId?: null; status?: string | { in: string[] }; poolSpecHash?: string; size?: string | null };
function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if ('userId' in where && row.userId !== where.userId) return false;
  if ('size' in where && row.size !== where.size) return false;
  if (where.poolSpecHash !== undefined && row.poolSpecHash !== where.poolSpecHash) return false;
  if (typeof where.status === 'string') return row.status === where.status;
  if (where.status) return where.status.in.includes(row.status);
  return true;
}

vi.mock('../db', () => {
  const count = vi.fn(async ({ where }: { where: Where }) => db.rows.filter((r) => matches(r, where)).length);
  const tx = {
    instance: {
      count,
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        const row = {
          id: `p${++db.seq}`, userId: null, poolSpecHash: null, size: null, createdAt: new Date(),
          warmedAt: null, lastConnectedAt: null, agentDisconnectedAt: null, provisioningError: null, status: 'warming',
          ...data,
        } as Row;
        db.rows.push(row);
        return { ...row };
      }),
    },
    agentToken: { create: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      instance: {
        findMany: vi.fn(async () => db.rows.filter((r) => r.userId === null && ['warming', 'warm'].includes(r.status)).map((r) => ({ ...r }))),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => db.rows.find((r) => r.id === where.id) ?? null),
        count,
        updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
          const hit = db.rows.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        }),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});

const { currentPoolSpec, poolSpecHash, poolSpecHashOrNull, reconcileWarmPool, resetPoolSpecCache } = await import('./warmPool');
const { POOL_FLAG_CONTEXT } = await import('./poolLdContext');

const HOUR = 3_600_000;

async function hashOf(size: 'small' | 'medium' | 'large' | null): Promise<string> {
  return (await currentPoolSpec(size)).hash;
}

async function warmBox(id: string, size: 'small' | 'medium' | 'large' | null, ageMs = HOUR): Promise<Row> {
  const createdAt = new Date(Date.now() - ageMs);
  return {
    id, status: 'warm', userId: null, poolSpecHash: await hashOf(size), size, createdAt,
    warmedAt: createdAt, lastConnectedAt: createdAt, agentDisconnectedAt: null, provisioningError: null,
  };
}

/** What the pool holds, warm or warming, by size. */
function bySize(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.rows.filter((r) => r.userId === null && ['warming', 'warm'].includes(r.status))) {
    const k = r.size ?? 'configured';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Every warming row warms, as the agent's on-warm would. */
function warmAll(): void {
  for (const r of db.rows.filter((r) => r.status === 'warming')) {
    Object.assign(r, { status: 'warm', warmedAt: new Date(), lastConnectedAt: new Date() });
  }
}

beforeEach(() => {
  flag.defaultSize = 'medium';
  flag.poolSize = 5;
  flag.poolSizes = null;
  flag.contexts = [];
  db.rows = [];
  db.seq = 0;
  vi.clearAllMocks();
  resetPoolSpecCache();
  vi.stubEnv('WARM_POOL_MAX_INFLIGHT', '10');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the warm pool with box-warm-pool-sizes set', () => {
  beforeEach(() => { flag.poolSizes = { small: 2, medium: 2, large: 1 }; });

  it('reads box-warm-pool-sizes and box-default-size for the fixed pool context only', async () => {
    await reconcileWarmPool();
    expect(flag.contexts.map((c) => c.key)).toContain('box-warm-pool-sizes');
    expect(new Set(flag.contexts.map((c) => c.ctx))).toEqual(new Set([POOL_FLAG_CONTEXT]));
  });

  it('fills each size to its count, small 2, medium 2, large 1, each launched at its size on its own hash', async () => {
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });

    const hashes = { small: await hashOf('small'), medium: await hashOf('medium'), large: await hashOf('large') };
    expect(new Set(Object.values(hashes)).size).toBe(3);
    for (const row of db.rows) expect(row.poolSpecHash).toBe(hashes[row.size as keyof typeof hashes]);
    for (const [args] of provisionPoolBox.mock.calls as unknown as Array<[{ size: keyof typeof hashes; poolSpecHash: string }]>) {
      expect(args.poolSpecHash).toBe(hashes[args.size]);
    }
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[POOL\] tick size=large spec=\w{12} target=1 warm=0 warming=0 launch=1/));
  });

  it('keeps each count as boxes warm, and launches nothing more once every size is full', async () => {
    await reconcileWarmPool();
    warmAll();
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });
    expect(provisionPoolBox).toHaveBeenCalledTimes(5);
    expect(terminateBox).not.toHaveBeenCalled();
  });

  it('refills only the size a claim took from', async () => {
    db.rows = [await warmBox('s1', 'small'), await warmBox('s2', 'small'), await warmBox('m1', 'medium'), await warmBox('m2', 'medium'), await warmBox('l1', 'large')];
    Object.assign(db.rows[2], { userId: 'u1', status: 'ready' });

    await reconcileWarmPool();

    expect(provisionPoolBox).toHaveBeenCalledOnce();
    expect(provisionPoolBox).toHaveBeenCalledWith(expect.objectContaining({ size: 'medium', poolSpecHash: await hashOf('medium') }));
  });

  it('follows the flag\'s counts', async () => {
    flag.poolSizes = { small: 4, medium: 1, large: 0 };
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 4, medium: 1 });
  });

  it('plans 4/2/2 with box-warm-pool-size at 5: the counts are the pool, and their sum is the total', async () => {
    flag.poolSizes = { small: 4, medium: 2, large: 2 };
    flag.poolSize = 5;
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 4, medium: 2, large: 2 });
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[POOL\] tick size=small spec=\w{12} target=4 /));
  });

  it('gives a size the value leaves out its code default, small 4, medium 2, large 2', async () => {
    flag.poolSizes = {};
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 4, medium: 2, large: 2 });
  });

  it('holds fewer than box-warm-pool-size when the counts say so', async () => {
    flag.poolSizes = { small: 1, medium: 0, large: 0 };
    flag.poolSize = 20;
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 1 });
  });

  it('clamps oversized counts to 20 in all, smallest first, with no limit per size, and logs the clamp', async () => {
    flag.poolSizes = { small: 15, medium: 15, large: 15 };
    vi.stubEnv('WARM_POOL_MAX_INFLIGHT', '50');
    await reconcileWarmPool();
    warmAll();
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 15, medium: 5 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('clamped to small=15 medium=5 large=0'));
  });

  it('shares the in-flight cap across sizes, so a refill never boots more than WARM_POOL_MAX_INFLIGHT at once', async () => {
    vi.stubEnv('WARM_POOL_MAX_INFLIGHT', '2');
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2 });
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2 });
    warmAll();
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2, medium: 2 });
    warmAll();
    await reconcileWarmPool();
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });
  });

  it('retires a size whose count drops to 0, and only that size', async () => {
    db.rows = [await warmBox('s1', 'small'), await warmBox('s2', 'small'), await warmBox('m1', 'medium'), await warmBox('m2', 'medium'), await warmBox('l1', 'large')];
    flag.poolSizes = { small: 2, medium: 2, large: 0 };

    await reconcileWarmPool();

    expect(terminateBox.mock.calls.map(([i]) => i.id)).toEqual(['l1']);
    expect(console.log).toHaveBeenCalledWith('[POOL] retire l1: drain');
    expect(provisionPoolBox).not.toHaveBeenCalled();
  });

  it('drains every size when every count is 0', async () => {
    db.rows = [await warmBox('s1', 'small'), await warmBox('m1', 'medium')];
    flag.poolSizes = { small: 0, medium: 0, large: 0 };
    await reconcileWarmPool();
    expect(terminateBox.mock.calls.map(([i]) => i.id).sort()).toEqual(['m1', 's1']);
  });

  it('does not drain on box-warm-pool-size 0, which only sizes the single-size pool', async () => {
    db.rows = [await warmBox('s1', 'small')];
    flag.poolSize = 0;
    await reconcileWarmPool();
    expect(terminateBox).not.toHaveBeenCalled();
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });
  });

  it('drains the configured-type boxes left from before sizes at once, since no sized claim can take one', async () => {
    flag.defaultSize = '';
    db.rows = [await warmBox('c1', null), await warmBox('c2', null)];
    flag.defaultSize = 'medium';
    resetPoolSpecCache();

    await reconcileWarmPool();

    expect(terminateBox.mock.calls.map(([i]) => i.id).sort()).toEqual(['c1', 'c2']);
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });
  });

  it('keeps the medium boxes a one-size medium pool already holds, since their hash is the same', async () => {
    db.rows = [await warmBox('m1', 'medium'), await warmBox('m2', 'medium'), await warmBox('m3', 'medium', 2 * HOUR)];
    await reconcileWarmPool();
    expect(terminateBox.mock.calls.map(([i]) => i.id)).toEqual(['m3']);
    expect(bySize()).toEqual({ small: 2, medium: 2, large: 1 });
  });

});

describe('the warm pool with box-warm-pool-sizes unset or malformed', () => {
  it('is the single-size pool when unset: box-warm-pool-size boxes of the pool\'s box-default-size', async () => {
    flag.poolSize = 3;
    await reconcileWarmPool();
    expect(bySize()).toEqual({ medium: 3 });
    expect(db.rows.every((r) => r.size === 'medium')).toBe(true);
  });

  it('retires the other sizes when the flag goes unset', async () => {
    flag.poolSizes = { small: 1, medium: 1, large: 1 };
    db.rows = [await warmBox('s1', 'small'), await warmBox('m1', 'medium'), await warmBox('l1', 'large')];
    flag.poolSizes = null;
    await reconcileWarmPool();
    expect(terminateBox.mock.calls.map(([i]) => i.id).sort()).toEqual(['l1', 's1']);
    expect(bySize()).toEqual({ medium: 5 });
  });

  it.each([
    { what: 'a bad count', value: { small: 'two', medium: 3 } },
    { what: 'not an object', value: [4, 2, 2] },
  ])('falls back to the single-size pool on $what, with a warning', async ({ value }) => {
    flag.poolSizes = value;
    await reconcileWarmPool();
    expect(bySize()).toEqual({ medium: 5 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('holding the single-size pool'));
  });
});

describe('the warm pool with sizes off', () => {
  beforeEach(() => { flag.defaultSize = ''; });

  it('holds box-warm-pool-size boxes of the configured type, on the hash it had before sizes', async () => {
    await reconcileWarmPool();
    expect(bySize()).toEqual({ configured: 5 });
    expect(await hashOf(null)).toBe(poolSpecHash({ amiId: 'ami-1', instanceType: 'm9g.2xlarge', warmCloudInit: '#!/bin/bash\n' }));
    expect(db.rows.every((r) => r.poolSpecHash === db.rows[0].poolSpecHash && r.size === null)).toBe(true);
  });

  it('never reads box-warm-pool-sizes', async () => {
    flag.poolSizes = { small: 1 };
    await reconcileWarmPool();
    expect(flag.contexts.map((c) => c.key)).not.toContain('box-warm-pool-sizes');
  });

  it('drains sized boxes left from when sizes were on', async () => {
    flag.defaultSize = 'small';
    db.rows = [await warmBox('s1', 'small')];
    flag.defaultSize = '';
    await reconcileWarmPool();
    expect(terminateBox.mock.calls.map(([i]) => i.id)).toEqual(['s1']);
  });
});

describe('poolSpecHashOrNull for a claim', () => {
  beforeEach(() => { flag.poolSizes = { small: 2, medium: 2, large: 1 }; });

  it('answers the hash of the size asked for, when a box of it is warm', async () => {
    db.rows = [await warmBox('s1', 'small')];
    expect(await poolSpecHashOrNull('small')).toBe(await hashOf('small'));
  });

  it('answers null for a size with no warm box, though another size has one', async () => {
    db.rows = [await warmBox('s1', 'small')];
    expect(await poolSpecHashOrNull('large')).toBeNull();
  });

  it('answers null for a size the pool holds none of, without counting', async () => {
    flag.poolSizes = { large: 0 };
    db.rows = [await warmBox('l1', 'large')];
    expect(await poolSpecHashOrNull('large')).toBeNull();
  });

  it('answers null for no size while sizes are on', async () => {
    db.rows = [await warmBox('c1', null)];
    expect(await poolSpecHashOrNull(null)).toBeNull();
  });
});
