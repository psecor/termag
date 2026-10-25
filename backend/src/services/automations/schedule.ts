/**
 * An automation's schedule: a standard 5-field cron expression read in an
 * IANA timezone. Pure: croner does
 * the arithmetic, this module decides what is accepted and enumerates the
 * occurrences the scheduler acts on.
 */
import { Cron } from 'croner';
import { safeTimeZone } from '../briefing/window';

const NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** The most occurrences one enumeration returns; beyond it the rest are not missed runs but a flood. */
export const MAX_ENUMERATED = 500;

export type ScheduleParse = { ok: true; schedule: string } | { ok: false; error: string };

/**
 * A 5-field cron, normalised: whitespace collapsed, a nickname expanded.
 * Six fields (seconds) and anything croner refuses are errors in words.
 */
export function parseSchedule(raw: unknown): ScheduleParse {
  if (typeof raw !== 'string') return { ok: false, error: 'schedule must be a cron expression' };
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { ok: false, error: 'schedule is required' };
  if (trimmed.length > 100) return { ok: false, error: 'schedule is too long' };
  const expr = NICKNAMES[trimmed.toLowerCase()] ?? trimmed;
  const fields = expr.split(' ');
  if (fields.length !== 5) return { ok: false, error: `schedule must have 5 fields (minute hour day month weekday), got ${fields.length}` };
  try {
    // croner validates on construction; a pattern with no future run is still valid.
    new Cron(expr, { timezone: 'UTC' });
  } catch (err) {
    return { ok: false, error: `schedule is not valid cron: ${(err as Error).message}` };
  }
  return { ok: true, schedule: expr };
}

/** The timezone, or the error when it is not a real IANA zone. */
export function parseTimezone(raw: unknown): { ok: true; timezone: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'timezone is required' };
  const tz = raw.trim();
  if (safeTimeZone(tz) !== tz) return { ok: false, error: `Unknown timezone: ${tz}` };
  return { ok: true, timezone: tz };
}

function cron(schedule: string, timezone: string): Cron {
  return new Cron(schedule, { timezone });
}

/** The next occurrence strictly after `after`, or null when the schedule never fires again. */
export function nextOccurrence(schedule: string, timezone: string, after: Date): Date | null {
  return cron(schedule, timezone).nextRun(after);
}

/** The next `n` occurrences strictly after `after`. */
export function nextOccurrences(schedule: string, timezone: string, after: Date, n: number): Date[] {
  return cron(schedule, timezone).nextRuns(n, after);
}

/**
 * Every occurrence in `(from, to]`, oldest first, at most MAX_ENUMERATED.
 * This is what the scheduler walks: the newest becomes the run, the rest are
 * recorded as missed (decision 7). No interval arithmetic anywhere, so a
 * weekday schedule and a "twice a day" one are handled the same way.
 */
export function occurrencesBetween(schedule: string, timezone: string, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const c = cron(schedule, timezone);
  let cursor: Date | null = from;
  while (out.length < MAX_ENUMERATED) {
    cursor = c.nextRun(cursor);
    if (!cursor || cursor.getTime() > to.getTime()) break;
    out.push(cursor);
  }
  return out;
}

/**
 * The newest occurrence in `(from, to]`, or null when there is none. Found by
 * looking back from `to` in windows that double from an hour, so a long
 * outage over a dense schedule never enumerates the whole gap: the first
 * window that holds an occurrence is entered only after the half before it
 * held none, so it is short. `occurrencesBetween` stops at the oldest
 * MAX_ENUMERATED; this is what says which one to run when it was cut off.
 */
export function newestOccurrence(schedule: string, timezone: string, from: Date, to: Date): Date | null {
  const c = cron(schedule, timezone);
  const span = to.getTime() - from.getTime();
  if (span <= 0) return null;
  for (let w = 60 * 60_000; ; w *= 2) {
    const lower = new Date(Math.max(from.getTime(), to.getTime() - w));
    let cursor: Date | null = lower;
    let last: Date | null = null;
    for (let i = 0; i < 100_000; i++) {
      cursor = c.nextRun(cursor);
      if (!cursor || cursor.getTime() > to.getTime()) break;
      last = cursor;
    }
    if (last) return last;
    if (lower.getTime() <= from.getTime()) return null;
  }
}

/**
 * The smallest gap between consecutive occurrences among the next few, in
 * minutes; Infinity for a schedule that fires at most once. Used to hold a
 * schedule to the minimum interval.
 */
export function minGapMinutes(schedule: string, timezone: string, after: Date = new Date(), sample = 12): number {
  const runs = nextOccurrences(schedule, timezone, after, sample);
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i].getTime() - runs[i - 1].getTime()) / 60_000;
    if (gap < min) min = gap;
  }
  return min;
}

/** The occurrence's minute, so two processes computing it independently agree on the unique key. */
export function occurrenceMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/**
 * How long a schedule would keep a box up each day, roughly, when every run
 * takes `runMinutes`: the dialog's estimate beside the wake-the-box switch.
 */
export function estimateMinutesPerDay(schedule: string, timezone: string, runMinutes: number, after: Date = new Date()): number {
  const week = occurrencesBetween(schedule, timezone, after, new Date(after.getTime() + 7 * 24 * 60 * 60_000));
  return Math.round((week.length * runMinutes) / 7);
}

/** `run-20261020-0900`: the workstream name of an occurrence, from its UTC minute. */
export function runName(occurrence: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `run-${occurrence.getUTCFullYear()}${p(occurrence.getUTCMonth() + 1)}${p(occurrence.getUTCDate())}-${p(occurrence.getUTCHours())}${p(occurrence.getUTCMinutes())}`;
}

/** `automation/<project>/20261020-0900`: the run's git branch. */
export function runBranch(projectName: string, occurrence: Date): string {
  return `automation/${projectName}/${runName(occurrence).slice('run-'.length)}`;
}

/** A workstream name the scheduler made (so Branch off… and rename can leave them alone). */
export function isRunName(name: string): boolean {
  return /^run-\d{8}-\d{4}(-\d+)?$/.test(name);
}
