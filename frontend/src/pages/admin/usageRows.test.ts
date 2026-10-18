import { describe, it, expect } from 'vitest';
import { groupedChartRows } from './usageRows';

type Row = { keys: string[]; labels: string[]; total: number };
const byUser = { groupBy: ['user' as const], rows: [{ keys: ['u1'], labels: ['psecor'], total: 5 }, { keys: ['u2'], labels: ['zane'], total: 3 }] };
const byDay = { groupBy: ['day' as const], rows: [{ keys: ['2026-10-09'], labels: ['2026-10-09'], total: 2 }, { keys: ['2026-10-08'], labels: ['2026-10-08'], total: 1 }] };
const label = (r: Row) => r.labels[0];

describe('groupedChartRows', () => {
  it('keeps the previous report on its own labels while a regroup is in flight', () => {
    // The picker says day, but the report on screen is still the user one.
    const out = groupedChartRows<'day' | 'user', Row>(byUser, 'day', label);
    expect(out.group).toBe('user');
    expect(out.rows.map(r => r.label)).toEqual(['psecor', 'zane']);
    expect(out.rows.some(r => r.label.includes('undefined'))).toBe(false);
  });

  it('switches to date labels in date order once the day report lands', () => {
    const out = groupedChartRows<'day' | 'user', Row>(byDay, 'day', label);
    expect(out.group).toBe('day');
    expect(out.chart.map(r => r.label)).toEqual(['Oct 8', 'Oct 9']);
    expect(out.rows.map(r => r.label)).toEqual(['Oct 9', 'Oct 8']);
  });

  it('uses the picker only before any report arrives', () => {
    expect(groupedChartRows<'day' | 'user', Row>(null, 'day', label)).toEqual({ group: 'day', rows: [], chart: [] });
  });

  it('charts the top rows of a non-day grouping and keeps all in rows', () => {
    const many = { groupBy: ['user' as const], rows: Array.from({ length: 30 }, (_, i) => ({ keys: [`u${i}`], labels: [`user${i}`], total: i })) };
    const out = groupedChartRows<'day' | 'user', Row>(many, 'user', label);
    expect(out.chart).toHaveLength(25);
    expect(out.rows).toHaveLength(30);
  });
});
