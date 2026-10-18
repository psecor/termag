/**
 * Time-range parsing for the admin API and MCP tools. Pure.
 *
 * `range` is `today | 7d | 30d` (the dashboard's picker) or an explicit
 * `from`/`to` pair of YYYY-MM-DD keys (inclusive). Day keys are UTC, matching
 * token_usage_days / project_visits / warp_samples. work_time_entries dates
 * are server-local: for a range that reaches today, `worktimeKeys` adds the
 * server-local today key when it differs from the UTC one (the dashboard's
 * `todayDates()` straddle), and nothing else — so totals cover the labelled
 * range, not N+1 days. On a UTC orchestrator the two key sets are identical.
 */
export type RangeId = 'today' | '7d' | '30d';

export interface Range {
  id: RangeId | 'custom';
  /** Inclusive UTC day keys, oldest first. */
  keys: string[];
  sinceKey: string;
  untilKey: string;
  /** Start of sinceKey, UTC, for timestamp columns. */
  sinceTs: Date;
  /** Exclusive end (start of the day after untilKey), UTC. */
  untilTs: Date;
  days: number;
  /** Keys for server-local work_time_entries: `keys` plus the local-today straddle when the range reaches today. */
  worktimeKeys: string[];
  worktimeSinceKey: string;
  worktimeUntilKey: string;
  /** The same-length period immediately before, for deltas. */
  priorKeys: string[];
}

export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function keyToDate(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || dayKey(d) !== key ? null : d;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function keysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) out.push(dayKey(d));
  return out;
}

export const MAX_RANGE_DAYS = 400;

export function parseRange(
  q: { range?: unknown; from?: unknown; to?: unknown },
  now: Date = new Date(),
): Range | { error: string } {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let from: Date; let to: Date; let id: Range['id'];

  if (typeof q.from === 'string' || typeof q.to === 'string') {
    const f = typeof q.from === 'string' ? keyToDate(q.from) : null;
    const t = typeof q.to === 'string' ? keyToDate(q.to) : todayStart;
    if (!f || !t) return { error: 'from/to must be YYYY-MM-DD' };
    if (t.getTime() < f.getTime()) return { error: 'to must not precede from' };
    if ((t.getTime() - f.getTime()) / 86_400_000 + 1 > MAX_RANGE_DAYS) return { error: `range may not exceed ${MAX_RANGE_DAYS} days` };
    from = f; to = t; id = 'custom';
  } else {
    const r = (typeof q.range === 'string' ? q.range : '7d') as RangeId;
    if (!['today', '7d', '30d'].includes(r)) return { error: 'range must be today, 7d or 30d' };
    const n = r === 'today' ? 1 : r === '7d' ? 7 : 30;
    to = todayStart; from = addDays(todayStart, -(n - 1)); id = r;
  }

  const keys = keysBetween(from, to);
  const priorKeys = keysBetween(addDays(from, -keys.length), addDays(from, -1));
  const worktimeKeys = [...keys];
  if (keys[keys.length - 1] === dayKey(todayStart)) {
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (!worktimeKeys.includes(localToday)) worktimeKeys.push(localToday);
    worktimeKeys.sort();
  }
  return {
    id, keys, sinceKey: keys[0], untilKey: keys[keys.length - 1],
    sinceTs: from, untilTs: addDays(to, 1), days: keys.length,
    worktimeKeys, worktimeSinceKey: worktimeKeys[0], worktimeUntilKey: worktimeKeys[worktimeKeys.length - 1],
    priorKeys,
  };
}

/** Zero-fill a per-day series over the range's keys. */
export function fillDays<T>(keys: string[], byKey: Map<string, T>, empty: () => T): Array<{ date: string } & T> {
  return keys.map(date => ({ date, ...(byKey.get(date) ?? empty()) }));
}
