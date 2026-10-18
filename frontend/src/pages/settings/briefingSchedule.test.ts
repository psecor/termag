import { describe, expect, it } from 'vitest';
import type { BriefingSchedule } from '../../services/api';
import { enableSchedule, scheduleEqual, toggleDay } from './briefingSchedule';

const off: BriefingSchedule = { enabled: false, time: '08:00', timezone: null, days: [1, 2, 3, 4, 5], slackDm: true };

describe('briefing schedule form', () => {
  it('fills the browser timezone only when none is set', () => {
    expect(enableSchedule(off, 'Europe/London')).toEqual({ ...off, enabled: true, timezone: 'Europe/London' });
    expect(enableSchedule({ ...off, timezone: 'America/New_York' }, 'Europe/London').timezone).toBe('America/New_York');
  });
  it('toggles days and keeps them sorted', () => {
    expect(toggleDay(off, 3).days).toEqual([1, 2, 4, 5]);
    expect(toggleDay(off, 0).days).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('compares regardless of day order', () => {
    expect(scheduleEqual(off, { ...off, days: [5, 4, 3, 2, 1] })).toBe(true);
    expect(scheduleEqual(off, { ...off, slackDm: false })).toBe(false);
    expect(scheduleEqual(off, { ...off, days: [1] })).toBe(false);
  });
});
