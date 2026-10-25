import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION_LIMITS, parseAutomationLimits } from './limits';

describe('parseAutomationLimits', () => {
  it('is the defaults for no value or garbage', () => {
    expect(parseAutomationLimits(null)).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(parseAutomationLimits('x')).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(parseAutomationLimits([1])).toEqual(DEFAULT_AUTOMATION_LIMITS);
  });

  it('takes good keys and falls back one by one on bad ones', () => {
    const got = parseAutomationLimits({ minIntervalMinutes: 5, maxEnabledPerUser: 0, dailyRunMinutes: '9', perBoxConcurrent: 3.5, pauseAfterFailures: 5 });
    expect(got).toEqual({ ...DEFAULT_AUTOMATION_LIMITS, minIntervalMinutes: 5, pauseAfterFailures: 5 });
  });

  it('caps absurd values back to the default', () => {
    expect(parseAutomationLimits({ maxRunMinutes: 10_000 }).maxRunMinutes).toBe(DEFAULT_AUTOMATION_LIMITS.maxRunMinutes);
  });
});
