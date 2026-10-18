import type { GrowthBucket, UserGrowth } from '../../services/adminApi';
import { shortDate } from '../dashboard/range';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Axis label for a growth bucket key: "Oct 5" for a day or a week's Monday, "Oct 2026" for a month. */
export function growthLabel(key: string, bucket: GrowthBucket): string {
  if (bucket !== 'month') return shortDate(key);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : key;
}

/** What "this bucket" reads as in prose. */
export const BUCKET_NOUN: Record<GrowthBucket, string> = { day: 'today', week: 'this week', month: 'this month' };
export const PREVIOUS_NOUN: Record<GrowthBucket, string> = { day: 'yesterday', week: 'last week', month: 'last month' };

/**
 * What the chart covers: "since the first sign-in" when every user falls in
 * the window, else "last 90 days" (the running total still counts everyone).
 */
export function growthSpan(g: Pick<UserGrowth, 'bucket' | 'rows' | 'before'>): string {
  return g.before > 0 ? `last ${g.rows.length} ${g.bucket}${g.rows.length === 1 ? '' : 's'}` : 'since the first sign-in';
}

/**
 * Chart rows labelled by the bucket the response carries, not the picker, so
 * the previous response stays readable while a new bucket size loads.
 */
export function growthRows(g: UserGrowth | null) {
  return (g?.rows ?? []).map(r => ({ ...r, label: growthLabel(r.key, g!.bucket) }));
}
