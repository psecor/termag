/**
 * The day working time is banked under: the person's own local day, in the
 * zone their termag clients last reported (User.timeZone,
 * services/userTimeZone.ts), so "today" in termag's thermometers and the
 * desktop's sidebar foot is their today. With no zone known, the
 * orchestrator's own day, as before one was recorded.
 *
 * A span is cut at the person's midnights (DST days included), so time worked
 * across midnight lands on both days.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = formatters.get(key);
  if (!f) {
    // en-CA formats a date as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(key, f);
  }
  return f;
}

/** The `YYYY-MM-DD` day `ms` falls on in `timeZone`, or in the orchestrator's zone without one. */
export function workTimeDay(ms: number, timeZone?: string): string {
  return formatterFor(timeZone).format(ms);
}

/** A local day is at most 25 hours (a DST day), so the next one starts within 26. */
const NEXT_DAY_WITHIN_MS = 26 * 3_600_000;

/** The first ms after `ms` on another day in `timeZone`: its next midnight. */
function nextDayStart(ms: number, timeZone: string | undefined): number {
  const day = workTimeDay(ms, timeZone);
  let lo = ms;
  let hi = ms + NEXT_DAY_WITHIN_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (workTimeDay(mid, timeZone) === day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The span [startMs, endMs) as the time it holds on each of `timeZone`'s days, oldest first. */
export function splitWorkTimeByDay(
  startMs: number,
  endMs: number,
  timeZone?: string,
): Array<{ date: string; ms: number }> {
  const parts: Array<{ date: string; ms: number }> = [];
  let from = startMs;
  while (from < endMs) {
    const to = Math.min(endMs, nextDayStart(from, timeZone));
    parts.push({ date: workTimeDay(from, timeZone), ms: to - from });
    from = to;
  }
  return parts;
}

/** `day` (`YYYY-MM-DD`) moved by `deltaDays` calendar days. */
export function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}
