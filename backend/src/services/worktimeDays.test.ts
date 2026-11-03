/**
 * The day working time is banked under (services/worktimeDays.ts): the
 * person's local day in their zone, a span cut at their midnights, DST
 * included; with no zone, the orchestrator's own day, as before.
 */
import { describe, expect, it } from 'vitest';
import { shiftDay, splitWorkTimeByDay, workTimeDay } from './worktimeDays';

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;

describe('workTimeDay', () => {
  it("is the person's local day in their zone", () => {
    // 9:30 PM in New York on the 29th is already the 30th in UTC.
    expect(workTimeDay(at('2026-10-30T01:30:00Z'), 'America/New_York')).toBe('2026-10-29');
    expect(workTimeDay(at('2026-10-30T01:30:00Z'), 'UTC')).toBe('2026-10-30');
    // Just after midnight in Kolkata (+5:30) is still the evening before in UTC.
    expect(workTimeDay(at('2026-10-29T18:45:00Z'), 'Asia/Kolkata')).toBe('2026-10-30');
  });

  it("is the orchestrator's own day with no zone", () => {
    const d = new Date('2026-10-30T01:30:00Z');
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(workTimeDay(d.getTime())).toBe(local);
  });
});

describe('splitWorkTimeByDay', () => {
  it('keeps a span inside one day whole', () => {
    expect(splitWorkTimeByDay(at('2026-10-29T14:00:00Z'), at('2026-10-29T15:00:00Z'), 'America/New_York'))
      .toEqual([{ date: '2026-10-29', ms: 60 * MIN }]);
  });

  it("cuts a span at the person's midnight", () => {
    // 11:30 PM to 12:30 AM in New York (EDT, -4).
    expect(splitWorkTimeByDay(at('2026-10-30T03:30:00Z'), at('2026-10-30T04:30:00Z'), 'America/New_York')).toEqual([
      { date: '2026-10-29', ms: 30 * MIN },
      { date: '2026-10-30', ms: 30 * MIN },
    ]);
    // The same instant is mid-morning in UTC: one day.
    expect(splitWorkTimeByDay(at('2026-10-30T03:30:00Z'), at('2026-10-30T04:30:00Z'), 'UTC'))
      .toEqual([{ date: '2026-10-30', ms: 60 * MIN }]);
  });

  it('finds midnight on the day the clocks go back', () => {
    // New York leaves DST on 1 Nov 2026: that day is 25 hours, and the next
    // midnight is 05:00Z (EST), not 04:00Z.
    expect(splitWorkTimeByDay(at('2026-11-02T04:30:00Z'), at('2026-11-02T05:30:00Z'), 'America/New_York')).toEqual([
      { date: '2026-11-01', ms: 30 * MIN },
      { date: '2026-11-02', ms: 30 * MIN },
    ]);
  });

  it('cuts at a half-hour zone\'s midnight, and across several days', () => {
    expect(splitWorkTimeByDay(at('2026-10-29T18:00:00Z'), at('2026-10-29T19:00:00Z'), 'Asia/Kolkata')).toEqual([
      { date: '2026-10-29', ms: 30 * MIN },
      { date: '2026-10-30', ms: 30 * MIN },
    ]);
    const days = splitWorkTimeByDay(at('2026-10-28T12:00:00Z'), at('2026-10-30T12:00:00Z'), 'UTC');
    expect(days.map(d => d.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30']);
    expect(days.reduce((s, d) => s + d.ms, 0)).toBe(48 * 60 * MIN);
  });

  it('banks nothing for an empty or backwards span', () => {
    expect(splitWorkTimeByDay(1000, 1000, 'UTC')).toEqual([]);
    expect(splitWorkTimeByDay(2000, 1000, 'UTC')).toEqual([]);
  });
});

describe('shiftDay', () => {
  it('moves a day key by whole calendar days, across months and years', () => {
    expect(shiftDay('2026-10-30', -2)).toBe('2026-10-28');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});
