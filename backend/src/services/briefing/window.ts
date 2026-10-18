/**
 * The window a briefing reviews: everything since the previous briefing, stated clearly.
 *
 *   previous done briefing   → from its `until` (basis since_last)
 *   none                     → from the start of the previous local day (first)
 *   previous ended over STALE_AFTER_DAYS local days ago
 *                            → from the start of the previous local day (stale;
 *                              decided 2026-10-17: after a few days away, a
 *                              catch-up on everything is more than anyone reads)
 *   caller passed `since`    → from there, capped at MAX_WINDOW_MS (explicit, or capped)
 *
 * Pure: the timezone arithmetic uses Intl only, so it is testable in any TZ.
 */
import type { BriefingWindow } from './types';

export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Calendar days in the user's zone, not hours: Friday 08:00 to Monday 08:05
 * is 72 hours and a bit (73 across the autumn clock change) but only three
 * days, and a weekend must not cut Friday out of Monday's briefing. Four
 * keeps a long weekend (Friday to Tuesday) whole too.
 */
export const STALE_AFTER_DAYS = 4;

/** Local calendar days from `a` to `b` in a zone (Friday → Monday is 3). */
export function localDaysBetween(a: Date, b: Date, tz: string): number {
  const day = (at: Date) => { const p = zonedParts(at, tz); return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000; };
  return day(b) - day(a);
}

/** A valid IANA zone, else UTC. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock parts of an instant in a zone. weekday: 0 = Sunday. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDayKey(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant a local wall-clock time names in a zone (the earlier one across a DST overlap). */
export function zonedInstant(tz: string, year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const want = Date.UTC(year, month - 1, day, hour, minute);
  let t = want;
  // Two passes converge across a DST change: offset(t) = wall(t) - t.
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), tz);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const next = t + (want - wall);
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

/** Midnight that starts the local day before `at`'s local day. */
export function startOfPreviousLocalDay(at: Date, tz: string): Date {
  const p = zonedParts(at, tz);
  const prev = new Date(Date.UTC(p.year, p.month - 1, p.day) - 24 * 60 * 60 * 1000);
  return zonedInstant(tz, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}

/** "2 days 15 hours", "3 hours 20 min", "45 min". */
export function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'}`;
  if (days > 0) return hours > 0 ? `${n(days, 'day')} ${n(hours, 'hour')}` : n(days, 'day');
  if (hours > 0) return mins > 0 ? `${n(hours, 'hour')} ${mins} min` : n(hours, 'hour');
  return `${mins} min`;
}

/** "Fri 9 Oct 16:05" in the zone. */
export function fmtLocal(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short' }).format(at);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${month} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function windowLabel(since: Date, until: Date, tz: string): string {
  return `${fmtLocal(since, tz)} to ${fmtLocal(until, tz)} (${fmtSpan(until.getTime() - since.getTime())})`;
}

/** How the card, the DM and the skill introduce a window. */
export function windowPrefix(basis: string): string {
  switch (basis) {
    case 'first':
    case 'stale': return 'Since the start of yesterday';
    case 'capped': return 'The last 7 days';
    case 'explicit': return 'Reviewed';
    default: return 'Since your last briefing';
  }
}

export interface WindowInput {
  now: Date;
  tz: string;
  /** The previous done briefing: when it was made and the end of the window it covered. */
  previous: { createdAt: Date; until: Date } | null;
  /** A caller-chosen start. */
  since?: Date | null;
}

export function resolveWindow(input: WindowInput): BriefingWindow {
  const tz = safeTimeZone(input.tz);
  const until = input.now;
  const floor = new Date(until.getTime() - MAX_WINDOW_MS);
  let since: Date;
  let basis: BriefingWindow['basis'];
  if (input.since && !Number.isNaN(input.since.getTime())) {
    since = input.since;
    basis = 'explicit';
  } else if (input.previous && localDaysBetween(input.previous.until, until, tz) <= STALE_AFTER_DAYS) {
    since = input.previous.until;
    basis = 'since_last';
  } else if (input.previous) {
    since = startOfPreviousLocalDay(until, tz);
    basis = 'stale';
  } else {
    since = startOfPreviousLocalDay(until, tz);
    basis = 'first';
  }
  if (since.getTime() < floor.getTime()) {
    since = floor;
    basis = 'capped';
  }
  // A start in the future (clock skew, a bad parameter) reviews nothing; keep a minute.
  if (since.getTime() >= until.getTime()) since = new Date(until.getTime() - 60_000);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    tz,
    label: windowLabel(since, until, tz),
    basis,
    previousBriefingAt: input.previous ? input.previous.createdAt.toISOString() : null,
  };
}

/**
 * Day keys a window touches: server-local (worktime rows) and UTC (token
 * rows). Both conventions are documented on their tables; partial days are
 * included whole, and the ledger says so.
 */
export function dayKeysTouched(since: Date, until: Date, tz: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let t = since.getTime(); t <= until.getTime() + 1; t += 60 * 60 * 1000) {
    const k = localDayKey(new Date(Math.min(t, until.getTime())), tz);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const last = localDayKey(until, tz);
  if (!seen.has(last)) keys.push(last);
  return keys;
}

/** The server's own zone, which WorkTimeEntry.date is written in. */
export function serverTimeZone(): string {
  return safeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
