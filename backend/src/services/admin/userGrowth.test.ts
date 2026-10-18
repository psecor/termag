import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {} }));
import { bucketStart, bucketKey, growthSeries, isGrowthBucket, parseGrowthQuery } from './userGrowth';

const at = (iso: string) => new Date(iso);

describe('bucketStart', () => {
  it('starts weeks on Monday, UTC', () => {
    // 2026-10-12 is a Monday; Sunday the 11th belongs to the week of the 5th.
    expect(bucketKey(bucketStart(at('2026-10-12T00:00:00Z'), 'week'), 'week')).toBe('2026-10-12');
    expect(bucketKey(bucketStart(at('2026-10-11T23:59:59Z'), 'week'), 'week')).toBe('2026-10-05');
    expect(bucketKey(bucketStart(at('2026-10-14T12:00:00Z'), 'week'), 'week')).toBe('2026-10-12');
  });
  it('keys days and months', () => {
    expect(bucketKey(bucketStart(at('2026-10-12T23:30:00Z'), 'day'), 'day')).toBe('2026-10-12');
    expect(bucketKey(bucketStart(at('2026-02-28T10:00:00Z'), 'month'), 'month')).toBe('2026-02');
  });
});

describe('growthSeries', () => {
  const now = at('2026-10-14T12:00:00Z'); // a Wednesday
  const signups = ['2026-09-01T09:00:00Z', '2026-09-01T18:00:00Z', '2026-09-20T10:00:00Z', '2026-10-05T08:00:00Z', '2026-10-13T08:00:00Z', '2026-10-14T08:00:00Z'].map(at);

  it('counts new users per month with a running total, from the first sign-up', () => {
    const g = growthSeries(signups, 'month', now);
    expect(g.rows).toEqual([
      { key: '2026-09', new: 3, total: 3 },
      { key: '2026-10', new: 3, total: 6 },
    ]);
    expect(g.total).toBe(6);
    expect(g.before).toBe(0);
    expect(g.firstAt).toBe('2026-09-01T09:00:00.000Z');
    expect(g.current).toBe(3);
    expect(g.previous).toBe(3);
  });

  it('zero-fills weeks with no sign-ups', () => {
    const g = growthSeries(signups, 'week', now);
    expect(g.rows.map(r => r.key)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    expect(g.rows.map(r => r.new)).toEqual([2, 0, 1, 0, 0, 1, 2]);
    expect(g.rows.map(r => r.total)).toEqual([2, 2, 3, 3, 3, 4, 6]);
  });

  it('keeps the running total true when the window starts after the first sign-up', () => {
    const g = growthSeries(signups, 'day', now, 3);
    expect(g.rows).toEqual([
      { key: '2026-10-12', new: 0, total: 4 },
      { key: '2026-10-13', new: 1, total: 5 },
      { key: '2026-10-14', new: 1, total: 6 },
    ]);
    expect(g.before).toBe(4);
  });

  it('reports the previous bucket even for a one-bucket window', () => {
    const g = growthSeries(signups, 'week', now, 1);
    expect(g.rows).toEqual([{ key: '2026-10-12', new: 2, total: 6 }]);
    expect(g.previous).toBe(1);
  });

  it('returns the current bucket at zero with no users', () => {
    expect(growthSeries([], 'month', now)).toEqual({ bucket: 'month', rows: [{ key: '2026-10', new: 0, total: 0 }], total: 0, before: 0, firstAt: null, current: 0, previous: 0 });
  });

  it('crosses a year boundary by month', () => {
    const g = growthSeries([at('2025-12-31T23:00:00Z'), at('2026-01-01T00:30:00Z')], 'month', at('2026-02-10T00:00:00Z'));
    expect(g.rows).toEqual([
      { key: '2025-12', new: 1, total: 1 },
      { key: '2026-01', new: 1, total: 2 },
      { key: '2026-02', new: 0, total: 2 },
    ]);
  });
});

describe('growthSeries with a sign-up stamped after now', () => {
  it('extends the window so the user is in a row and the line ends at the headcount', () => {
    // Clock skew across a day boundary: one row is dated tomorrow.
    const g = growthSeries([at('2026-10-13T08:00:00Z'), at('2026-10-15T00:10:00Z')], 'day', at('2026-10-14T23:59:00Z'));
    expect(g.rows.map(r => r.key)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
    expect(g.rows[g.rows.length - 1].total).toBe(g.total);
    expect(g.current).toBe(1);
    expect(g.previous).toBe(0);
  });
});

describe('parseGrowthQuery', () => {
  it('defaults to week with no limit', () => {
    expect(parseGrowthQuery({})).toEqual({ bucket: 'week' });
    expect(parseGrowthQuery({ bucket: 'month', limit: '12' })).toEqual({ bucket: 'month', limit: 12 });
  });
  it('rejects unknown buckets and repeated params', () => {
    expect(parseGrowthQuery({ bucket: 'year' })).toHaveProperty('error');
    expect(parseGrowthQuery({ bucket: ['day', 'week'] })).toHaveProperty('error');
  });
  it('rejects limits outside 1..400 and anything not a whole number', () => {
    for (const limit of ['0', '401', '1.5', '-3', 'abc', '', ['5', '6']]) expect(parseGrowthQuery({ limit })).toHaveProperty('error');
    expect(parseGrowthQuery({ limit: '400' })).toEqual({ bucket: 'week', limit: 400 });
  });
});

describe('isGrowthBucket', () => {
  it('accepts only day, week and month', () => {
    expect(['day', 'week', 'month'].every(isGrowthBucket)).toBe(true);
    expect(isGrowthBucket('year')).toBe(false);
    expect(isGrowthBucket(undefined)).toBe(false);
  });
});
