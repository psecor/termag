import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from './featureFlags';

/**
 * box-warm-pool-sizes: a served object's counts are the pool (sum, not
 * box-warm-pool-size), within the code's total ceiling; unset or malformed is the
 * single-size pool of box-warm-pool-size. Plus the per-size target a claim
 * asks about, and the hit-or-miss record a claim leaves for tuning the counts.
 */

const flag = vi.hoisted(() => ({ defaultSize: 'medium', poolSize: 5, poolSizes: null as unknown, reads: [] as string[] }));
vi.mock('./featureFlags', () => ({
  numberVariationForContext: vi.fn(async (key: string, _ctx: FlagContext, fallback: number) => { flag.reads.push(key); return flag.poolSize ?? fallback; }),
  stringVariationForContext: vi.fn(async (key: string, _ctx: FlagContext, fallback: string) => (key === 'box-default-size' ? flag.defaultSize : fallback)),
  jsonVariationForContext: vi.fn(async (key: string) => { flag.reads.push(key); return flag.poolSizes; }),
}));
const recordProductEvent = vi.hoisted(() => vi.fn());
vi.mock('./productEvents', () => ({ recordProductEvent }));

const {
  DEFAULT_WARM_POOL_SIZES, WARM_POOL_TOTAL_CEILING,
  ceilPoolTargets, parseWarmPoolSizes, recordPoolClaim, warmPoolTargetFor, warmPoolTargets,
} = await import('./warmPoolSizes');

beforeEach(() => {
  flag.defaultSize = 'medium';
  flag.poolSize = 5;
  flag.poolSizes = null;
  flag.reads = [];
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const targetsOf = (ts: Array<{ size: string | null; target: number }>) => Object.fromEntries(ts.map(t => [t.size ?? 'configured', t.target]));

describe('parseWarmPoolSizes', () => {
  it('is null (the single-size pool) when the flag serves nothing', () => {
    expect(parseWarmPoolSizes(null)).toBeNull();
    expect(parseWarmPoolSizes(undefined)).toBeNull();
  });

  it('takes each count it is given, and small 4, medium 2, large 2 for a size it leaves out', () => {
    expect(DEFAULT_WARM_POOL_SIZES).toEqual({ small: 4, medium: 2, large: 2 });
    expect(parseWarmPoolSizes({ small: 0, large: 3 })).toEqual({ small: 0, medium: 2, large: 3 });
    expect(parseWarmPoolSizes({})).toEqual({ small: 4, medium: 2, large: 2 });
  });

  it.each([-1, 1.5, '4', null])('is null, the single-size pool, when a count is %j, and warns once per value', (n) => {
    const bad = { small: 2, medium: n };
    expect(parseWarmPoolSizes(bad)).toBeNull();
    parseWarmPoolSizes(bad);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('medium not a whole number of 0 or more; holding the single-size pool'));
  });

  it.each([5, 'small', [1, 2], true])('is null, the single-size pool, for %j, which is not an object of sizes', (raw) => {
    expect(parseWarmPoolSizes(raw)).toBeNull();
  });

  it('ignores a key that is not a size, with a warning, and keeps the rest', () => {
    expect(parseWarmPoolSizes({ small: 1, xl: 9 })).toEqual({ small: 1, medium: 2, large: 2 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring xl'));
  });
});

describe('ceilPoolTargets', () => {
  it('leaves counts within the ceilings alone', () => {
    expect(ceilPoolTargets({ small: 4, medium: 2, large: 2 })).toEqual({
      targets: [{ size: 'small', target: 4 }, { size: 'medium', target: 2 }, { size: 'large', target: 2 }],
      clamped: false,
    });
  });

  it('has no limit per size: one size may take the whole total', () => {
    const { targets, clamped } = ceilPoolTargets({ small: 0, medium: 0, large: 20 });
    expect(targetsOf(targets)).toEqual({ small: 0, medium: 0, large: 20 });
    expect(clamped).toBe(false);
  });

  it(`clamps the sum to ${20}, filling smallest first so the excess comes off the largest`, () => {
    expect(WARM_POOL_TOTAL_CEILING).toBe(20);
    expect(targetsOf(ceilPoolTargets({ small: 15, medium: 15, large: 15 }).targets)).toEqual({ small: 15, medium: 5, large: 0 });
    expect(targetsOf(ceilPoolTargets({ small: 50, medium: 1, large: 0 }).targets)).toEqual({ small: 20, medium: 0, large: 0 });
    expect(targetsOf(ceilPoolTargets({ small: 10, medium: 8, large: 10 }).targets)).toEqual({ small: 10, medium: 8, large: 2 });
    expect(ceilPoolTargets({ small: 15, medium: 15, large: 15 }).clamped).toBe(true);
  });

  it('never sums to more than the total ceiling', () => {
    for (let n = 0; n <= 30; n++) {
      const { targets } = ceilPoolTargets({ small: n, medium: n, large: n });
      expect(targets.reduce((sum, t) => sum + t.target, 0)).toBe(Math.min(20, 3 * n));
      expect(targets[0].target).toBe(Math.min(n, 20));
    }
  });
});

describe('warmPoolTargets', () => {
  it('is the served counts, their sum the total, with box-warm-pool-size ignored as a cap', async () => {
    flag.poolSizes = { small: 4, medium: 2, large: 2 };
    flag.poolSize = 5;
    expect(targetsOf(await warmPoolTargets({}))).toEqual({ small: 4, medium: 2, large: 2 });
    expect(flag.reads).not.toContain('box-warm-pool-size');
  });

  it('holds more than box-warm-pool-size, and also fewer, as the counts say', async () => {
    flag.poolSize = 1;
    flag.poolSizes = { small: 6, medium: 3, large: 3 };
    expect(targetsOf(await warmPoolTargets({}))).toEqual({ small: 6, medium: 3, large: 3 });
    flag.poolSize = 20;
    flag.poolSizes = { small: 1, medium: 0, large: 0 };
    expect(targetsOf(await warmPoolTargets({}))).toEqual({ small: 1, medium: 0, large: 0 });
  });

  it('drains with every count at 0, whatever box-warm-pool-size says', async () => {
    flag.poolSizes = { small: 0, medium: 0, large: 0 };
    expect((await warmPoolTargets({})).every(t => t.target === 0)).toBe(true);
  });

  it('clamps an oversized value to the total ceiling, smallest first, and logs it once', async () => {
    flag.poolSizes = { small: 15, medium: 15, large: 15 };
    expect(targetsOf(await warmPoolTargets({}))).toEqual({ small: 15, medium: 5, large: 0 });
    await warmPoolTargets({});
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('clamped to small=15 medium=5 large=0 (at most 20 in all, smallest first)'));
  });

  it('is the single-size pool, box-warm-pool-size strong at the pool\'s box-default-size, when the flag is unset', async () => {
    flag.defaultSize = 'large';
    expect(await warmPoolTargets({})).toEqual([{ size: 'large', target: 5 }]);
    flag.poolSize = 3;
    expect(await warmPoolTargets({})).toEqual([{ size: 'large', target: 3 }]);
  });

  it('falls back to the single-size pool on a malformed value', async () => {
    flag.poolSizes = { small: 'four', medium: 2 };
    expect(await warmPoolTargets({})).toEqual([{ size: 'medium', target: 5 }]);
    flag.poolSizes = [4, 2, 2];
    expect(await warmPoolTargets({})).toEqual([{ size: 'medium', target: 5 }]);
  });

  it('is the configured type\'s pool with sizes off, and never reads box-warm-pool-sizes', async () => {
    flag.defaultSize = '';
    flag.poolSizes = { small: 4 };
    expect(await warmPoolTargets({})).toEqual([{ size: null, target: 5 }]);
    expect(flag.reads).not.toContain('box-warm-pool-sizes');
  });

  it('honours the e2e stack\'s WARM_POOL_TARGET_SIZE for the single-size pool', async () => {
    expect(await warmPoolTargets({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: '2' })).toEqual([{ size: 'medium', target: 2 }]);
  });

  it('answers 0 for a size the pool does not hold, and for no size while sizes are on', async () => {
    flag.poolSizes = { large: 0 };
    expect(await warmPoolTargetFor('large', {})).toBe(0);
    expect(await warmPoolTargetFor(null, {})).toBe(0);
    expect(await warmPoolTargetFor('small', {})).toBe(4);
  });
});

describe('recordPoolClaim', () => {
  const user = { id: 'u1', unixUsername: 'alice' };

  it('records a hit by size, as a log line and a box.pool.claim event', () => {
    recordPoolClaim({ user, size: 'small', via: 'add-box', box: 'b1', outcome: 'hit' });
    expect(console.log).toHaveBeenCalledWith('[POOL] claim hit size=small via=add-box user=alice');
    expect(recordProductEvent).toHaveBeenCalledWith('box.pool.claim', { user: 'u1', box: 'b1' }, { size: 'small', outcome: 'hit', reason: null, via: 'add-box' });
  });

  it('records a miss with its reason, and no size as configured', () => {
    recordPoolClaim({ user, size: null, via: 'claude-runner', outcome: 'miss', reason: 'size-not-pooled' });
    expect(console.log).toHaveBeenCalledWith('[POOL] claim miss size=configured via=claude-runner user=alice reason=size-not-pooled');
    expect(recordProductEvent).toHaveBeenCalledWith('box.pool.claim', { user: 'u1', box: null }, { size: 'configured', outcome: 'miss', reason: 'size-not-pooled', via: 'claude-runner' });
  });
});
