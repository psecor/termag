import { describe, it, expect } from 'vitest';
import { lastNDaysUTC, previousNDaysUTC, utcDateKey, median } from './dates';

describe('previousNDaysUTC', () => {
  it('offset 0 equals lastNDaysUTC and ends today (UTC)', () => {
    const a = lastNDaysUTC(7);
    const b = previousNDaysUTC(7, 0);
    expect(a).toEqual(b);
    expect(a).toHaveLength(7);
    expect(a[6]).toBe(utcDateKey(new Date()));
  });
  it('offset n is the period immediately before, contiguous and non-overlapping', () => {
    const cur = previousNDaysUTC(7, 0);
    const prev = previousNDaysUTC(7, 7);
    expect(prev).toHaveLength(7);
    expect(new Set([...cur, ...prev]).size).toBe(14);
    const lastPrev = new Date(prev[6] + 'T00:00:00Z');
    const firstCur = new Date(cur[0] + 'T00:00:00Z');
    expect(firstCur.getTime() - lastPrev.getTime()).toBe(86_400_000);
  });
});

describe('median', () => {
  it('handles empty, odd and even lengths', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
