import { describe, expect, it } from 'vitest';
import {
  MAX_WINDOW_MS, dayKeysTouched, localDaysBetween, fmtSpan, localDayKey, resolveWindow, safeTimeZone,
  startOfPreviousLocalDay, windowLabel, zonedInstant, zonedParts,
} from './window';

describe('safeTimeZone', () => {
  it('keeps a real zone and falls back to UTC', () => {
    expect(safeTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(safeTimeZone('Not/AZone')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
    expect(safeTimeZone('')).toBe('UTC');
  });
});

describe('zoned arithmetic', () => {
  it('reads wall-clock parts in a zone', () => {
    const p = zonedParts(new Date('2026-10-12T14:00:00Z'), 'America/New_York');
    expect(p).toMatchObject({ year: 2026, month: 10, day: 12, hour: 10, minute: 0, weekday: 1 });
  });

  it('finds the instant of a local time, across DST', () => {
    expect(zonedInstant('America/New_York', 2026, 10, 12, 0, 0).toISOString()).toBe('2026-10-12T04:00:00.000Z');
    // 2026-11-01 is the US fall-back day; midnight is still EDT.
    expect(zonedInstant('America/New_York', 2026, 11, 1, 0, 0).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(zonedInstant('America/New_York', 2026, 11, 2, 0, 0).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedInstant('Asia/Kolkata', 2026, 10, 12, 7, 30).toISOString()).toBe('2026-10-12T02:00:00.000Z');
  });

  it('starts the previous local day at local midnight', () => {
    const at = new Date('2026-10-12T03:00:00Z'); // still Sun 11 Oct in Los Angeles
    expect(startOfPreviousLocalDay(at, 'America/Los_Angeles').toISOString()).toBe('2026-10-10T07:00:00.000Z');
    expect(startOfPreviousLocalDay(at, 'UTC').toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });

  it('keys local days', () => {
    expect(localDayKey(new Date('2026-10-12T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-11');
    expect(localDayKey(new Date('2026-10-12T03:00:00Z'), 'UTC')).toBe('2026-10-12');
  });
});

describe('labels', () => {
  it('formats spans', () => {
    expect(fmtSpan(45 * 60_000)).toBe('45 min');
    expect(fmtSpan(60 * 60_000)).toBe('1 hour');
    expect(fmtSpan((3 * 60 + 20) * 60_000)).toBe('3 hours 20 min');
    expect(fmtSpan((2 * 24 + 15) * 60 * 60_000)).toBe('2 days 15 hours');
    expect(fmtSpan(24 * 60 * 60_000)).toBe('1 day');
  });

  it('writes the window in the zone', () => {
    const since = new Date('2026-10-09T16:05:00Z');
    const until = new Date('2026-10-12T07:00:00Z');
    expect(windowLabel(since, until, 'UTC')).toBe('Fri 9 Oct 16:05 to Mon 12 Oct 07:00 (2 days 14 hours)');
  });
});

describe('resolveWindow', () => {
  const now = new Date('2026-10-12T14:00:00Z');

  it('runs from the previous briefing', () => {
    const w = resolveWindow({ now, tz: 'UTC', previous: { createdAt: new Date('2026-10-09T16:06:00Z'), until: new Date('2026-10-09T16:05:00Z') } });
    expect(w).toMatchObject({ since: '2026-10-09T16:05:00.000Z', until: now.toISOString(), basis: 'since_last', previousBriefingAt: '2026-10-09T16:06:00.000Z' });
    expect(w.label.startsWith('Fri 9 Oct 16:05 to Mon 12 Oct 14:00')).toBe(true);
  });

  it('starts at the previous local day for a first briefing', () => {
    const w = resolveWindow({ now, tz: 'America/New_York', previous: null });
    expect(w).toMatchObject({ since: '2026-10-11T04:00:00.000Z', basis: 'first', previousBriefingAt: null });
  });

  it('starts at the previous local day when the previous briefing is over four local days old', () => {
    const w = resolveWindow({ now, tz: 'America/New_York', previous: { createdAt: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-09-01T00:00:00Z') } });
    expect(w).toMatchObject({ since: '2026-10-11T04:00:00.000Z', basis: 'stale', previousBriefingAt: '2026-09-01T00:00:00.000Z' });
  });

  it('keeps a weekend whole: Friday 08:00 to a late Monday, across the clock change', () => {
    // US fall-back weekend 2026: Sunday 1 Nov. Friday 30 Oct 08:00 to Monday 2 Nov 08:05 Pacific is 73 hours.
    const fri = new Date('2026-10-30T15:00:00Z');
    const mon = new Date('2026-11-02T16:05:00Z');
    expect(localDaysBetween(fri, mon, 'America/Los_Angeles')).toBe(3);
    expect(resolveWindow({ now: mon, tz: 'America/Los_Angeles', previous: { createdAt: fri, until: fri } }))
      .toMatchObject({ since: fri.toISOString(), basis: 'since_last' });
  });

  it('keeps a long weekend whole, and calls five days stale', () => {
    const fri = new Date('2026-10-09T15:00:00Z');
    const tue = new Date('2026-10-13T15:00:00Z');
    expect(resolveWindow({ now: tue, tz: 'America/Los_Angeles', previous: { createdAt: fri, until: fri } }).basis).toBe('since_last');
    expect(resolveWindow({ now: new Date('2026-10-14T15:00:00Z'), tz: 'America/Los_Angeles', previous: { createdAt: fri, until: fri } }).basis).toBe('stale');
  });

  it('honours and caps an explicit start', () => {
    expect(resolveWindow({ now, tz: 'UTC', previous: null, since: new Date('2026-10-12T09:00:00Z') }).basis).toBe('explicit');
    const capped = resolveWindow({ now, tz: 'UTC', previous: null, since: new Date('2026-01-01T00:00:00Z') });
    expect(capped.basis).toBe('capped');
    expect(new Date(capped.until).getTime() - new Date(capped.since).getTime()).toBe(MAX_WINDOW_MS);
  });

  it('never returns an empty or inverted window', () => {
    const w = resolveWindow({ now, tz: 'UTC', previous: null, since: new Date('2026-10-13T00:00:00Z') });
    expect(new Date(w.since).getTime()).toBeLessThan(new Date(w.until).getTime());
  });

  it('falls back to UTC for a bad zone', () => {
    expect(resolveWindow({ now, tz: 'Mars/Olympus', previous: null }).tz).toBe('UTC');
  });
});

describe('dayKeysTouched', () => {
  it('lists every local day the window touches', () => {
    expect(dayKeysTouched(new Date('2026-10-09T16:05:00Z'), new Date('2026-10-12T07:00:00Z'), 'UTC'))
      .toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    expect(dayKeysTouched(new Date('2026-10-12T09:00:00Z'), new Date('2026-10-12T10:00:00Z'), 'UTC')).toEqual(['2026-10-12']);
  });
});
