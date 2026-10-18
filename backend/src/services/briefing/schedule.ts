/**
 * The per-user briefing schedule, stored in User.briefingSchedule (jsonb).
 * Opt-in (decided 2026-10-11): `{}` and anything unreadable mean off, so
 * nobody gets a scheduled run, or a Slack DM, until they turn it on.
 */
import type { BriefingSchedule } from './types';
import { localDayKey, safeTimeZone, zonedParts } from './window';

export const DEFAULT_SCHEDULE: BriefingSchedule = {
  enabled: false,
  time: '08:00',
  timezone: null,
  days: [1, 2, 3, 4, 5],
  slackDm: true,
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Read a stored value, defaulting every missing or malformed field. Never throws. */
export function readSchedule(raw: unknown): BriefingSchedule {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort()
    : DEFAULT_SCHEDULE.days;
  const tz = typeof r.timezone === 'string' && safeTimeZone(r.timezone) === r.timezone ? r.timezone : null;
  return {
    enabled: r.enabled === true && tz !== null,
    time: typeof r.time === 'string' && TIME.test(r.time) ? r.time : DEFAULT_SCHEDULE.time,
    timezone: tz,
    days,
    slackDm: r.slackDm === undefined ? DEFAULT_SCHEDULE.slackDm : r.slackDm === true,
  };
}

/** Validate a PUT body. Turning it on needs a real timezone and at least one day. */
export function parseScheduleBody(body: unknown): BriefingSchedule | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a schedule object' };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' };
  if (typeof b.time !== 'string' || !TIME.test(b.time)) return { error: 'time must be HH:MM, 24-hour' };
  if (b.timezone !== null && typeof b.timezone !== 'string') return { error: 'timezone must be a string or null' };
  if (typeof b.timezone === 'string' && safeTimeZone(b.timezone) !== b.timezone) return { error: `Unknown timezone: ${b.timezone}` };
  if (!Array.isArray(b.days) || !b.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return { error: 'days must be a list of weekday numbers, 0 (Sunday) to 6 (Saturday)' };
  }
  if (typeof b.slackDm !== 'boolean') return { error: 'slackDm must be true or false' };
  if (b.enabled && !b.timezone) return { error: 'Choose a timezone to turn the schedule on' };
  if (b.enabled && b.days.length === 0) return { error: 'Choose at least one day to turn the schedule on' };
  return {
    enabled: b.enabled,
    time: b.time,
    timezone: (b.timezone as string | null) ?? null,
    days: [...new Set(b.days as number[])].sort(),
    slackDm: b.slackDm,
  };
}

/**
 * Whether a scheduled briefing is due now, and the local day it belongs to.
 * Due from the scheduled minute until the end of that local day, so a run
 * that found no box ready is retried on later ticks the same day.
 */
export function scheduleDue(s: BriefingSchedule, now: Date): { due: false } | { due: true; day: string } {
  if (!s.enabled || !s.timezone) return { due: false };
  const p = zonedParts(now, s.timezone);
  if (!s.days.includes(p.weekday)) return { due: false };
  const [h, m] = s.time.split(':').map(Number);
  if (p.hour * 60 + p.minute < h * 60 + m) return { due: false };
  return { due: true, day: localDayKey(now, s.timezone) };
}

export function scheduleKey(userId: string, day: string): string {
  return `${userId}:${day}`;
}
