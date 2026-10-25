import { describe, expect, it } from 'vitest';
import { automationSubtitle, cronToPreset, describeSchedule, occurrenceShort, presetToCron, untilLabel } from './automationSchedule';

describe('presets', () => {
  it('turn into 5-field cron, and back', () => {
    expect(presetToCron({ preset: 'hourly', time: '', weekday: 0, cron: '' })).toBe('0 * * * *');
    expect(presetToCron({ preset: 'daily', time: '7:30', weekday: 0, cron: '' })).toBe('30 7 * * *');
    // A time input may carry seconds; the schedule is to the minute.
    expect(presetToCron({ preset: 'daily', time: '07:30:00', weekday: 0, cron: '' })).toBe('30 7 * * *');
    expect(presetToCron({ preset: 'weekly', time: '18:05:30', weekday: 3, cron: '' })).toBe('5 18 * * 3');
    expect(presetToCron({ preset: 'daily', time: '7:30:99', weekday: 0, cron: '' })).toBeNull();
    expect(presetToCron({ preset: 'weekdays', time: '09:00', weekday: 0, cron: '' })).toBe('0 9 * * 1-5');
    expect(presetToCron({ preset: 'weekly', time: '18:15', weekday: 5, cron: '' })).toBe('15 18 * * 5');
    expect(presetToCron({ preset: 'custom', time: '', weekday: 0, cron: ' */20 * * * * ' })).toBe('*/20 * * * *');
    expect(presetToCron({ preset: 'daily', time: 'noon', weekday: 0, cron: '' })).toBeNull();
    expect(cronToPreset('0 9 * * 1-5')).toMatchObject({ preset: 'weekdays', time: '09:00' });
    expect(cronToPreset('15 18 * * 5')).toMatchObject({ preset: 'weekly', time: '18:15', weekday: 5 });
    expect(cronToPreset('0 * * * *')).toMatchObject({ preset: 'hourly' });
    expect(cronToPreset('*/20 * * * *')).toMatchObject({ preset: 'custom', cron: '*/20 * * * *' });
  });

  it('describes a schedule in words', () => {
    expect(describeSchedule('0 9 * * 1-5', 'UTC')).toBe('weekdays at 09:00 (UTC)');
    expect(describeSchedule('30 7 * * *', '')).toBe('every day at 07:30');
    expect(describeSchedule('*/20 * * * *', 'UTC')).toBe('cron */20 * * * * (UTC)');
  });
});

describe('labels', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('names an occurrence by weekday when near, by date when far', () => {
    expect(occurrenceShort('2026-10-21T13:00:00Z', 'UTC', now)).toBe('Wed 13:00');
    expect(occurrenceShort('2026-11-30T13:00:00Z', 'UTC', now)).toBe('30 Nov 13:00');
  });
  it('says how far off the next run is', () => {
    expect(untilLabel('2026-10-20T12:00:30Z', now)).toBe('now');
    expect(untilLabel('2026-10-20T12:25:00Z', now)).toBe('in 25m');
    expect(untilLabel('2026-10-21T13:00:00Z', now)).toBe('in 25h');
    expect(untilLabel('2026-10-25T13:00:00Z', now)).toBe('in 5d');
    expect(untilLabel(null, now)).toBe('');
  });
  it('writes the sidebar subtitle', () => {
    expect(automationSubtitle({ nextRunAt: '2026-10-21T13:00:00Z', enabled: true, pausedReason: null, lastRun: { state: 'done', finishedAt: '2026-10-20T10:00:00Z', startedAt: null, reasonLabel: null } }, 'UTC', now))
      .toBe('next Wed 13:00 · last done 2h ago');
    expect(automationSubtitle({ nextRunAt: null, enabled: true, pausedReason: 'consecutive_failures', lastRun: null }, 'UTC', now)).toBe('paused: kept failing');
    expect(automationSubtitle({ nextRunAt: null, enabled: false, pausedReason: null, lastRun: { state: 'skipped', finishedAt: null, startedAt: null, reasonLabel: 'the box was asleep' } }, 'UTC', now))
      .toBe('off · skipped: the box was asleep');
  });
});
