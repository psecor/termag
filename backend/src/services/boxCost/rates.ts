/**
 * What a metered box hour costs. Pure.
 *
 * The rates are what the bill actually charged, not list prices: compute is
 * almost all under a Savings Plan plus the enterprise discount, about 40% of
 * on demand, and that ratio moves when the plan is renewed. Until the daily
 * Cost Explorer pull (phase 3) learns them, these are the October 2026 bill's.
 */

export const HOURS_PER_MONTH = 730;

export interface BoxRates {
  /** Where the numbers came from, shown beside them. */
  source: string;
  /** Net amortized $ per running hour, by EC2 instance type. */
  perHour: Record<string, number>;
  /** $ per vCPU-hour for a type with no rate of its own. */
  perVcpuHour: number;
  /** gp3 $ per GB-month. */
  gp3PerGbMonth: number;
}

/** Cost Explorer net amortized cost ÷ usage, Termag account us-east-2, 2026-10-01..25. */
export const DEFAULT_RATES: BoxRates = {
  source: 'Cost Explorer net amortized, us-east-2, 2026-10-01 to 10-25',
  perHour: {
    'm9g.2xlarge': 0.15902,
    'm9g.4xlarge': 0.31801,
    'm8g.2xlarge': 0.14567,
    'm8g.4xlarge': 0.29134,
    't4g.medium': 0.01336,
  },
  perVcpuHour: 0.01988, // m9g.2xlarge / 8
  gp3PerGbMonth: 0.0656,
};

const SIZE_VCPUS: Record<string, number> = { nano: 2, micro: 2, small: 2, medium: 1, large: 2, xlarge: 4 };

/**
 * vCPUs of a type from its name: `large` 2, `xlarge` 4, `<n>xlarge` 4n, and
 * `medium` 1 except on burstable (t*) types, where every size up to large has 2.
 * Null for a name this does not recognise (`metal`, a malformed string).
 */
export function vcpusFor(instanceType: string): number | null {
  const [family, size] = instanceType.split('.');
  if (!family || !size) return null;
  const n = /^(\d+)xlarge$/.exec(size);
  if (n) return Number(n[1]) * 4;
  if (family.startsWith('t') && size !== 'xlarge') return 2;
  return SIZE_VCPUS[size] ?? null;
}

/** $ per running hour for a type: its own rate, else by vCPU, else 0 (and `known` false). */
export function hourlyRate(instanceType: string, rates: BoxRates = DEFAULT_RATES): { usd: number; known: boolean } {
  const own = rates.perHour[instanceType];
  if (own !== undefined) return { usd: own, known: true };
  const vcpus = vcpusFor(instanceType);
  return vcpus === null ? { usd: 0, known: false } : { usd: vcpus * rates.perVcpuHour, known: true };
}

export interface MeteredUsage {
  instanceType: string;
  activeSec: number;
  idleSec: number;
  poolSec: number;
  bootSec: number;
  orphanSec: number;
  storageGbSec: number;
}

export interface UsageCost {
  /** Compute $ by slice, and their total. */
  active: number;
  idle: number;
  pool: number;
  boot: number;
  orphan: number;
  compute: number;
  storage: number;
  total: number;
  /** False when the type had no rate and its compute counted as $0. */
  rated: boolean;
}

export function usageCost(u: MeteredUsage, rates: BoxRates = DEFAULT_RATES): UsageCost {
  const { usd, known } = hourlyRate(u.instanceType, rates);
  const $ = (sec: number) => (sec / 3600) * usd;
  const active = $(u.activeSec), idle = $(u.idleSec), pool = $(u.poolSec), boot = $(u.bootSec), orphan = $(u.orphanSec);
  const compute = active + idle + pool + boot + orphan;
  const storage = (u.storageGbSec / (3600 * HOURS_PER_MONTH)) * rates.gp3PerGbMonth;
  return { active, idle, pool, boot, orphan, compute, storage, total: compute + storage, rated: known };
}

/** A rate one day of the bill gave (box_rates): an instance type's $/h, or `ebs:gp3`'s $/GB-month. */
export interface LearnedRate { day: string; key: string; usd: number }

export const GP3_RATE_KEY = 'ebs:gp3';

/**
 * The rates for each day: `base` overlaid with the latest learned rate on or
 * before that day, per key. A day the bill has not reached yet (today, the
 * pull's lag) carries the last one forward; a day before any bill keeps base.
 */
export function ratesByDay(days: string[], learned: LearnedRate[], base: BoxRates = DEFAULT_RATES): Map<string, BoxRates> {
  const sorted = [...learned].sort((a, b) => a.day.localeCompare(b.day));
  const out = new Map<string, BoxRates>();
  let i = 0;
  const perHour = { ...base.perHour };
  let gp3 = base.gp3PerGbMonth;
  let through: string | null = null;
  for (const day of [...days].sort()) {
    for (; i < sorted.length && sorted[i].day <= day; i++) {
      const r = sorted[i];
      if (r.key === GP3_RATE_KEY) gp3 = r.usd; else perHour[r.key] = r.usd;
      through = r.day;
    }
    out.set(day, {
      ...base,
      perHour: { ...perHour },
      gp3PerGbMonth: gp3,
      source: through ? `Cost Explorer net amortized, through ${through}` : base.source,
    });
  }
  return out;
}
