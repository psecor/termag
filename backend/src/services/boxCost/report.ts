/**
 * The admin Boxes report (Instrumentation step 5): the
 * meter's hours in a window, priced at ./rates.ts. The REST route
 * (routes/admin/spend.ts) and the MCP tool both call boxCostReport.
 *
 * aggregateBoxCost is pure; the query only sums box_usage_hours by day, box
 * and owner, reads the rates and bill the Cost Explorer pull stored
 * (./bill.ts), and looks up names. Each day is priced at its own rates.
 */
import { prisma } from '../../db';
import type { Range } from '../admin/range';
import { DEFAULT_RATES, ratesByDay, usageCost, type BoxRates, type MeteredUsage, type UsageCost } from './rates';
import { reconcile, type BilledDay, type MeteredDay, type Reconcile } from './reconcile';

/** One day of one box under one owner and type, as summed from box_usage_hours. */
export interface UsageDayRow extends MeteredUsage {
  day: string;
  ec2InstanceId: string;
  instanceId: string | null;
  userId: string | null;
  /** volumeGb of the box's latest hour that day. */
  volumeGb: number;
  /** Start of the latest hour metered that day. */
  lastHour: Date;
}

export interface BoxInfo { name: string; status: string; ownerName: string | null; terminatedAt: Date | null }

type Money = Omit<UsageCost, 'rated'>;
const ZERO: Money = { active: 0, idle: 0, pool: 0, boot: 0, orphan: 0, compute: 0, storage: 0, total: 0 };
const add = (a: Money, b: Money): Money => ({
  active: a.active + b.active, idle: a.idle + b.idle, pool: a.pool + b.pool, boot: a.boot + b.boot, orphan: a.orphan + b.orphan,
  compute: a.compute + b.compute, storage: a.storage + b.storage, total: a.total + b.total,
});
const runningSec = (u: MeteredUsage) => u.activeSec + u.idleSec + u.poolSec + u.bootSec + u.orphanSec;

export interface BoxCostBox {
  ec2InstanceId: string;
  instanceId: string | null;
  /** Null for a box with no Instance row (an orphan). */
  name: string | null;
  status: string | null;
  owner: string | null;
  instanceType: string;
  volumeGb: number;
  runningHours: number;
  /** Of the owned running hours, the share that was active; null with none. */
  activeShare: number | null;
  /** termag terminated it and the meter still saw it an hour or more later: a teardown that didn't finish. */
  teardownUnfinished: boolean;
  usd: Money;
}

export interface BoxCostPerson {
  userId: string;
  name: string;
  boxes: number;
  runningHours: number;
  activeShare: number | null;
  usd: Money;
}

export interface BoxCostReport {
  window: { since: string; until: string };
  /** First hour the meter has in the window; null when it has nothing yet. */
  meteredFrom: string | null;
  rates: { source: string; perHour: Record<string, number>; gp3PerGbMonth: number };
  totals: Money & { runningHours: number; boxes: number };
  days: Array<{ day: string } & Money>;
  people: BoxCostPerson[];
  boxes: BoxCostBox[];
  /** Boxes stopped or hibernated now: their volumes cost this every month while they stay so. */
  parked: { boxes: number; gb: number; monthlyUsd: number };
  /** Types priced at $0 for want of a rate. */
  unrated: string[];
  /** Metered against billed on the whole days both cover; null before the first such day. */
  reconcile: Reconcile | null;
}

const PARKED = new Set(['stopped', 'hibernated']);
const shareOf = (active: number, owned: number) => (owned > 0 ? active / owned : null);

export function aggregateBoxCost(input: {
  range: Pick<Range, 'keys' | 'sinceKey' | 'untilKey'>;
  rows: UsageDayRow[];
  boxes: Map<string, BoxInfo>;
  users: Map<string, string>;
  meteredFrom: Date | null;
  /** Each day's rates (rates.ts ratesByDay); a day missing from it gets DEFAULT_RATES. */
  rates?: Map<string, BoxRates>;
  billed?: BilledDay[];
  /** The meter's first hour ever, which bounds what reconcile can compare. */
  meterStartedAt?: Date | null;
  now?: Date;
}): BoxCostReport {
  const ratesFor = (day: string) => input.rates?.get(day) ?? DEFAULT_RATES;
  // What the window ends on: the rates shown, and what parked boxes are priced at.
  const rates = ratesFor(input.range.untilKey);
  const meteredDays: MeteredDay[] = [];
  const days = new Map(input.range.keys.map(k => [k, { ...ZERO }]));
  const unrated = new Set<string>();

  interface BoxAcc { box: BoxCostBox; activeSec: number; ownedSec: number; latestDay: string; lastHour: number }
  const boxes = new Map<string, BoxAcc>();
  interface PersonAcc { usd: Money; boxes: Set<string>; runningSec: number; activeSec: number; ownedSec: number }
  const people = new Map<string, PersonAcc>();
  let totals = { ...ZERO }, totalRunning = 0;

  for (const r of input.rows) {
    const c = usageCost(r, ratesFor(r.day));
    if (!c.rated) unrated.add(r.instanceType);
    const money: Money = { ...c };
    delete (money as Partial<UsageCost>).rated;
    const run = runningSec(r);
    const owned = r.activeSec + r.idleSec + r.bootSec;
    totals = add(totals, money); totalRunning += run;
    const d = days.get(r.day); if (d) days.set(r.day, add(d, money));

    const info = r.instanceId ? input.boxes.get(r.instanceId) : undefined;
    meteredDays.push({ day: r.day, ec2InstanceId: r.ec2InstanceId, name: info?.name ?? null, instanceType: r.instanceType, runningSec: run, computeUsd: c.compute });
    let b = boxes.get(r.ec2InstanceId);
    if (!b) {
      b = { box: {
        ec2InstanceId: r.ec2InstanceId, instanceId: r.instanceId, name: info?.name ?? null, status: info?.status ?? null,
        owner: info?.ownerName ?? null, instanceType: r.instanceType, volumeGb: r.volumeGb, runningHours: 0, activeShare: null, teardownUnfinished: false, usd: { ...ZERO },
      }, activeSec: 0, ownedSec: 0, latestDay: r.day, lastHour: 0 };
      boxes.set(r.ec2InstanceId, b);
    }
    b.box.usd = add(b.box.usd, money);
    b.box.runningHours += run / 3600;
    b.activeSec += r.activeSec; b.ownedSec += owned;
    b.lastHour = Math.max(b.lastHour, r.lastHour.getTime());
    // Identity follows the latest day, whatever order the rows came in; on the
    // same day a row that points at a termag box beats one that doesn't.
    if (r.day > b.latestDay || (r.day === b.latestDay && info && !b.box.name)) {
      b.latestDay = r.day;
      Object.assign(b.box, {
        instanceId: r.instanceId, name: info?.name ?? null, status: info?.status ?? null, owner: info?.ownerName ?? null,
        instanceType: r.instanceType, volumeGb: r.volumeGb,
      });
    }

    if (r.userId) {
      // Only what the person owned: never pool or orphan time, whatever row it shares.
      const ownedCompute = money.active + money.idle + money.boot;
      const theirs: Money = { ...money, pool: 0, orphan: 0, compute: ownedCompute, total: ownedCompute + money.storage };
      const p = people.get(r.userId) ?? { usd: { ...ZERO }, boxes: new Set<string>(), runningSec: 0, activeSec: 0, ownedSec: 0 };
      people.set(r.userId, p);
      p.usd = add(p.usd, theirs); p.boxes.add(r.ec2InstanceId);
      p.runningSec += owned; p.activeSec += r.activeSec; p.ownedSec += owned;
    }
  }

  const boxList = [...boxes.values()].map(b => {
    const ended = b.box.instanceId ? input.boxes.get(b.box.instanceId)?.terminatedAt : null;
    // The hour a box was terminated in is still its own; one that starts an hour after is EC2 keeping it.
    const lingering = b.box.status === 'terminated' && !!ended && b.lastHour >= ended.getTime() + 3_600_000;
    return { ...b.box, activeShare: shareOf(b.activeSec, b.ownedSec), teardownUnfinished: lingering };
  });
  const parkedBoxes = boxList.filter(b => b.status && PARKED.has(b.status));
  const parkedGb = parkedBoxes.reduce((s, b) => s + b.volumeGb, 0);
  return {
    window: { since: input.range.sinceKey, until: input.range.untilKey },
    meteredFrom: input.meteredFrom?.toISOString() ?? null,
    rates: { source: rates.source, perHour: rates.perHour, gp3PerGbMonth: rates.gp3PerGbMonth },
    totals: { ...totals, runningHours: totalRunning / 3600, boxes: boxes.size },
    days: [...days.entries()].map(([day, m]) => ({ day, ...m })),
    people: [...people.entries()].map(([userId, p]) => ({
      userId, name: input.users.get(userId) ?? userId, boxes: p.boxes.size,
      runningHours: p.runningSec / 3600, activeShare: shareOf(p.activeSec, p.ownedSec), usd: p.usd,
    })).sort((a, b) => b.usd.total - a.usd.total),
    boxes: boxList.sort((a, b) => b.usd.total - a.usd.total),
    parked: { boxes: parkedBoxes.length, gb: parkedGb, monthlyUsd: parkedGb * rates.gp3PerGbMonth },
    unrated: [...unrated].sort(),
    reconcile: reconcile({ billed: input.billed ?? [], metered: meteredDays, meterStartedAt: input.meterStartedAt ?? null, now: input.now ?? new Date() }),
  };
}

export async function boxCostReport(range: Range): Promise<BoxCostReport> {
  const raw = await prisma.$queryRaw<Array<{
    day: string; ec2InstanceId: string; instanceId: string | null; userId: string | null; instanceType: string; volumeGb: number; lastHour: Date;
    activeSec: number; idleSec: number; poolSec: number; bootSec: number; orphanSec: number; storageGbSec: number;
  }>>`
    SELECT to_char(h."hour" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, h."ec2InstanceId", h."instanceId", h."userId", h."instanceType",
           (array_agg(h."volumeGb" ORDER BY h."hour" DESC))[1] AS "volumeGb", MAX(h."hour") AS "lastHour",
           SUM(h."activeSec")::float8 AS "activeSec", SUM(h."idleSec")::float8 AS "idleSec", SUM(h."poolSec")::float8 AS "poolSec",
           SUM(h."bootSec")::float8 AS "bootSec", SUM(h."orphanSec")::float8 AS "orphanSec", SUM(h."storageGbSec")::float8 AS "storageGbSec"
    FROM box_usage_hours h
    WHERE h."hour" >= ${range.sinceTs} AND h."hour" < ${range.untilTs}
    GROUP BY 1, h."ec2InstanceId", h."instanceId", h."userId", h."instanceType"`;
  const rows: UsageDayRow[] = raw.map(r => ({
    ...r, volumeGb: Number(r.volumeGb), activeSec: Number(r.activeSec), idleSec: Number(r.idleSec), poolSec: Number(r.poolSec),
    bootSec: Number(r.bootSec), orphanSec: Number(r.orphanSec), storageGbSec: Number(r.storageGbSec),
  }));
  const instanceIds = [...new Set(rows.map(r => r.instanceId).filter((id): id is string => !!id))];
  const userIds = [...new Set(rows.map(r => r.userId).filter((id): id is string => !!id))];
  const [instances, users, first, started, learned, billed] = await Promise.all([
    prisma.instance.findMany({ where: { id: { in: instanceIds } }, select: { id: true, name: true, status: true, terminatedAt: true, user: { select: { unixUsername: true } } } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, unixUsername: true } }),
    prisma.boxUsageHour.findFirst({ where: { hour: { gte: range.sinceTs, lt: range.untilTs } }, orderBy: { hour: 'asc' }, select: { hour: true } }),
    prisma.boxUsageHour.findFirst({ orderBy: { hour: 'asc' }, select: { hour: true } }),
    // Every learned rate up to the window's end: the latest before it carries into the window.
    prisma.boxRate.findMany({ where: { day: { lte: range.untilKey } }, select: { day: true, key: true, usd: true } }),
    prisma.boxBilledDay.findMany({
      where: { day: { gte: range.sinceKey, lte: range.untilKey } },
      select: { day: true, ec2InstanceId: true, instanceType: true, hours: true, usd: true, estimated: true },
    }),
  ]);
  return aggregateBoxCost({
    range, rows,
    boxes: new Map(instances.map(i => [i.id, { name: i.name, status: i.status, ownerName: i.user?.unixUsername ?? null, terminatedAt: i.terminatedAt }])),
    users: new Map(users.map(u => [u.id, u.unixUsername])),
    meteredFrom: first?.hour ?? null,
    rates: ratesByDay(range.keys, learned),
    billed,
    meterStartedAt: started?.hour ?? null,
  });
}
