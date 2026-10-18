import type { BriefingSchedule } from '../../services/api';

/** 0 = Sunday, matching the backend's BriefingSchedule.days. */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Turning the schedule on fills the timezone from the browser when none is set. */
export function enableSchedule(s: BriefingSchedule, tz: string): BriefingSchedule {
  return { ...s, enabled: true, timezone: s.timezone ?? tz };
}

export function toggleDay(s: BriefingSchedule, day: number): BriefingSchedule {
  const days = s.days.includes(day) ? s.days.filter(d => d !== day) : [...s.days, day];
  return { ...s, days: days.sort((a, b) => a - b) };
}

export function scheduleEqual(a: BriefingSchedule, b: BriefingSchedule): boolean {
  return a.enabled === b.enabled && a.time === b.time && a.timezone === b.timezone && a.slackDm === b.slackDm
    && a.days.length === b.days.length && [...a.days].sort().every((d, i) => d === [...b.days].sort()[i]);
}
