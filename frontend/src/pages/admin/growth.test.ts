import { describe, it, expect } from 'vitest';
import { growthLabel, growthRows, growthSpan } from './growth';

describe('growthSpan', () => {
  it('says when the window is cut short of the first sign-in', () => {
    expect(growthSpan({ bucket: 'day', rows: new Array(90).fill({ key: '', new: 0, total: 0 }), before: 2 })).toBe('last 90 days');
    expect(growthSpan({ bucket: 'week', rows: [{ key: '', new: 1, total: 3 }], before: 2 })).toBe('last 1 week');
    expect(growthSpan({ bucket: 'month', rows: [], before: 0 })).toBe('since the first sign-in');
  });
});

describe('growthLabel', () => {
  it('labels days and weeks by their start date, months by month and year', () => {
    expect(growthLabel('2026-10-05', 'day')).toBe('Oct 5');
    expect(growthLabel('2026-10-05', 'week')).toBe('Oct 5');
    expect(growthLabel('2026-10', 'month')).toBe('Oct 2026');
  });
  it('returns an unexpected key unchanged', () => {
    expect(growthLabel('2026-13', 'month')).toBe('2026-13');
    expect(growthLabel('2026-10-05', 'month')).toBe('2026-10-05');
    // Day and week keys go through shortDate, which returns non-day keys unchanged (#304).
    expect(growthLabel('2026-10', 'week')).toBe('2026-10');
    expect(growthLabel('not-a-date', 'day')).toBe('not-a-date');
  });
});

describe('growthRows', () => {
  it('labels by the response bucket', () => {
    const g = { bucket: 'month' as const, rows: [{ key: '2026-09', new: 3, total: 3 }], total: 3, before: 0, firstAt: null, current: 3, previous: 0, note: '' };
    expect(growthRows(g)).toEqual([{ key: '2026-09', new: 3, total: 3, label: 'Sep 2026' }]);
    expect(growthRows(null)).toEqual([]);
  });
});
