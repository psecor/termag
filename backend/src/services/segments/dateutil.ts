/** UTC date helpers for the segment rules (kept dependency-free). */

export function dateAddDays(iso: string, days: number): string {
  const ms = Date.parse(iso + 'T00:00:00Z');
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

export function isoToday(atEpochMs: number = Date.now()): string {
  return new Date(atEpochMs).toISOString().slice(0, 10);
}

/** Difference in whole days (a - b), using UTC day arithmetic. */
export function dayDiff(a: string, b: string): number {
  return Math.floor((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
}
