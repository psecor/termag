import { afterEach, describe, expect, it, vi } from 'vitest';
import { boolVariation, boolVariationForContext, closeFeatureFlags, flagConfigFromEnv, flagsForBrowser, initFeatureFlags, jsonVariation, stringVariation } from './featureFlags';

const user = { id: 'u1', googleEmail: 'a@example.com', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' };

describe('flagConfigFromEnv', () => {
  it('is empty when unset or blank', () => {
    expect(flagConfigFromEnv({})).toEqual({ values: {} });
    expect(flagConfigFromEnv({ TERMAG_FLAGS: '  ' })).toEqual({ values: {} });
  });

  it('reads a JSON object and drops null values', () => {
    expect(flagConfigFromEnv({ TERMAG_FLAGS: '{"warm-pool-enabled": true, "x": null, "n": 3}' }))
      .toEqual({ values: { 'warm-pool-enabled': true, n: 3 } });
  });

  it('ignores malformed input as a whole, with the reason', () => {
    expect(flagConfigFromEnv({ TERMAG_FLAGS: '{nope' }).ignored).toMatch(/not valid JSON/);
    expect(flagConfigFromEnv({ TERMAG_FLAGS: '[true]' }).ignored).toMatch(/JSON object/);
    expect(flagConfigFromEnv({ TERMAG_FLAGS: 'true' }).values).toEqual({});
  });
});

describe('boolVariation', () => {
  afterEach(async () => { await closeFeatureFlags(); vi.restoreAllMocks(); });

  it('returns the fallback when nothing is set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await initFeatureFlags({});
    expect(await boolVariation('warm-pool-enabled', user, false)).toBe(false);
    expect(await boolVariation('hyperspace-background-enabled', user, true)).toBe(true);
  });

  it('returns a configured boolean, and ignores a non-boolean value', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await initFeatureFlags({ TERMAG_FLAGS: '{"warm-pool-enabled": true, "box-auto-update-enabled": "yes"}' });
    expect(await boolVariation('warm-pool-enabled', user, false)).toBe(true);
    expect(await boolVariation('box-auto-update-enabled', user, false)).toBe(false);
    expect(flagsForBrowser()).toEqual({ 'warm-pool-enabled': true, 'box-auto-update-enabled': 'yes' });
  });
});

describe('the other variations', () => {
  afterEach(async () => { await closeFeatureFlags(); vi.restoreAllMocks(); });

  it('answers a context read like a user read, and falls back the same way', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = { kind: 'box', key: 'termag-warm-pool' };
    await initFeatureFlags({});
    expect(await boolVariationForContext('box-hibernation-enabled', pool, false)).toBe(false);
    await initFeatureFlags({ TERMAG_FLAGS: '{"box-hibernation-enabled": true}' });
    expect(await boolVariationForContext('box-hibernation-enabled', pool, false)).toBe(true);
  });

  it('returns a configured string, and the fallback for anything else', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await initFeatureFlags({ TERMAG_FLAGS: '{"box-image": "hibernation"}' });
    expect(await stringVariation('box-image', user, '')).toBe('hibernation');
    await initFeatureFlags({ TERMAG_FLAGS: '{"box-image": 7}' });
    expect(await stringVariation('box-image', user, '')).toBe('');
  });

  it('returns a configured JSON value as given, for the caller to validate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await initFeatureFlags({});
    expect(await jsonVariation('agent-spawn-limits', user, null)).toBeNull();
    await initFeatureFlags({ TERMAG_FLAGS: '{"agent-spawn-limits": {"maxDepth": 2}}' });
    expect(await jsonVariation('agent-spawn-limits', user, null)).toEqual({ maxDepth: 2 });
  });
});
