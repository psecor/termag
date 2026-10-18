import { describe, it, expect } from 'vitest';
import { distribution, percentile, median, parseChoice, VIEWS } from './stats';

describe('percentile', () => {
  it('interpolates like percentile_cont', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('distribution', () => {
  it('summarises PRs per person over people with at least one', () => {
    expect(distribution([0, 1, 1, 2, 4, 12])).toEqual({ contributors: 5, p50: 2, p95: 10.4, mean: 4, max: 12 });
  });
  it('is all zeros with no contributors', () => {
    expect(distribution([0, 0])).toEqual({ contributors: 0, p50: 0, p95: 0, mean: 0, max: 0 });
  });
});

describe('median and parseChoice', () => {
  it('medians sizes', () => { expect(median([30, 10, 20])).toBe(20); expect(median([])).toBe(0); });
  it('defaults when absent and rejects unknown values', () => {
    expect(parseChoice(undefined, VIEWS, 'credited')).toBe('credited');
    expect(parseChoice('humans', VIEWS, 'credited')).toBe('humans');
    expect(parseChoice('robots', VIEWS, 'credited')).toBeNull();
    expect(parseChoice(['humans'], VIEWS, 'credited')).toBeNull();
  });
});
