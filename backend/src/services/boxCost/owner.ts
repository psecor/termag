/**
 * What one owner's boxes cost today, for the desktop app's
 * box card through the CLI API: the meter's hours since the start of the UTC
 * day, priced at ./rates.ts, and each box's rate per running hour at its type
 * now. Only the owner's own time counts, never a box's warm-pool hours before
 * its claim, as the admin report's people do.
 *
 * ownerBoxCosts is pure; ownerBoxCostToday reads the rows.
 */
import { prisma } from '../../db';
import { dayKey } from '../admin/range';
import { DEFAULT_RATES, hourlyRate, usageCost, type BoxRates } from './rates';

export interface OwnerBoxCost {
  id: string;
  /** Compute while it was the owner's, and its volumes, since the start of the UTC day. */
  todayUsd: number;
  runningHours: number;
  /** Of its running hours today, the share nothing happened on it; null with none. */
  idleShare: number | null;
  /** What an hour running costs at its type now; null for a type with no rate. */
  perHourUsd: number | null;
}

export interface OwnerHourRow {
  instanceId: string | null;
  instanceType: string;
  activeSec: number;
  idleSec: number;
  bootSec: number;
  storageGbSec: number;
}

export function ownerBoxCosts(
  boxes: ReadonlyArray<{ id: string; instanceType: string | null }>,
  hours: ReadonlyArray<OwnerHourRow>,
  rates: BoxRates = DEFAULT_RATES,
): OwnerBoxCost[] {
  return boxes.map(box => {
    let usd = 0, active = 0, idle = 0, boot = 0;
    for (const h of hours) {
      if (h.instanceId !== box.id) continue;
      const c = usageCost({ ...h, poolSec: 0, orphanSec: 0 }, rates);
      usd += c.active + c.idle + c.boot + c.storage;
      active += h.activeSec; idle += h.idleSec; boot += h.bootSec;
    }
    const running = active + idle + boot;
    const rate = box.instanceType ? hourlyRate(box.instanceType, rates) : null;
    return {
      id: box.id,
      todayUsd: usd,
      runningHours: running / 3600,
      idleShare: running > 0 ? idle / running : null,
      perHourUsd: rate?.known ? rate.usd : null,
    };
  });
}

/** The owner's live boxes, priced for today: `day` is the UTC day key the hours are from. */
export async function ownerBoxCostToday(userId: string, now: Date = new Date()): Promise<{
  day: string;
  source: string;
  boxes: OwnerBoxCost[];
}> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [boxes, hours] = await Promise.all([
    prisma.instance.findMany({
      where: { userId, status: { not: 'terminated' } },
      select: { id: true, instanceType: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.boxUsageHour.findMany({
      where: { userId, hour: { gte: since } },
      select: { instanceId: true, instanceType: true, activeSec: true, idleSec: true, bootSec: true, storageGbSec: true },
    }),
  ]);
  return { day: dayKey(since), source: DEFAULT_RATES.source, boxes: ownerBoxCosts(boxes, hours) };
}
