import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, fullSpan, fullTime, shortSpan, shortTime, spanText, timeMs, viewerTimeZone, zoneName } from './chatTimes';

// 28 Oct 2026, 18:14:05 in Los Angeles (PDT, UTC-7) is 01:14:05 UTC on the 29th.
const END = '2026-10-29T01:14:05.120Z';
const LA = 'America/Los_Angeles';
const nowAt = (iso: string) => Date.parse(iso);

describe('shortTime: the viewer’s zone, not UTC', () => {
  it('is the time alone today, in the zone given', () => {
    expect(shortTime(END, nowAt('2026-10-29T03:00:00Z'), LA)).toBe('18:14');
    // The same instant is the next day in UTC.
    expect(shortTime(END, nowAt('2026-10-29T03:00:00Z'), 'UTC')).toBe('01:14');
  });

  it('adds the day when it isn’t today, and the year when it isn’t this year', () => {
    // 29 Oct 09:00 in LA: the end was yesterday there.
    expect(shortTime(END, nowAt('2026-10-29T16:00:00Z'), LA)).toBe('28 Oct 18:14');
    expect(shortTime(END, nowAt('2027-01-02T16:00:00Z'), LA)).toBe('28 Oct 2026, 18:14');
  });

  it('decides "today" in the viewer’s zone: the same pair of instants is today in one zone and not in another', () => {
    const now = nowAt('2026-10-29T06:30:00Z'); // 23:30 on the 28th in LA, 07:30 on the 29th in Berlin
    expect(shortTime('2026-10-28T20:00:00Z', now, LA)).toBe('13:00');
    expect(shortTime('2026-10-28T20:00:00Z', now, 'Europe/Berlin')).toBe('28 Oct 21:00');
  });

  it('says nothing for a time that doesn’t parse', () => {
    expect(shortTime('not a time', Date.now(), LA)).toBe('');
    expect(timeMs('not a time')).toBeNull();
    expect(timeMs(null)).toBeNull();
  });
});

describe('fullTime: the hover’s full timestamp names the zone', () => {
  it('reads "28 Oct 2026, 18:14:05 PDT" in Los Angeles', () => {
    expect(fullTime(END, LA)).toBe('28 Oct 2026, 18:14:05 PDT');
  });

  it('names other zones by their own abbreviation, else by offset', () => {
    expect(fullTime(END, 'Europe/Berlin')).toBe('29 Oct 2026, 02:14:05 CET');
    expect(fullTime('2026-07-01T12:00:00Z', 'Europe/London')).toBe('1 Jul 2026, 13:00:00 BST');
    expect(fullTime(END, 'Asia/Kolkata')).toBe('29 Oct 2026, 06:44:05 GMT+5:30');
    expect(fullTime(END, 'UTC')).toBe('29 Oct 2026, 01:14:05 UTC');
    expect(zoneName(Date.parse('2026-01-15T12:00:00Z'), LA)).toBe('PST');
  });
});

describe('viewerTimeZone: the browser’s', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is what Intl resolves for this browser', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Tokyo' } as Intl.ResolvedDateTimeFormatOptions);
    expect(viewerTimeZone()).toBe('Asia/Tokyo');
  });

  it('falls back to UTC when the browser can’t say', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions);
    expect(viewerTimeZone()).toBe('UTC');
  });
});

describe('spans and the live counter', () => {
  it('writes a span short and in full', () => {
    const start = '2026-10-29T01:02:11Z';
    const now = nowAt('2026-10-29T03:00:00Z');
    expect(shortSpan(start, END, now, LA)).toBe('18:02–18:14');
    expect(fullSpan(start, END, LA)).toBe('28 Oct 2026, 18:02:11 – 18:14:05 PDT');
    expect(spanText(start, END)).toBe('11m 54s');
    // Across midnight there, both days are said.
    expect(fullSpan('2026-10-29T06:58:00Z', '2026-10-29T07:03:00Z', LA)).toBe('28 Oct 2026, 23:58:00 PDT – 29 Oct 2026, 00:03:00 PDT');
    expect(shortSpan('2026-10-29T06:58:00Z', '2026-10-29T07:03:00Z', nowAt('2026-10-29T08:00:00Z'), LA)).toBe('28 Oct 23:58 – 00:03');
  });

  it('has no duration when a time is missing, or the end is before the start', () => {
    expect(spanText(null, END)).toBeNull();
    expect(spanText(END, '2026-10-29T01:00:00Z')).toBeNull();
  });

  it('counts quietly: seconds, then whole minutes, then hours and minutes', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(12 * 60_000 + 59_000)).toBe('12m');
    expect(formatElapsed(65 * 60_000)).toBe('1h 5m');
    expect(formatElapsed(120 * 60_000)).toBe('2h');
  });
});
