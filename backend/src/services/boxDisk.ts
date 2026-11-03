/**
 * Grow a box's root EBS volume from the admin Fleet tab.
 * Two steps, both hands-off for the box owner:
 *
 *   1. ModifyVolume to the new size (box-provisioner role, ManagedBy-tagged volumes only).
 *   2. Once the modification is `optimizing` (or `completed`), the box agent's
 *      `disk-grow` RPC runs growpart + resize2fs/xfs_growfs (agent/disk-grow.js).
 *
 * The box stays up throughout. Only a `ready` box whose agent has
 * `disk-grow-v1` is grown, so step 2 always has someone to run it: a stopped
 * box would pick the size up at its next boot (cloud-init growpart), but a
 * hibernated one resumes without booting and would not.
 *
 * What the last grow did is kept in memory per box for the card's status line:
 * an orchestrator restart mid-grow loses that and step 2, and the volume is
 * still larger, so asking again (to the same size) runs step 2 without a
 * second modification. Every grow is also a `disk-grow` row in box_events
 * (services/boxEvents.ts), kept for good, with who asked and how it ended:
 * the Fleet tab's recent operations.
 */

import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  EC2Client,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2';
import type { Instance } from '@prisma/client';
import { awsClientConfig, getBoxConfig } from './boxProvisioner';
import { instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { advanceBoxEvent, createBoxEvent, finishBoxEvent } from './boxEvents';

export const DISK_GROW_CAPABILITY = 'disk-grow-v1';
/** EBS's own ceiling for gp2/gp3. */
export const MAX_VOLUME_GB = 16_384;

export interface VolumeModification {
  state: string;
  progress: number | null;
  targetSizeGb: number | null;
  startedAt: string | null;
}

export interface RootVolume {
  volumeId: string;
  sizeGb: number;
  volumeType: string | null;
  modification: VolumeModification | null;
}

export interface GrowRecord {
  volumeId: string;
  fromGb: number;
  toGb: number;
  by: string;
  startedAt: string;
  /** modifying: waiting on EBS · filesystem: the agent is growing it · done · failed */
  state: 'modifying' | 'filesystem' | 'done' | 'failed';
  detail: string | null;
  finishedAt: string | null;
  /** Its box_events row, when that write went through. */
  eventId?: string | null;
}

const grows = new Map<string, GrowRecord>();

/** The last grow this process ran for the box, or null. */
export function lastGrow(instanceId: string): GrowRecord | null {
  return grows.get(instanceId) ?? null;
}

export function resetGrowsForTests(): void {
  grows.clear();
}

type GrowBox = Pick<Instance, 'id' | 'kind' | 'status' | 'ec2InstanceId' | 'region'>;

/** Why this box can't be grown right now, or null when it can. */
export function growRefusal(box: GrowBox, capabilities: string[] | null): string | null {
  if (box.kind !== 'ec2' || !box.ec2InstanceId) return 'only an EC2 box termag runs has a volume to grow';
  if (box.status !== 'ready') return `the box is ${box.status}; start it first (its agent grows the file system)`;
  if (!capabilities) return 'the box agent is not connected';
  if (!capabilities.includes(DISK_GROW_CAPABILITY)) return 'the box agent is too old to grow its file system; update the box first';
  const g = grows.get(box.id);
  if (g && (g.state === 'modifying' || g.state === 'filesystem')) return 'a grow is already running on this box';
  return null;
}

/**
 * The requested size. Larger than now (EBS can't shrink), or the same size
 * when a modification to it already went through, which re-runs only the
 * file system step.
 */
export function parseGrowBody(body: unknown, volume: Pick<RootVolume, 'sizeGb'>): { sizeGb: number } | { error: string } {
  const sizeGb = (body as { sizeGb?: unknown } | null)?.sizeGb;
  if (typeof sizeGb !== 'number' || !Number.isInteger(sizeGb)) return { error: 'sizeGb must be a whole number of GB' };
  if (sizeGb < volume.sizeGb) return { error: `EBS volumes can't shrink; the volume is ${volume.sizeGb} GB` };
  if (sizeGb > MAX_VOLUME_GB) return { error: `sizeGb must be at most ${MAX_VOLUME_GB}` };
  return { sizeGb };
}

function ec2For(box: Pick<Instance, 'region'>): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, box.region ?? cfg.region));
}

async function latestModification(ec2: EC2Client, volumeId: string): Promise<VolumeModification | null> {
  try {
    const out = await ec2.send(new DescribeVolumesModificationsCommand({ VolumeIds: [volumeId] }));
    const m = [...(out.VolumesModifications ?? [])].sort((a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0))[0];
    if (!m) return null;
    return {
      state: m.ModificationState ?? 'unknown',
      progress: m.Progress ?? null,
      targetSizeGb: m.TargetSize ?? null,
      startedAt: m.StartTime?.toISOString() ?? null,
    };
  } catch (err) {
    // A volume that was never modified answers with an error, not an empty list.
    if ((err as { name?: string }).name === 'InvalidVolumeModification.NotFound') return null;
    throw err;
  }
}

/** The box's root volume as EC2 has it now. */
export async function describeRootVolume(box: GrowBox): Promise<RootVolume> {
  const ec2 = ec2For(box);
  const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [box.ec2InstanceId!] }));
  const inst = out.Reservations?.[0]?.Instances?.[0];
  const volumeId = inst?.BlockDeviceMappings?.find(m => m.DeviceName === inst.RootDeviceName)?.Ebs?.VolumeId;
  if (!volumeId) throw new Error(`no root EBS volume on ${box.ec2InstanceId}`);
  const vol = (await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))).Volumes?.[0];
  return {
    volumeId,
    sizeGb: vol?.Size ?? 0,
    volumeType: vol?.VolumeType ?? null,
    modification: await latestModification(ec2, volumeId),
  };
}

/** EBS allows the file system step once a modification is optimizing; failed is final. */
function modificationSettled(state: string): 'ready' | 'failed' | 'waiting' {
  if (state === 'optimizing' || state === 'completed') return 'ready';
  if (state === 'failed') return 'failed';
  return 'waiting';
}

export interface SettleTiming {
  pollMs: number;
  modifyTimeoutMs: number;
  /** growpart can run before the kernel sees the new size; it is tried again this often, up to fsAttempts. */
  fsRetryMs: number;
  fsAttempts: number;
}
const DEFAULT_TIMING: SettleTiming = { pollMs: 5_000, modifyTimeoutMs: 15 * 60_000, fsRetryMs: 15_000, fsAttempts: 3 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Start a grow: modify the volume (unless it is already that size) and settle
 * the rest in the background. Throws EC2's refusal (for example the one
 * modification per volume per six hours) for the route to answer with.
 */
export async function startGrow(
  box: GrowBox & { name?: string }, volume: RootVolume, sizeGb: number, by: string, timing: SettleTiming = DEFAULT_TIMING,
  actorId: string | null = null,
): Promise<GrowRecord> {
  const rec: GrowRecord = {
    volumeId: volume.volumeId, fromGb: volume.sizeGb, toGb: sizeGb, by,
    startedAt: new Date().toISOString(), state: 'modifying', detail: null, finishedAt: null,
  };
  rec.eventId = await bestEffort(box, async () => (await createBoxEvent({
    box: { id: box.id, name: box.name ?? box.id }, kind: 'disk-grow', actorId, actorRole: 'admin',
    from: `${volume.sizeGb} GB`, to: `${sizeGb} GB`, phase: 'modifying',
    detail: { volumeId: volume.volumeId, fromGb: volume.sizeGb, toGb: sizeGb, by },
  })).id);
  try {
    if (sizeGb > volume.sizeGb) await ec2For(box).send(new ModifyVolumeCommand({ VolumeId: volume.volumeId, Size: sizeGb }));
  } catch (err) {
    // EC2's refusal is the outcome too (one modification per six hours, say).
    finish(box, rec, 'failed', `EC2 refused the modification: ${(err as Error).message}`);
    throw err;
  }
  grows.set(box.id, rec);
  console.log(`[BOX-DISK] ${box.id} ${volume.volumeId} ${volume.sizeGb} → ${sizeGb} GB by ${by}`);
  void settleGrow(box, rec, timing).catch(err => finish(box, rec, 'failed', (err as Error).message));
  return { ...rec };
}

function finish(box: GrowBox, rec: GrowRecord, state: 'done' | 'failed', detail: string): void {
  Object.assign(rec, { state, detail, finishedAt: new Date().toISOString() });
  console.log(`[BOX-DISK] ${box.id} ${rec.volumeId} ${state}: ${detail}`);
  const id = rec.eventId;
  if (id) void bestEffort(box, () => finishBoxEvent(id, { phase: state, error: state === 'failed' ? detail : null, detail: { result: detail } }));
}

/** A box_events write never fails a grow: logged, and the grow goes on. */
async function bestEffort<T>(box: GrowBox, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (err) {
    console.error(`[BOX-DISK] ${box.id}: box event write failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Whether a file system of `fsGb` (df's size, GiB like EBS's) already spans a volume of `volumeGb`.
 * df counts less than the volume: the boot partitions, and ext4's inode tables (about 1.6%).
 */
function fillsVolume(fsGb: number | null | undefined, volumeGb: number): boolean {
  return fsGb != null && fsGb >= volumeGb * 0.95;
}

async function settleGrow(box: GrowBox, rec: GrowRecord, timing: SettleTiming): Promise<void> {
  const ec2 = ec2For(box);
  const deadline = Date.now() + timing.modifyTimeoutMs;
  for (;;) {
    const m = await latestModification(ec2, rec.volumeId);
    const settled = m ? modificationSettled(m.state) : 'ready';
    if (settled === 'failed') return finish(box, rec, 'failed', 'EBS reported the modification failed');
    if (settled === 'ready') break;
    if (Date.now() > deadline) return finish(box, rec, 'failed', `EBS still ${m!.state} after ${Math.round(timing.modifyTimeoutMs / 60_000)} min; ask again once it is optimizing`);
    await sleep(timing.pollMs);
  }

  rec.state = 'filesystem';
  const eventId = rec.eventId;
  if (eventId) await bestEffort(box, () => advanceBoxEvent(eventId, 'filesystem'));
  let last = '';
  for (let attempt = 1; attempt <= timing.fsAttempts; attempt++) {
    if (!instanceAgentTransport(box.id)?.capabilities.includes(DISK_GROW_CAPABILITY)) {
      return finish(box, rec, 'failed', 'the volume is larger, but the box agent went away before it grew the file system; ask again to the same size');
    }
    const r = await sendToInstanceAgent(box.id, 'disk-grow', {}, 180_000) as
      { ok: boolean; error?: string; partition?: string; beforeGb?: number | null; afterGb?: number | null };
    if (!r.ok) return finish(box, rec, 'failed', r.error ?? 'the agent reported a failure');
    last = `file system ${r.beforeGb ?? '?'} → ${r.afterGb ?? '?'} GB (partition ${r.partition})`;
    // The partition was already full and the file system didn't move: the kernel hasn't seen the new size
    // yet. On a same-size retry it can also mean an earlier run already grew it; only the file system's
    // size tells the two apart.
    const moved = r.partition === 'grown' || (r.afterGb != null && r.beforeGb != null && r.afterGb > r.beforeGb);
    if (moved || (rec.toGb === rec.fromGb && fillsVolume(r.afterGb, rec.toGb))) return finish(box, rec, 'done', last);
    if (attempt < timing.fsAttempts) await sleep(timing.fsRetryMs);
  }
  finish(box, rec, 'failed', `${last}; the box did not see the new size yet, ask again to the same size in a few minutes`);
}
