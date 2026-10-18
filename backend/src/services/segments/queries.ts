/**
 * Read queries for the admin Segments tab. All read
 * the precomputed user_segment_daily rows the tracker writes daily; nothing
 * here touches GitHub or the terminal.
 */
import { prisma } from '../../db';
import { segmentTrackerStatus as trackerStatus, segmentTrackerTick } from './tracker';

export interface SegmentDay {
  date: string;
  counts: { segment: string; n: number }[];
  total: number;
}

/** Daily bucket counts for the last `days` days (default 30, max 400). */
export async function segmentHistory(days: number): Promise<{ days: SegmentDay[]; segments: string[] }> {
  const rows = await prisma.userSegmentDaily.groupBy({
    by: ['date', 'segment'],
    _count: { _all: true },
    // dateAdd goes BACKWARD from now; segmentHistory receives a positive span.
    where: { date: { gte: dateAdd(days) } },
    orderBy: [{ date: 'asc' }, { segment: 'asc' }],
  });
  const byDay = new Map<string, SegmentDay>();
  const segments = new Set<string>();
  for (const r of rows) {
    let day = byDay.get(r.date);
    if (!day) byDay.set(r.date, day = { date: r.date, counts: [], total: 0 });
    const n = r._count._all;
    day.counts.push({ segment: r.segment, n });
    day.total += n;
    segments.add(r.segment);
  }
  return { days: [...byDay.values()], segments: [...segments].sort() };
}

function dateAdd(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** One day's per-user segments (with usernames for the UI list). */
export async function segmentUsers(day: string): Promise<Array<{ userId: string; username: string | null; segment: string }>> {
  const rows = await prisma.userSegmentDaily.findMany({
    where: { date: day },
    include: { user: { select: { unixUsername: true, role: true } } },
    orderBy: { segment: 'asc' },
  });
  return rows.map(r => ({
    userId: r.userId,
    username: r.user.unixUsername,
    segment: r.segment,
  }));
}

/** 7-day flows between segments since the earliest row (per user, day N -> N+7). */
export async function segmentTransitions(): Promise<{ first: string; last: string; flows: Array<{ from: string; to: string; n: number }> }> {
  const rows = await prisma.userSegmentDaily.findMany({
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
    select: { userId: true, date: true, segment: true },
  });
  const byUser = new Map<string, Array<{ date: string; segment: string }>>();
  for (const r of rows) {
    let l = byUser.get(r.userId);
    if (!l) byUser.set(r.userId, l = []);
    l.push({ date: r.date, segment: r.segment });
  }
  const counts = new Map<string, number>();
  let first = '', last = '';
  for (const l of byUser.values()) {
    const byDate = new Map(l.map(x => [x.date, x.segment]));
    for (const { date } of l) {
      const d7 = new Date(Date.parse(date + 'T00:00:00Z') + 7 * 86_400_000).toISOString().slice(0, 10);
      const a = byDate.get(date), b = byDate.get(d7);
      if (a && b && a !== b) counts.set(`${a}->${b}`, (counts.get(`${a}->${b}`) ?? 0) + 1);
      if (!first || date < first) first = date;
      if (date > last) last = date;
    }
  }
  return {
    first, last,
    flows: [...counts].map(([k, n]) => {
      const [from, to] = k.split('->');
      return { from, to, n };
    }).sort((a, b) => b.n - a.n),
  };
}

/** Status + manual/rebuild path, both thin over the tracker module. */
export { trackerStatus, segmentTrackerTick };

/** Migration date of the first tracked day — the tab's subheader. */
export async function segmentSpan(): Promise<{ from: string; to: string; users: number }> {
  const agg = await prisma.userSegmentDaily.aggregate({
    _min: { date: true }, _max: { date: true },
    _count: { _all: true },
  });
  const users = await prisma.userSegmentDaily.findMany({ select: { userId: true }, distinct: ['userId'] });
  return { from: agg._min.date ?? '', to: agg._max.date ?? '', users: users.length };
}
