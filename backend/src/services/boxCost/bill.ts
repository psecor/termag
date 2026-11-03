/**
 * The daily Cost Explorer pull (Instrumentation step 3):
 * what the bill charged per EC2 instance per day, and the rates that divides
 * out to, so the box meter's hours are priced at what the account actually
 * pays (Savings Plan and enterprise discount included) rather than at a
 * number measured once by hand.
 *
 * Resource-level data only reaches back 14 days and a recent day stays
 * `Estimated` for a while, so each pull re-fetches every day in that window
 * that is missing, still estimated, or within the last three, and replaces
 * what it had for them.
 *
 * Cost Explorer is called with the orchestrator's own identity (the host role
 * carries ce:GetCostAndUsage*), not the box provisioner role the meter
 * assumes: reading the bill is not part of the box lifecycle. That identity
 * must be in the box account. Every call costs $0.01.
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
  type ResultByTime,
} from '@aws-sdk/client-cost-explorer';
import { prisma } from '../../db';
import { dayKey } from '../admin/range';
import { getBoxConfig } from '../boxProvisioner';

export const RESOURCE_WINDOW_DAYS = 14;
const REFRESH_DAYS = 3;
const DAY_MS = 86_400_000;
export const GP3_KEY = 'ebs:gp3';

export interface BilledRow { day: string; ec2InstanceId: string; instanceType: string; hours: number; usd: number; estimated: boolean }
export interface UsageTypeRow { day: string; usageType: string; usage: number; usd: number; estimated: boolean }
export interface RateRow { day: string; key: string; usd: number; usage: number; cost: number; estimated: boolean }

/** The instance type of a compute usage type (`USE2-BoxUsage:m9g.2xlarge`, `BoxUsage:t3.large`), or null for anything else. */
export function instanceTypeOf(usageType: string): string | null {
  const m = /(?:^|-)BoxUsage:([a-z0-9-]+\.[a-z0-9-]+)$/.exec(usageType);
  return m ? m[1] : null;
}

const isGp3 = (usageType: string) => /(?:^|-)EBS:VolumeUsage\.gp3$/.test(usageType);

/**
 * The days a pull should fetch, oldest first: every complete day in the
 * resource window that is missing, still estimated, or among the last three.
 * One contiguous range, since one call covers it.
 */
export function daysToPull(now: Date, stored: Array<{ day: string; estimated: boolean }>): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Today is never complete; the window's oldest day is 14 back from today.
  const window: string[] = [];
  for (let i = RESOURCE_WINDOW_DAYS - 1; i >= 1; i--) window.push(dayKey(new Date(today - i * DAY_MS)));
  const final = new Map(stored.map(s => [s.day, !s.estimated]));
  const recent = new Set(window.slice(-REFRESH_DAYS));
  const first = window.findIndex(d => recent.has(d) || final.get(d) !== true);
  return first < 0 ? [] : window.slice(first);
}

const amount = (m: Record<string, { Amount?: string }> | undefined, key: string) => Number(m?.[key]?.Amount ?? 0) || 0;

/** Resource-level results grouped by RESOURCE_ID and USAGE_TYPE → one row per instance, day and type. */
export function parseResourceResults(results: ResultByTime[]): BilledRow[] {
  const out = new Map<string, BilledRow>();
  for (const r of results) {
    const day = r.TimePeriod?.Start?.slice(0, 10);
    if (!day) continue;
    for (const g of r.Groups ?? []) {
      const [resource, usageType] = g.Keys ?? [];
      const instanceType = usageType ? instanceTypeOf(usageType) : null;
      if (!instanceType || !resource?.startsWith('i-')) continue;
      const key = `${resource}|${day}|${instanceType}`;
      const row = out.get(key) ?? { day, ec2InstanceId: resource, instanceType, hours: 0, usd: 0, estimated: !!r.Estimated };
      row.hours += amount(g.Metrics, 'UsageQuantity');
      row.usd += amount(g.Metrics, 'NetAmortizedCost');
      out.set(key, row);
    }
  }
  return [...out.values()].filter(r => r.hours > 0 || r.usd !== 0);
}

/** Usage-type results grouped by USAGE_TYPE → one row per day and usage type. */
export function parseUsageTypeResults(results: ResultByTime[]): UsageTypeRow[] {
  const out: UsageTypeRow[] = [];
  for (const r of results) {
    const day = r.TimePeriod?.Start?.slice(0, 10);
    if (!day) continue;
    for (const g of r.Groups ?? []) {
      const usageType = g.Keys?.[0];
      if (!usageType) continue;
      out.push({ day, usageType, usage: amount(g.Metrics, 'UsageQuantity'), usd: amount(g.Metrics, 'NetAmortizedCost'), estimated: !!r.Estimated });
    }
  }
  return out;
}

/** Per day: each instance type's cost over its hours, and gp3's cost over its GB-months. */
export function learnRates(billed: BilledRow[], usage: UsageTypeRow[]): RateRow[] {
  const acc = new Map<string, RateRow>();
  const add = (day: string, key: string, u: number, cost: number, estimated: boolean) => {
    const k = `${key}|${day}`;
    const row = acc.get(k) ?? { day, key, usd: 0, usage: 0, cost: 0, estimated };
    row.usage += u; row.cost += cost; row.estimated ||= estimated;
    acc.set(k, row);
  };
  for (const b of billed) add(b.day, b.instanceType, b.hours, b.usd, b.estimated);
  for (const u of usage) if (isGp3(u.usageType)) add(u.day, GP3_KEY, u.usage, u.usd, u.estimated);
  return [...acc.values()].filter(r => r.usage > 0).map(r => ({ ...r, usd: r.cost / r.usage }));
}

// ── AWS ──────────────────────────────────────────────────────────────────────

export interface BillDeps {
  /** [start, end) as YYYY-MM-DD; Cost Explorer's End is exclusive too. */
  fetchCompute(start: string, end: string): Promise<ResultByTime[]>;
  fetchUsageTypes(start: string, end: string): Promise<ResultByTime[]>;
}

/** Cost Explorer's only endpoint is us-east-1, whatever region the boxes are in. */
function ceClient(): CostExplorerClient {
  return new CostExplorerClient({ region: 'us-east-1' });
}

async function paged(send: (token?: string) => Promise<{ ResultsByTime?: ResultByTime[]; NextPageToken?: string }>): Promise<ResultByTime[]> {
  const out: ResultByTime[] = [];
  let token: string | undefined;
  do {
    const res = await send(token);
    out.push(...(res.ResultsByTime ?? []));
    token = res.NextPageToken;
  } while (token);
  return out;
}

const awsDeps: BillDeps = {
  fetchCompute: (start, end) => {
    const ce = ceClient();
    return paged(NextPageToken => ce.send(new GetCostAndUsageWithResourcesCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'DAILY',
      Metrics: ['NetAmortizedCost', 'UsageQuantity'],
      Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute'] } },
      GroupBy: [{ Type: 'DIMENSION', Key: 'RESOURCE_ID' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      NextPageToken,
    })));
  },
  fetchUsageTypes: (start, end) => {
    const ce = ceClient();
    return paged(NextPageToken => ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'DAILY',
      Metrics: ['NetAmortizedCost', 'UsageQuantity'],
      Filter: { Dimensions: { Key: 'SERVICE', Values: ['EC2 - Other'] } },
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      NextPageToken,
    })));
  },
};

const nextDay = (day: string) => dayKey(new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS));

/**
 * One pull. Resolves to the days it replaced (empty when nothing was due or
 * nothing came back). Each day's rows are replaced whole in one transaction,
 * so a reader never sees half a day.
 */
export async function pullBill(now = new Date(), deps: BillDeps = awsDeps): Promise<string[]> {
  const rows = await prisma.boxRate.findMany({
    where: { day: { gte: dayKey(new Date(now.getTime() - RESOURCE_WINDOW_DAYS * DAY_MS)) } },
    select: { day: true, estimated: true },
  });
  // A day is final only when none of its rates is still estimated.
  const estimated = new Map<string, boolean>();
  for (const r of rows) estimated.set(r.day, (estimated.get(r.day) ?? false) || r.estimated);
  const days = daysToPull(now, [...estimated].map(([day, e]) => ({ day, estimated: e })));
  if (!days.length) return [];
  const start = days[0], end = nextDay(days[days.length - 1]);
  const [compute, usageTypes] = await Promise.all([deps.fetchCompute(start, end), deps.fetchUsageTypes(start, end)]);
  const billed = parseResourceResults(compute);
  const rates = learnRates(billed, parseUsageTypeResults(usageTypes));
  // Replace only what Cost Explorer answered for, table by table: billed
  // instance-days for the days the compute call returned, and rates by
  // (day, key). Either call can lag the other (resource-level compute often
  // trails account-level gp3), and a day one of them returned nothing for
  // keeps its last good copy in that table.
  const billedDays = [...new Set(billed.map(r => r.day))];
  const returned = [...new Set([...billed, ...rates].map(r => r.day))].sort();
  await prisma.$transaction(async tx => {
    if (billedDays.length) await tx.boxBilledDay.deleteMany({ where: { day: { in: billedDays } } });
    if (rates.length) await tx.boxRate.deleteMany({ where: { OR: rates.map(r => ({ day: r.day, key: r.key })) } });
    if (billed.length) await tx.boxBilledDay.createMany({ data: billed });
    if (rates.length) await tx.boxRate.createMany({ data: rates });
    await tx.boxMeterState.upsert({ where: { id: 'bill' }, create: { id: 'bill', tickAt: now }, update: { tickAt: now } });
  }, { timeout: 30_000 });
  return returned;
}

/** How long a successful pull lasts, and how long a failed one waits before trying again. */
const PULL_EVERY_MS = 20 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
let lastFailureAt = 0;

/** One scheduler tick: pull when the last success is old enough and no failure is recent. */
export async function billTick(now = Date.now(), deps: BillDeps = awsDeps): Promise<string[] | null> {
  if (!getBoxConfig() || process.env.BOX_BILL_PULL === '0') return null;
  if (now - lastFailureAt < RETRY_AFTER_MS) return null;
  const state = await prisma.boxMeterState.findUnique({ where: { id: 'bill' } });
  if (state && now - state.tickAt.getTime() < PULL_EVERY_MS) return null;
  try {
    const days = await pullBill(new Date(now), deps);
    if (days.length) console.log(`[BOX-BILL] pulled ${days[0]}..${days[days.length - 1]}`);
    return days;
  } catch (err) {
    lastFailureAt = now;
    // AccessDenied until the host role carries ce:GetCostAndUsage* (example-org/terraform#28591).
    console.warn('[BOX-BILL] Cost Explorer pull failed; retrying in 6 h:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return null;
  }
}

export function resetBillFailureForTests(): void { lastFailureAt = 0; }

let billTimer: NodeJS.Timeout | null = null;
let firstTick: NodeJS.Timeout | null = null;

export function startBillPull(intervalMs = 60 * 60 * 1000): void {
  if (billTimer) return;
  const tick = () => billTick().catch(err => console.error('[BOX-BILL] tick failed:', err instanceof Error ? err.message : String(err)));
  // First look shortly after a leader starts, then hourly.
  firstTick = setTimeout(tick, 60_000);
  firstTick.unref?.();
  billTimer = setInterval(tick, intervalMs);
  billTimer.unref?.();
}

export function stopBillPull(): void {
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
  if (billTimer) { clearInterval(billTimer); billTimer = null; }
}
