import { lastNDaysUTC, previousNDaysUTC, todayDates, utcToday } from '../../utils/dates';

export type Range = 'today' | '7d' | '30d';
export const RANGES: Array<{ id: Range; label: string }> = [
  { id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' },
];

export interface RangeKeys {
  /** UTC day keys for tokens / visits / warp / context. */
  utc: string[];
  /** Prior period of the same length (for deltas); for Today, the trailing 14 UTC days. */
  priorUtc: string[];
  /** Keys for worktime (server-local dates) — Today merges local+UTC. */
  worktime: string[];
  priorWorktime: string[];
  isToday: boolean;
  label: string;
}

export function rangeKeys(range: Range): RangeKeys {
  if (range === 'today') {
    return {
      utc: [utcToday()], priorUtc: previousNDaysUTC(14, 1),
      worktime: todayDates(), priorWorktime: previousNDaysUTC(14, 1),
      isToday: true, label: 'today',
    };
  }
  const n = range === '7d' ? 7 : 30;
  const utc = lastNDaysUTC(n);
  const prior = previousNDaysUTC(n, n);
  return { utc, priorUtc: prior, worktime: utc, priorWorktime: prior, isToday: false, label: `last ${n} days` };
}

/** "Sep 18" style tick from a 'YYYY-MM-DD' key, without timezone drift. */
export function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${d}`;
}
