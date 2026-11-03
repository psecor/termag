// What the What's new dialog shows (What people see), as
// pure functions of the entries, the flags that are on, today and what has
// been seen, so each is tested without a browser.
import type { FlagKey } from '../flags';
import type { Surface, WhatsNewEntry } from './whatsNew';

/** How far back a tab goes. */
export const WINDOW_DAYS = 90;

/** The localStorage key holding the ids of the entries already seen, as a JSON array. */
export const SEEN_KEY = 'termag.whatsNew.seen';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

/** `day` moved by `n` days. */
export function addDays(day: string, n: number): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

/** Today where the browser is, as YYYY-MM-DD. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The Monday that starts `day`'s week. */
export function weekStart(day: string): string {
  return addDays(day, -((toDate(day).getUTCDay() + 6) % 7));
}

/**
 * One tab: the surface's entries from the last WINDOW_DAYS days, leaving out
 * one that names a flag that's off and one dated after today. `entries` is
 * already sorted (whatsNew.ts), and the order is kept.
 */
export function tabEntries(
  entries: readonly WhatsNewEntry[],
  surface: Surface,
  isOn: (flag: FlagKey) => boolean,
  today: string,
): WhatsNewEntry[] {
  const since = addDays(today, -WINDOW_DAYS);
  return entries.filter(e => e.surface === surface && e.date > since && e.date <= today && e.flags.every(isOn));
}

export interface WeekGroup {
  /** The Monday it starts. */
  start: string;
  label: string;
  entries: WhatsNewEntry[];
}

/** "This week", "Last week", then "Week of Oct 13". */
export function weekLabel(start: string, today: string): string {
  const current = weekStart(today);
  if (start === current) return 'This week';
  if (start === addDays(current, -7)) return 'Last week';
  const d = toDate(start);
  return `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Consecutive entries grouped by the week they fall in, keeping their order. */
export function groupByWeek(entries: readonly WhatsNewEntry[], today: string): WeekGroup[] {
  const groups: WeekGroup[] = [];
  for (const e of entries) {
    const start = weekStart(e.date);
    const last = groups[groups.length - 1];
    if (last?.start === start) last.entries.push(e);
    else groups.push({ start, label: weekLabel(start, today), entries: [e] });
  }
  return groups;
}

/** The seen ids stored under SEEN_KEY; anything unreadable is nothing seen. */
export function parseSeen(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * `seen` plus `ids`, as stored: only the ids of entries that still exist, in
 * order, so the list stays as small as the set of entries.
 */
export function addSeen(seen: ReadonlySet<string>, ids: readonly string[], known: readonly string[]): string {
  const next = new Set([...seen, ...ids]);
  return JSON.stringify(known.filter(id => next.has(id)));
}

export function unseenIds(entries: readonly WhatsNewEntry[], seen: ReadonlySet<string>): string[] {
  return entries.filter(e => !seen.has(e.id)).map(e => e.id);
}
