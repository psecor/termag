/**
 * Date-key helpers. Two calendars are in play: token usage, visits, warp and
 * context series are keyed by UTC day (the agent/backend use toISOString), while
 * worktime `date` is the SERVER's local day. Helpers come in local + UTC pairs;
 * pick the one matching the data source.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function utcDateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function localToday(): string {
  return localDateKey(new Date());
}

export function utcToday(): string {
  return utcDateKey(new Date());
}

/** Both local and UTC today strings (deduplicated) — covers timezone mismatch with server */
export function todayDates(): string[] {
  const lt = localToday();
  const ut = utcToday();
  return lt === ut ? [lt] : [lt, ut];
}

/** Last n local days, oldest → newest, ending today. */
export function lastNDays(n: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    result.push(localDateKey(d));
  }
  return result;
}

/** Same as lastNDays but in UTC */
export function lastNDaysUTC(n: number): string[] {
  return previousNDaysUTC(n, 0);
}

/**
 * n UTC days ending `offset` days before today (offset 0 = ends today).
 * previousNDaysUTC(7, 7) is "the 7 days before the last 7" — the prior period
 * for a delta.
 */
export function previousNDaysUTC(n: number, offset: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = n - 1 + offset; i >= offset; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    result.push(utcDateKey(d));
  }
  return result;
}

/** Label a UTC hour bucket of today in the viewer's local clock, e.g. 13 → "6a" / "13". */
export function utcHourToLocalLabel(utcHour: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour));
  return String(d.getHours()).padStart(2, '0');
}

export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
