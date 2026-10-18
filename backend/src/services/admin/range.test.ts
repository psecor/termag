import { describe, it, expect } from 'vitest';
import { parseRange, fillDays } from './range';

const now = new Date('2026-10-03T15:00:00Z');

describe('parseRange', () => {
  it('defaults to the last 7 UTC days including today', () => {
    const r = parseRange({}, now);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('7d');
    expect(r.keys).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
    expect(r.priorKeys[0]).toBe('2026-09-20');
    expect(r.priorKeys).toHaveLength(7);
    expect(r.worktimeKeys).toEqual(r.keys); // UTC process: no straddle key
    expect(r.worktimeSinceKey).toBe('2026-09-27');
    expect(r.worktimeUntilKey).toBe('2026-10-03');
    expect(r.untilTs.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('handles today and 30d', () => {
    const t = parseRange({ range: 'today' }, now);
    if ('error' in t) throw new Error(t.error);
    expect(t.keys).toEqual(['2026-10-03']);
    const m = parseRange({ range: '30d' }, now);
    if ('error' in m) throw new Error(m.error);
    expect(m.days).toBe(30);
    expect(m.sinceKey).toBe('2026-09-04');
  });

  it('accepts explicit from/to and rejects bad input', () => {
    const r = parseRange({ from: '2026-09-01', to: '2026-09-03' }, now);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('custom');
    expect(r.keys).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(r.worktimeKeys).toEqual(r.keys); // historical range: never widened
    expect(parseRange({ from: '2026-09-31' }, now)).toEqual({ error: 'from/to must be YYYY-MM-DD' });
    expect(parseRange({ from: '2026-09-05', to: '2026-09-01' }, now)).toEqual({ error: 'to must not precede from' });
    expect(parseRange({ range: 'year' }, now)).toEqual({ error: 'range must be today, 7d or 30d' });
    expect(parseRange({ from: '2020-01-01' }, now)).toMatchObject({ error: expect.stringContaining('exceed') });
  });

  it('fillDays zero-fills missing keys in order', () => {
    const out = fillDays(['a', 'b'], new Map([['b', { n: 2 }]]), () => ({ n: 0 }));
    expect(out).toEqual([{ date: 'a', n: 0 }, { date: 'b', n: 2 }]);
  });
});
