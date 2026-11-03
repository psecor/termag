/**
 * IANA time-zone arithmetic, so per-day figures fall on a person's own hours
 * and midnights rather than UTC's. Pure, Intl only.
 */

/** Whether `tz` is an IANA zone this runtime knows ("America/Los_Angeles", "UTC"). */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(at: Date, tz: string): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** How far `tz`'s wall clock is ahead of UTC at `at`, in ms (−7h for Pacific daylight time). */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = partsIn(at, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The YYYY-MM-DD calendar day `at` falls on in `tz`. */
export function dayKeyIn(at: Date, tz: string): string {
  const p = partsIn(at, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `key` moved by `n` calendar days. */
export function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant midnight starts the calendar day `key` in `tz`. */
export function midnightIn(key: string, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // The offset at the wall time read as UTC is off by the offset itself near a transition; one more pass settles it.
  const first = wall - tzOffsetMs(new Date(wall), tz);
  return new Date(wall - tzOffsetMs(new Date(first), tz));
}
