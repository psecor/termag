/**
 * Metered against billed (Instrumentation step 4). Pure.
 *
 * Only whole days the meter covered and the bill has settled are compared: a
 * day the meter started in would show every box as under-metered, and a day
 * Cost Explorer has only partly billed every box as over-metered. Hours are the honest comparison,
 * since the metered dollars are priced from the same bill; dollars are shown
 * beside them.
 */
import { dayKey } from '../admin/range';

export interface BilledDay { day: string; ec2InstanceId: string; instanceType: string; hours: number; usd: number; estimated: boolean }
export interface MeteredDay { day: string; ec2InstanceId: string; name: string | null; instanceType: string; runningSec: number; computeUsd: number }

export interface ReconcileLine {
  ec2InstanceId: string;
  /** The termag box name, when the meter knows the instance and termag has a row. */
  name: string | null;
  instanceType: string | null;
  meteredHours: number;
  billedHours: number;
  meteredUsd: number;
  billedUsd: number;
}

export interface Reconcile {
  /** The days compared, oldest first. */
  days: string[];
  /** Of them, days Cost Explorer still marks estimated. */
  estimatedDays: number;
  meteredHours: number;
  billedHours: number;
  meteredUsd: number;
  /** Billed compute of the instances the meter saw. */
  billedUsd: number;
  /** Billed, never metered: not a box (the orchestrator, image builders), or a box the meter missed. */
  notMetered: ReconcileLine[];
  notMeteredUsd: number;
  /** Metered running, never billed. */
  notBilled: ReconcileLine[];
  /** Seen by both, hours apart by more than the tolerance. */
  drift: ReconcileLine[];
}

/** Hours apart before a box is listed: half an hour, or 5% of what was billed. */
export const driftTolerance = (billedHours: number) => Math.max(0.5, 0.05 * billedHours);

/**
 * The first day the meter covered whole: the day after it started. Its first
 * row's hour is aligned to the hour, so a start inside 00:00-00:59 looks like
 * midnight; the start day is never taken as whole.
 */
export function firstWholeDay(meterStartedAt: Date): string {
  return dayKey(new Date(meterStartedAt.getTime() + 86_400_000));
}

/**
 * The newest day the bill has settled enough to compare: two days before
 * today. Cost Explorer lags and refreshes about daily, so yesterday is
 * usually only partly billed when it is pulled, which reads as boxes metered
 * above their bill and fresh boxes "not billed".
 */
export function lastSettledDay(now: Date): string {
  return dayKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 2 * 86_400_000));
}

export function reconcile(input: { billed: BilledDay[]; metered: MeteredDay[]; meterStartedAt: Date | null; now: Date }): Reconcile | null {
  if (!input.meterStartedAt) return null;
  const from = firstWholeDay(input.meterStartedAt);
  const until = lastSettledDay(input.now);
  const billed = input.billed.filter(b => b.day >= from && b.day <= until);
  const days = [...new Set(billed.map(b => b.day))].sort();
  if (!days.length) return null;
  const compared = new Set(days);
  const estimatedDays = new Set(billed.filter(b => b.estimated).map(b => b.day)).size;

  const lines = new Map<string, ReconcileLine & { metered: boolean; isBilled: boolean }>();
  const line = (id: string) => {
    let l = lines.get(id);
    if (!l) {
      l = { ec2InstanceId: id, name: null, instanceType: null, meteredHours: 0, billedHours: 0, meteredUsd: 0, billedUsd: 0, metered: false, isBilled: false };
      lines.set(id, l);
    }
    return l;
  };
  for (const b of billed) {
    const l = line(b.ec2InstanceId);
    l.isBilled = true; l.billedHours += b.hours; l.billedUsd += b.usd; l.instanceType = b.instanceType;
  }
  for (const m of input.metered) {
    if (!compared.has(m.day)) continue;
    const l = line(m.ec2InstanceId);
    l.metered = true; l.meteredHours += m.runningSec / 3600; l.meteredUsd += m.computeUsd; l.name ??= m.name;
    // The bill's type wins when there is one; a box with no bill keeps the meter's.
    l.instanceType ??= m.instanceType;
  }

  const strip = ({ metered: _m, isBilled: _b, ...l }: ReconcileLine & { metered: boolean; isBilled: boolean }): ReconcileLine => l;
  const all = [...lines.values()];
  const both = all.filter(l => l.metered);
  const notMetered = all.filter(l => !l.metered).map(strip).sort((a, b) => b.billedUsd - a.billedUsd);
  return {
    days,
    estimatedDays,
    meteredHours: both.reduce((s, l) => s + l.meteredHours, 0),
    billedHours: both.reduce((s, l) => s + l.billedHours, 0),
    meteredUsd: both.reduce((s, l) => s + l.meteredUsd, 0),
    billedUsd: both.reduce((s, l) => s + l.billedUsd, 0),
    notMetered,
    notMeteredUsd: notMetered.reduce((s, l) => s + l.billedUsd, 0),
    notBilled: both.filter(l => !l.isBilled && l.meteredHours > 0).map(strip).sort((a, b) => b.meteredHours - a.meteredHours),
    drift: both.filter(l => l.isBilled && Math.abs(l.meteredHours - l.billedHours) > driftTolerance(l.billedHours))
      .map(strip).sort((a, b) => Math.abs(b.meteredHours - b.billedHours) - Math.abs(a.meteredHours - a.billedHours)),
  };
}
