import { afterEach, describe, expect, it, vi } from 'vitest';
import { boolVariation, closeFeatureFlags, flagConfigFromEnv, flagsForBrowser, initFeatureFlags } from './featureFlags';

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
    await initFeatureFlags({ TERMAG_FLAGS: '{"warm-pool-enabled": true, "box-update-v1": "yes"}' });
    expect(await boolVariation('warm-pool-enabled', user, false)).toBe(true);
    expect(await boolVariation('box-update-v1', user, false)).toBe(false);
    expect(flagsForBrowser()).toEqual({ 'warm-pool-enabled': true, 'box-update-v1': 'yes' });
  });
});
