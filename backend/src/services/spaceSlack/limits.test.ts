import { describe, expect, it, vi } from 'vitest';

const ld = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../featureFlags', () => ({ jsonVariation: vi.fn(async () => ld.value) }));

import { DEFAULT_SPACE_SLACK_LIMITS, parseSpaceSlackLimits, spaceSlackLimitsFor } from './limits';

const runner = { id: 'u1', unixUsername: 'u1', googleEmail: 'u1@example.com' } as unknown as Parameters<typeof spaceSlackLimitsFor>[0];

describe('space-slack-limits', () => {
  it('has the tech spec\'s defaults (§10)', () => {
    expect(DEFAULT_SPACE_SLACK_LIMITS).toEqual({
      channelsPerSpace: 5, concurrentTurnsPerSpace: 2, concurrentTurnsAll: 10, routerTurnsPerDay: 200,
      turnsPerRequesterPerDay: 60, fanOut: 3, asksPerSpace: 5, asksPerRequesterPerDay: 20, cardTtlHours: 24,
      newBoxesPerDay: 1, runMinutesPerDay: 480, streamStartsPerMinute: 18, allowPrivate: true,
    });
    expect(parseSpaceSlackLimits(null)).toEqual(DEFAULT_SPACE_SLACK_LIMITS);
    expect(parseSpaceSlackLimits([1, 2])).toEqual(DEFAULT_SPACE_SLACK_LIMITS);
  });

  it('takes good keys and drops malformed ones one by one', () => {
    const l = parseSpaceSlackLimits({ channelsPerSpace: 8, fanOut: 0, cardTtlHours: 1.5, allowPrivate: 'no', newBoxesPerDay: 0, asksPerSpace: -1, typo: 3 });
    expect(l).toEqual({ ...DEFAULT_SPACE_SLACK_LIMITS, channelsPerSpace: 8, newBoxesPerDay: 0 });
    expect(parseSpaceSlackLimits({ allowPrivate: false }).allowPrivate).toBe(false);
  });

  it('lays a space\'s own limits over the flag\'s, over the defaults', async () => {
    ld.value = { channelsPerSpace: 3, fanOut: 4 };
    expect(await spaceSlackLimitsFor(runner)).toMatchObject({ channelsPerSpace: 3, fanOut: 4, asksPerSpace: 5 });
    expect(await spaceSlackLimitsFor(runner, { channelsPerSpace: 1, fanOut: 'x' })).toMatchObject({ channelsPerSpace: 1, fanOut: 4 });
    ld.value = null;
    expect(await spaceSlackLimitsFor(runner)).toEqual(DEFAULT_SPACE_SLACK_LIMITS);
  });
});
