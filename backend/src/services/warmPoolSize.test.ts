import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from './featureFlags';

const ld = vi.hoisted(() => ({ value: undefined as number | undefined, calls: [] as { key: string; context: FlagContext; fallback: number }[] }));

vi.mock('./featureFlags', () => ({
  numberVariationForContext: vi.fn(async (key: string, context: FlagContext, fallback: number) => {
    ld.calls.push({ key, context, fallback });
    return ld.value ?? fallback;
  }),
}));

const {
  clampWarmPoolSize, warmPoolSizeOverride, warmPoolTargetSize,
  WARM_POOL_SIZE_FALLBACK, WARM_POOL_SIZE_FLAG, WARM_POOL_SIZE_MAX,
} = await import('./warmPoolSize');
const { POOL_FLAG_CONTEXT } = await import('./boxHibernationFlag');
const { FLAG_REGISTRY } = await import('../flags');

beforeEach(() => {
  ld.value = undefined;
  ld.calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {}).mockClear();
});

describe('clampWarmPoolSize', () => {
  it('keeps a value inside 0..20', () => {
    for (const n of [0, 1, 5, 20]) expect(clampWarmPoolSize(n)).toBe(n);
  });

  it('clamps out-of-range values to the nearest end', () => {
    expect(clampWarmPoolSize(-3)).toBe(0);
    expect(clampWarmPoolSize(21)).toBe(WARM_POOL_SIZE_MAX);
    expect(clampWarmPoolSize(1e9)).toBe(20);
    expect(clampWarmPoolSize(Infinity)).toBe(WARM_POOL_SIZE_FALLBACK);
  });

  it('rounds a fraction down rather than launching a box for it', () => {
    expect(clampWarmPoolSize(2.9)).toBe(2);
    expect(clampWarmPoolSize(0.5)).toBe(0);
  });

  it('falls back to 5 for anything that is not a number', () => {
    for (const raw of [NaN, '3', null, undefined, true, {}]) expect(clampWarmPoolSize(raw)).toBe(5);
  });
});

describe('warmPoolSizeOverride', () => {
  it('is absent when the variable is unset', () => {
    expect(warmPoolSizeOverride({ AUTH_MODE: 'local' })).toEqual({ size: null });
    expect(warmPoolSizeOverride({})).toEqual({ size: null });
  });

  it('is honored under AUTH_MODE=local, clamped', () => {
    expect(warmPoolSizeOverride({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: ' 2 ' })).toEqual({ size: 2 });
    expect(warmPoolSizeOverride({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: '0' })).toEqual({ size: 0 });
    expect(warmPoolSizeOverride({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: '99' })).toEqual({ size: 20 });
  });

  it('is ignored, with a reason, on any other auth mode, so a deployment cannot pin the size', () => {
    for (const mode of [undefined, 'google', 'okta', 'oidc']) {
      const got = warmPoolSizeOverride({ AUTH_MODE: mode, WARM_POOL_TARGET_SIZE: '1' });
      expect(got.size).toBeNull();
      expect(got.ignored).toMatch(/AUTH_MODE=local/);
    }
  });

  it('is ignored when it is not a whole number', () => {
    for (const raw of ['two', '2.5', '-1', '2 boxes', '1e3']) {
      const got = warmPoolSizeOverride({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: raw });
      expect(got.size, raw).toBeNull();
      expect(got.ignored, raw).toMatch(/whole number/);
    }
  });
});

describe('warmPoolTargetSize', () => {
  it('reads box-warm-pool-size for the fixed pool context, with the fallback of 5', async () => {
    ld.value = 3;
    expect(await warmPoolTargetSize({})).toBe(3);
    expect(ld.calls).toEqual([{ key: 'box-warm-pool-size', context: POOL_FLAG_CONTEXT, fallback: 5 }]);
  });

  it('is 5 when the flag source has no answer', async () => {
    expect(await warmPoolTargetSize({})).toBe(5);
  });

  it('clamps what the flag serves', async () => {
    ld.value = 50;
    expect(await warmPoolTargetSize({})).toBe(20);
    ld.value = -1;
    expect(await warmPoolTargetSize({})).toBe(0);
  });

  it('logs an out-of-range value once, not on every tick', async () => {
    ld.value = 40;
    await warmPoolTargetSize({});
    await warmPoolTargetSize({});
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('takes the local override without asking the flag source', async () => {
    ld.value = 7;
    expect(await warmPoolTargetSize({ AUTH_MODE: 'local', WARM_POOL_TARGET_SIZE: '0' })).toBe(0);
    expect(ld.calls).toEqual([]);
  });

  it('ignores the variable outside AUTH_MODE=local and reads the flag', async () => {
    ld.value = 4;
    expect(await warmPoolTargetSize({ AUTH_MODE: 'google', WARM_POOL_TARGET_SIZE: '1' })).toBe(4);
  });

  it('matches its registry entry', () => {
    expect(FLAG_REGISTRY[WARM_POOL_SIZE_FLAG]).toMatchObject({ kind: 'number', fallback: WARM_POOL_SIZE_FALLBACK, server: ['pool'] });
  });
});
