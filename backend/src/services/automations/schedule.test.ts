import { describe, expect, it } from 'vitest';
import {
  newestOccurrence, estimateMinutesPerDay, isRunName, minGapMinutes, nextOccurrence, nextOccurrences, occurrenceMinute,
  occurrencesBetween, parseSchedule, parseTimezone, runBranch, runName,
} from './schedule';

const t = (iso: string) => new Date(iso);

describe('parseSchedule', () => {
  it('normalises whitespace and nicknames', () => {
    expect(parseSchedule('  0   9 * * 1-5 ')).toEqual({ ok: true, schedule: '0 9 * * 1-5' });
    expect(parseSchedule('@daily')).toEqual({ ok: true, schedule: '0 0 * * *' });
    expect(parseSchedule('@Hourly')).toEqual({ ok: true, schedule: '0 * * * *' });
  });

  it('refuses six fields, garbage and nothing', () => {
    expect(parseSchedule('0 0 9 * * 1')).toMatchObject({ ok: false, error: expect.stringContaining('5 fields') });
    expect(parseSchedule('99 9 * * *')).toMatchObject({ ok: false, error: expect.stringContaining('not valid cron') });
    expect(parseSchedule('')).toMatchObject({ ok: false });
    expect(parseSchedule(42)).toMatchObject({ ok: false });
  });
});

describe('parseTimezone', () => {
  it('accepts a real zone and refuses a made-up one', () => {
    expect(parseTimezone('America/New_York')).toEqual({ ok: true, timezone: 'America/New_York' });
    expect(parseTimezone('Nope/Nowhere')).toMatchObject({ ok: false });
    expect(parseTimezone('')).toMatchObject({ ok: false });
  });
});

describe('occurrences', () => {
  it('reads the schedule in its timezone', () => {
    // 09:00 New York on 2026-10-20 (EDT) is 13:00 UTC.
    expect(nextOccurrence('0 9 * * 1-5', 'America/New_York', t('2026-10-20T00:00:00Z'))?.toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(nextOccurrences('0 9 * * 1-5', 'America/New_York', t('2026-10-23T14:00:00Z'), 2).map(d => d.toISOString()))
      .toEqual(['2026-10-26T13:00:00.000Z', '2026-10-27T13:00:00.000Z']); // skips the weekend
  });

  it('enumerates (from, to], oldest first, so a weekday schedule has no interval arithmetic', () => {
    const got = occurrencesBetween('0 9 * * 1-5', 'UTC', t('2026-10-16T09:00:00Z'), t('2026-10-20T09:00:00Z'));
    expect(got.map(d => d.toISOString())).toEqual(['2026-10-19T09:00:00.000Z', '2026-10-20T09:00:00.000Z']);
  });

  it('answers nothing when the window holds no occurrence', () => {
    expect(occurrencesBetween('0 9 * * 1-5', 'UTC', t('2026-10-17T00:00:00Z'), t('2026-10-18T23:00:00Z'))).toEqual([]);
  });

  it('caps a flood', () => {
    expect(occurrencesBetween('* * * * *', 'UTC', t('2026-01-01T00:00:00Z'), t('2026-01-02T00:00:00Z'))).toHaveLength(500);
  });
});

describe('minGapMinutes', () => {
  it('finds the smallest gap among the next occurrences', () => {
    expect(minGapMinutes('*/5 * * * *', 'UTC', t('2026-10-20T00:00:00Z'))).toBe(5);
    expect(minGapMinutes('0 9,9 * * *', 'UTC', t('2026-10-20T00:00:00Z'))).toBe(24 * 60);
    expect(minGapMinutes('0 9 * * 1', 'UTC', t('2026-10-20T00:00:00Z'))).toBe(7 * 24 * 60);
  });
});

describe('names', () => {
  it('names a run and its branch from the UTC minute', () => {
    const o = t('2026-10-20T13:00:30Z');
    expect(occurrenceMinute(o).toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(runName(o)).toBe('run-20261020-1300');
    expect(runBranch('triage', o)).toBe('automation/triage/20261020-1300');
    expect(isRunName('run-20261020-1300')).toBe(true);
    expect(isRunName('run-20261020-1300-2')).toBe(true);
    expect(isRunName('main')).toBe(false);
    expect(isRunName('runs')).toBe(false);
  });
});

describe('estimateMinutesPerDay', () => {
  it('spreads a week of runs over seven days', () => {
    expect(estimateMinutesPerDay('0 9 * * 1-5', 'UTC', 60, t('2026-10-19T00:00:00Z'))).toBe(43);
    expect(estimateMinutesPerDay('0 * * * *', 'UTC', 10, t('2026-10-19T00:00:00Z'))).toBe(240);
  });
});

describe('newestOccurrence', () => {
  it('finds the newest due occurrence of a long gap without enumerating it', () => {
    // A month of every-minute occurrences: far more than MAX_ENUMERATED.
    expect(newestOccurrence('* * * * *', 'UTC', t('2026-09-20T00:00:00Z'), t('2026-10-20T09:00:30Z'))?.toISOString()).toBe('2026-10-20T09:00:00.000Z');
    expect(newestOccurrence('0 9 * * 1-5', 'UTC', t('2026-10-01T00:00:00Z'), t('2026-10-18T12:00:00Z'))?.toISOString()).toBe('2026-10-16T09:00:00.000Z');
  });
  it('answers null for a window without one', () => {
    expect(newestOccurrence('0 9 * * 1-5', 'UTC', t('2026-10-17T00:00:00Z'), t('2026-10-18T23:00:00Z'))).toBeNull();
    expect(newestOccurrence('0 9 * * *', 'UTC', t('2026-10-18T00:00:00Z'), t('2026-10-18T00:00:00Z'))).toBeNull();
  });
});
