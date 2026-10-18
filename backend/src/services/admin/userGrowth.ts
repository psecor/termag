/**
 * User growth for the admin surface: new users per day, week or month, and the
 * running total, from users.createdAt (the first sign-in). Buckets are UTC:
 * days, ISO weeks starting Monday, calendar months. Every bucket from the
 * window's start to the current one is present, zero-filled, and the running
 * total counts users created before the window, so it is the real headcount.
 */
import { prisma } from '../../db';
import { dayKey } from './range';

export const GROWTH_BUCKETS = ['day', 'week', 'month'] as const;
export type GrowthBucket = typeof GROWTH_BUCKETS[number];

/** Buckets returned when the caller gives no limit: about a quarter of days, a year of weeks, three years of months. */
export const GROWTH_DEFAULT_LIMIT: Record<GrowthBucket, number> = { day: 90, week: 52, month: 36 };
export const GROWTH_MAX_LIMIT = 400;

export interface GrowthRow {
  /** Bucket start: 'YYYY-MM-DD' for day and week (the Monday), 'YYYY-MM' for month. */
  key: string;
  /** Users created in the bucket. */
  new: number;
  /** Users created up to the end of the bucket. */
  total: number;
}

export interface UserGrowth {
  bucket: GrowthBucket;
  rows: GrowthRow[];
  /** Every user, all time. */
  total: number;
  /** Users created before the first returned bucket. */
  before: number;
  /** First sign-in on the orchestrator, or null with no users. */
  firstAt: string | null;
  /** New users in the current bucket (to date) and the previous full one. */
  current: number;
  previous: number;
  note: string;
}

export function isGrowthBucket(v: unknown): v is GrowthBucket {
  return typeof v === 'string' && (GROWTH_BUCKETS as readonly string[]).includes(v);
}

/** Pure: validate `?bucket=&limit=` for GET /api/admin/users/growth. Bucket defaults to week. */
export function parseGrowthQuery(q: Record<string, unknown>): { bucket: GrowthBucket; limit?: number } | { error: string } {
  const bucket = q.bucket ?? 'week';
  if (!isGrowthBucket(bucket)) return { error: `bucket must be one of ${GROWTH_BUCKETS.join(', ')}` };
  if (q.limit === undefined) return { bucket };
  const limit = typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > GROWTH_MAX_LIMIT) return { error: `limit must be an integer from 1 to ${GROWTH_MAX_LIMIT}` };
  return { bucket, limit };
}

/** Start of the UTC bucket containing `d`. */
export function bucketStart(d: Date, bucket: GrowthBucket): Date {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), bucket === 'month' ? 1 : d.getUTCDate()));
  if (bucket === 'week') s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7)); // back to Monday
  return s;
}

export function bucketKey(start: Date, bucket: GrowthBucket): string {
  return bucket === 'month' ? dayKey(start).slice(0, 7) : dayKey(start);
}

function nextBucket(start: Date, bucket: GrowthBucket): Date {
  const n = new Date(start);
  if (bucket === 'day') n.setUTCDate(n.getUTCDate() + 1);
  else if (bucket === 'week') n.setUTCDate(n.getUTCDate() + 7);
  else n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
}

/**
 * Pure: bucket sign-up times into at most `limit` buckets ending with the one
 * containing `now`, or the newest sign-up if that is later (clock skew, a
 * hand-edited row), so every user lands in a row and the line ends at the
 * headcount. With fewer buckets of history than `limit`, the series starts at
 * the first sign-up's bucket.
 */
export function growthSeries(createdAt: Date[], bucket: GrowthBucket, now: Date, limit = GROWTH_DEFAULT_LIMIT[bucket]): Omit<UserGrowth, 'note'> {
  const times = createdAt.map(d => d.getTime()).filter(t => Number.isFinite(t)).sort((a, b) => a - b);
  const total = times.length;
  if (!total) {
    const key = bucketKey(bucketStart(now, bucket), bucket);
    return { bucket, rows: [{ key, new: 0, total: 0 }], total: 0, before: 0, firstAt: null, current: 0, previous: 0 };
  }
  const last = bucketStart(new Date(Math.max(now.getTime(), times[total - 1])), bucket);

  // Walk back from the current bucket, stopping at `limit` or the first sign-up's bucket.
  const firstBucket = bucketStart(new Date(times[0]), bucket).getTime();
  const starts: Date[] = [last];
  while (starts.length < limit && starts[0].getTime() > firstBucket) {
    const prev = bucketStart(new Date(starts[0].getTime() - 1), bucket);
    starts.unshift(prev);
  }

  const windowStart = starts[0].getTime();
  let i = 0;
  while (i < times.length && times[i] < windowStart) i++;
  const before = i;
  let running = before;
  const rows: GrowthRow[] = starts.map(s => {
    const end = nextBucket(s, bucket).getTime();
    let n = 0;
    while (i < times.length && times[i] < end) { n++; i++; }
    running += n;
    return { key: bucketKey(s, bucket), new: n, total: running };
  });

  // The previous full bucket, even when the window is a single bucket.
  const prevStart = bucketStart(new Date(last.getTime() - 1), bucket).getTime();
  const previous = times.filter(t => t >= prevStart && t < last.getTime()).length;
  return { bucket, rows, total, before, firstAt: new Date(times[0]).toISOString(), current: rows[rows.length - 1].new, previous };
}

export async function userGrowth(bucket: GrowthBucket, limit?: number): Promise<UserGrowth> {
  const users = await prisma.user.findMany({ select: { createdAt: true } });
  const capped = limit == null ? undefined : Math.max(1, Math.min(GROWTH_MAX_LIMIT, Math.floor(limit)));
  return {
    ...growthSeries(users.map(u => u.createdAt), bucket, new Date(), capped),
    note: 'New users are counted by users.createdAt, the first sign-in on this orchestrator. Buckets are UTC; weeks start on Monday. The current bucket is to date.',
  };
}
