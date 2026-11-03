import { describe, expect, it } from 'vitest';
import { emptyDraft, type AutomationDraft } from '../../utils/automationDraft';
import { scheduleLabel } from './SchedulePicker';

const draft = (schedule: Partial<AutomationDraft['schedule']>): AutomationDraft => {
  const d = emptyDraft();
  return { ...d, schedule: { ...d.schedule, ...schedule } };
};

describe('scheduleLabel', () => {
  it('says No schedule for one session, whatever the fields hold', () => {
    expect(scheduleLabel(false, draft({ preset: 'hourly' }))).toBe('No schedule');
  });

  it('names a preset in words', () => {
    expect(scheduleLabel(true, draft({ preset: 'weekdays', time: '09:00' }))).toBe('Weekdays at 09:00');
    expect(scheduleLabel(true, draft({ preset: 'hourly' }))).toBe('Every hour');
    expect(scheduleLabel(true, draft({ preset: 'daily', time: '18:30' }))).toBe('Every day at 18:30');
    expect(scheduleLabel(true, draft({ preset: 'weekly', time: '07:00', weekday: 5 }))).toBe('Every Friday at 07:00');
  });

  it('shows a custom cron as it is, and On a schedule while the fields are incomplete', () => {
    expect(scheduleLabel(true, draft({ preset: 'custom', cron: '*/30 9-17 * * 1-5' }))).toBe('Cron */30 9-17 * * 1-5');
    expect(scheduleLabel(true, draft({ preset: 'custom', cron: '' }))).toBe('On a schedule');
    expect(scheduleLabel(true, draft({ preset: 'daily', time: '' }))).toBe('On a schedule');
  });
});
