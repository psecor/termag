/**
 * The box meter (Instrumentation step 2): every few minutes,
 * ask EC2 for every termag box and add the span since the last tick to each
 * box's row in `box_usage_hours`.
 *
 * EC2's state is the truth, not `Instance.status`: a box is billed for compute
 * while EC2 says `running` and for its volumes until EC2 says `terminated`.
 * The row only says who the box belongs to and what it was doing.
 *
 * The span is the whole time since the previous tick, read from
 * `box_meter_state` and moved forward in the same transaction as the writes
 * with a guarded update. Two orchestrators overlapping in a deploy therefore
 * never meter a span twice, and a describe that fails costs no time: the next
 * tick covers it. A gap longer than MAX_GAP_TICKS ticks (the orchestrator was
 * down) is not guessed at; only the last interval of it is metered.
 */
import { randomUUID } from 'crypto';
import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client, type Instance as Ec2Instance } from '@aws-sdk/client-ec2';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { awsClientConfig, getBoxConfig, type BoxConfig } from '../boxProvisioner';
import { traceSweep } from '../tracing/spans';

/** A box with activity this recently is `active`; past it, `idle`. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_GAP_TICKS = 3;
const HOUR_MS = 60 * 60 * 1000;

export type Slice = 'active' | 'idle' | 'pool' | 'boot' | 'orphan';

/** One termag box as EC2 reports it. */
export interface Ec2Box {
  ec2InstanceId: string;
  state: string;
  instanceType: string;
  region: string;
  volumeGb: number;
}

/** The parts of an Instance row the meter reads. */
export interface MeterRow {
  id: string;
  ec2InstanceId: string | null;
  userId: string | null;
  status: string;
  lastActivityAt: Date | null;
}

/** termag statuses whose box is running but on its way up or down, not in use. */
const BOOT_STATUSES = new Set(['provisioning', 'starting', 'stopping', 'hibernating']);

/**
 * What a running box's time counts as. Null when EC2 is not billing compute:
 * `running` is billed, and so is `stopping` on the way to hibernation, while
 * RAM is written to the root volume; pending, a plain stop's stopping and
 * stopped are not.
 */
export function classify(box: Pick<Ec2Box, 'state'>, row: MeterRow | undefined, now: number): Slice | null {
  if (box.state === 'stopping' && row?.status === 'hibernating') return 'boot';
  if (box.state !== 'running') return null;
  if (!row || row.status === 'terminated') return 'orphan';
  if (!row.userId) return 'pool';
  if (BOOT_STATUSES.has(row.status)) return 'boot';
  if (row.lastActivityAt && now - row.lastActivityAt.getTime() <= ACTIVE_WINDOW_MS) return 'active';
  return 'idle';
}

/** Volumes exist, and cost, in every state but terminated. */
export function hasStorage(box: Pick<Ec2Box, 'state'>): boolean {
  return box.state !== 'terminated';
}

/** [startMs, endMs) cut at UTC hour boundaries: each hour's start and the milliseconds of the span inside it. */
export function hourSlices(startMs: number, endMs: number): { hour: Date; ms: number }[] {
  const out: { hour: Date; ms: number }[] = [];
  for (let t = startMs; t < endMs;) {
    const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
    const next = Math.min(hourStart + HOUR_MS, endMs);
    out.push({ hour: new Date(hourStart), ms: next - t });
    t = next;
  }
  return out;
}

/** The span a tick meters: since the last tick, unless there was none or it is too far back to trust. */
export function meterSpan(prevTickMs: number | null, now: number, intervalMs: number): { startMs: number; endMs: number } {
  const trusted = prevTickMs !== null && prevTickMs < now && now - prevTickMs <= MAX_GAP_TICKS * intervalMs;
  return { startMs: trusted ? prevTickMs : now - intervalMs, endMs: now };
}

export interface UsageDelta {
  ec2InstanceId: string;
  hour: Date;
  instanceId: string | null;
  userId: string | null;
  instanceType: string;
  region: string;
  volumeGb: number;
  activeSec: number;
  idleSec: number;
  poolSec: number;
  bootSec: number;
  orphanSec: number;
  storageGbSec: number;
}

/** What a span adds to each box's hour rows. A box with neither compute nor storage in it adds nothing. */
export function meterDeltas(boxes: Ec2Box[], rows: MeterRow[], startMs: number, endMs: number): UsageDelta[] {
  const byEc2 = new Map(rows.filter(r => r.ec2InstanceId).map(r => [r.ec2InstanceId!, r]));
  const out: UsageDelta[] = [];
  for (const box of boxes) {
    const row = byEc2.get(box.ec2InstanceId);
    const slice = classify(box, row, endMs);
    // A box termag already terminated is nobody's, running or not: what EC2
    // still charges for it is a teardown that didn't finish, not its old owner's.
    const owner = row && row.status !== 'terminated' ? row.userId : null;
    const stored = hasStorage(box);
    if (!slice && !stored) continue;
    for (const { hour, ms } of hourSlices(startMs, endMs)) {
      const sec = Math.round(ms / 1000);
      if (sec === 0) continue;
      out.push({
        ec2InstanceId: box.ec2InstanceId,
        hour,
        instanceId: row?.id ?? null,
        userId: owner,
        instanceType: box.instanceType,
        region: box.region,
        volumeGb: box.volumeGb,
        activeSec: slice === 'active' ? sec : 0,
        idleSec: slice === 'idle' ? sec : 0,
        poolSec: slice === 'pool' ? sec : 0,
        bootSec: slice === 'boot' ? sec : 0,
        orphanSec: slice === 'orphan' ? sec : 0,
        storageGbSec: stored ? box.volumeGb * sec : 0,
      });
    }
  }
  return out;
}

// ── AWS ──────────────────────────────────────────────────────────────────────

const VOLUME_FILTER_CHUNK = 200;

/** Every termag box EC2 has in a region (ManagedBy tag), terminated ones dropped, with its attached GB. */
async function describeRegion(cfg: BoxConfig, region: string): Promise<Ec2Box[]> {
  const ec2 = new EC2Client(awsClientConfig(cfg, region));
  const instances: Ec2Instance[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: 'tag:ManagedBy', Values: [cfg.managedTag] }],
      NextToken,
    }));
    for (const r of res.Reservations ?? []) instances.push(...(r.Instances ?? []));
    NextToken = res.NextToken;
  } while (NextToken);

  const live = instances.filter(i => i.InstanceId && i.State?.Name && i.State.Name !== 'terminated');
  const gb = new Map<string, number>();
  const ids = live.map(i => i.InstanceId!);
  for (let i = 0; i < ids.length; i += VOLUME_FILTER_CHUNK) {
    // A filter, not VolumeIds: a volume deleted between the two calls drops
    // out instead of failing the whole describe.
    let token: string | undefined;
    do {
      const res = await ec2.send(new DescribeVolumesCommand({
        Filters: [{ Name: 'attachment.instance-id', Values: ids.slice(i, i + VOLUME_FILTER_CHUNK) }],
        NextToken: token,
      }));
      for (const v of res.Volumes ?? []) {
        const owner = v.Attachments?.[0]?.InstanceId;
        if (owner) gb.set(owner, (gb.get(owner) ?? 0) + (v.Size ?? 0));
      }
      token = res.NextToken;
    } while (token);
  }
  return live.map(i => ({
    ec2InstanceId: i.InstanceId!,
    state: i.State!.Name!,
    instanceType: i.InstanceType ?? 'unknown',
    region,
    volumeGb: gb.get(i.InstanceId!) ?? 0,
  }));
}

export interface MeterDeps {
  describeBoxes(cfg: BoxConfig, regions: string[]): Promise<Ec2Box[]>;
}

const awsDeps: MeterDeps = {
  async describeBoxes(cfg, regions) {
    const all = await Promise.all(regions.map(r => describeRegion(cfg, r)));
    return all.flat();
  },
};

/** Upsert deltas, adding to an hour's seconds; the identity columns take the latest tick's values. */
async function writeDeltas(tx: Prisma.TransactionClient, deltas: UsageDelta[], now: Date): Promise<void> {
  for (let i = 0; i < deltas.length; i += 500) {
    const values = deltas.slice(i, i + 500).map(d => Prisma.sql`(
      ${randomUUID()}, ${d.ec2InstanceId}, ${d.hour}, ${d.instanceId}, ${d.userId}, ${d.instanceType}, ${d.region},
      ${d.volumeGb}, ${d.activeSec}, ${d.idleSec}, ${d.poolSec}, ${d.bootSec}, ${d.orphanSec}, ${d.storageGbSec}, ${now})`);
    await tx.$executeRaw`
      INSERT INTO "box_usage_hours" ("id", "ec2InstanceId", "hour", "instanceId", "userId", "instanceType", "region",
        "volumeGb", "activeSec", "idleSec", "poolSec", "bootSec", "orphanSec", "storageGbSec", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("ec2InstanceId", "hour") DO UPDATE SET
        "instanceId" = EXCLUDED."instanceId",
        "userId" = EXCLUDED."userId",
        "instanceType" = EXCLUDED."instanceType",
        "region" = EXCLUDED."region",
        "volumeGb" = EXCLUDED."volumeGb",
        "activeSec" = "box_usage_hours"."activeSec" + EXCLUDED."activeSec",
        "idleSec" = "box_usage_hours"."idleSec" + EXCLUDED."idleSec",
        "poolSec" = "box_usage_hours"."poolSec" + EXCLUDED."poolSec",
        "bootSec" = "box_usage_hours"."bootSec" + EXCLUDED."bootSec",
        "orphanSec" = "box_usage_hours"."orphanSec" + EXCLUDED."orphanSec",
        "storageGbSec" = "box_usage_hours"."storageGbSec" + EXCLUDED."storageGbSec",
        "updatedAt" = EXCLUDED."updatedAt"`;
  }
}

/** The tick interval; 0 (BOX_METER_SECONDS=0) turns the meter off. */
export function meterIntervalMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.BOX_METER_SECONDS ?? 300);
  if (s === 0) return 0;
  return Number.isFinite(s) && s >= 30 ? s * 1000 : 300_000;
}

/**
 * One tick. Resolves to how many hour rows it wrote, or null when it metered
 * nothing (provisioning unconfigured, or another orchestrator ticked first).
 */
export async function sweepBoxMeter(now = Date.now(), deps: MeterDeps = awsDeps, intervalMs = meterIntervalMsFromEnv()): Promise<number | null> {
  const cfg = getBoxConfig();
  if (!cfg) return null;
  const recorded = await prisma.instance.findMany({
    where: { kind: 'ec2', region: { not: null }, status: { not: 'terminated' } },
    distinct: ['region'],
    select: { region: true },
  });
  const regions = [...new Set([cfg.region, ...recorded.map(r => r.region!)])];
  const boxes = await deps.describeBoxes(cfg, regions);
  const rows: MeterRow[] = await prisma.instance.findMany({
    where: { ec2InstanceId: { in: boxes.map(b => b.ec2InstanceId) } },
    select: { id: true, ec2InstanceId: true, userId: true, status: true, lastActivityAt: true },
  });

  return prisma.$transaction(async tx => {
    const state = await tx.boxMeterState.findUnique({ where: { id: 'meter' } });
    // Another orchestrator ticked moments ago: leave the span to its next tick.
    if (state && now - state.tickAt.getTime() < intervalMs / 2) return null;
    if (state) {
      const moved = await tx.boxMeterState.updateMany({ where: { id: 'meter', tickAt: state.tickAt }, data: { tickAt: new Date(now) } });
      if (moved.count === 0) return null;
    } else {
      await tx.boxMeterState.create({ data: { id: 'meter', tickAt: new Date(now) } });
    }
    const { startMs, endMs } = meterSpan(state?.tickAt.getTime() ?? null, now, intervalMs);
    const deltas = meterDeltas(boxes, rows, startMs, endMs);
    await writeDeltas(tx, deltas, new Date(now));
    return deltas.length;
  }, { timeout: 30_000 });
}

let meterTimer: NodeJS.Timeout | null = null;

export function startBoxMeter(intervalMs = meterIntervalMsFromEnv()): void {
  if (meterTimer || intervalMs <= 0) return;
  const sweep = traceSweep('box-meter', () => sweepBoxMeter(Date.now(), awsDeps, intervalMs));
  const tick = () => sweep()
    .catch(err => console.error('[BOX-METER] tick failed:', err instanceof Error ? err.message : String(err)));
  meterTimer = setInterval(tick, intervalMs);
  meterTimer.unref?.();
}

export function stopBoxMeter(): void {
  if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
}
