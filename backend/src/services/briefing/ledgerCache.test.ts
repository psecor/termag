import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEDGER_CACHE_LIVE_TTL_MS, LEDGER_CACHE_TTL_MS, cachedLedger, clearLedgerCache, ledgerCacheKey, peekLedger } from './ledgerCache';
import type { Ledger } from './types';

const fake = (n: number) => ({ generatedAt: String(n) }) as unknown as Ledger;

describe('cachedLedger', () => {
  beforeEach(() => clearLedgerCache());

  it('builds once per key within the TTL, and shares a build in flight', async () => {
    const build = vi.fn(async () => fake(1));
    const onMiss = vi.fn();
    const [a, b] = await Promise.all([cachedLedger('k', build, onMiss, 0), cachedLedger('k', build, onMiss, 10)]);
    expect(a).toBe(b);
    expect(build).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledTimes(1);
    await cachedLedger('k', build, onMiss, LEDGER_CACHE_TTL_MS - 1);
    expect(build).toHaveBeenCalledTimes(1);
    await cachedLedger('k', build, onMiss, LEDGER_CACHE_TTL_MS);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('lets onMiss refuse a build, and never asks it on a hit', async () => {
    await cachedLedger('k', async () => fake(1), undefined, 0);
    const refuse = vi.fn(() => { throw new Error('limited'); });
    await expect(cachedLedger('k', async () => fake(2), refuse, 1)).resolves.toEqual(fake(1));
    expect(refuse).not.toHaveBeenCalled();
    expect(() => cachedLedger('other', async () => fake(2), refuse, 1)).toThrow('limited');
    expect(peekLedger('other', 1)).toBeNull();
  });

  it('forgets a failed build', async () => {
    await expect(cachedLedger('k', async () => { throw new Error('boom'); }, undefined, 0)).rejects.toThrow('boom');
    expect(peekLedger('k', 1)).toBeNull();
    await expect(cachedLedger('k', async () => fake(3), undefined, 2)).resolves.toEqual(fake(3));
  });

  it('keeps an on-demand ledger only a few minutes', async () => {
    expect(LEDGER_CACHE_LIVE_TTL_MS).toBeLessThan(LEDGER_CACHE_TTL_MS);
    await cachedLedger('live', async () => fake(1), undefined, 0, LEDGER_CACHE_LIVE_TTL_MS);
    expect(peekLedger('live', LEDGER_CACHE_LIVE_TTL_MS - 1)).not.toBeNull();
    expect(peekLedger('live', LEDGER_CACHE_LIVE_TTL_MS)).toBeNull();
  });

  it('keys on user, window start, zone and briefing', () => {
    const w = { since: '2026-10-16T15:00:00.000Z', tz: 'UTC' };
    expect(ledgerCacheKey('u1', w, null)).not.toBe(ledgerCacheKey('u1', w, 'b1'));
    expect(ledgerCacheKey('u1', w, null)).not.toBe(ledgerCacheKey('u2', w, null));
    expect(ledgerCacheKey('u1', w, null)).not.toBe(ledgerCacheKey('u1', { ...w, tz: 'Europe/London' }, null));
  });
});
