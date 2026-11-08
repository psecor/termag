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
 *
 * A box's owner grows their own from the Resize box dialogs and `termag box
 * resize --disk` (routes/instances.ts growOwnedBox): the same checks and row,
 * `actorRole: owner`, capped at the creation range's top (OWNER_MAX_GB, from
 * boxDiskSize.ts) and refused inside EBS's six hours (cooldownRefusal) before
 * EC2 is asked. A finished grow records the new size on `Instance.diskGiB`.
 */

import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  EC2Client,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2';
import type { Instance } from '@prisma/client';
import { prisma } from '../db';
import { awsClientConfig, getBoxConfig } from './boxProvisioner';
import { BOX_DISK_LIMITS } from './boxDiskSize';
import { instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { advanceBoxEvent, createBoxEvent, eventOpen, finishBoxEvent } from './boxEvents';

export const DISK_GROW_CAPABILITY = 'disk-grow-v1';
/** EBS's own ceiling for gp2/gp3. */
export const MAX_VOLUME_GB = 16_384;
/** An owner grows their own box up to the top of the creation range (boxDiskSize.ts); past it is an admin's Grow disk. */
export const OWNER_MAX_GB = BOX_DISK_LIMITS.maxGiB;
/** EBS allows one modification per volume every six hours. */
export const EBS_MODIFY_COOLDOWN_MS = 6 * 3_600_000;

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
/**
 * Boxes an owner's grow request holds before its grow is registered: from
 * just after the request's first checks, through reading the volume and
 * ModifyVolume, until startGrow puts the grow in `grows` or the request is
 * refused. A resize asked meanwhile sees it (growRunning) and waits, so it
 * never stops the box between the volume growing and the agent's file
 * system step (Devin on #1214).
 */
const reservations = new Map<string, number>();

/** Hold the box as growing until the returned release is called (once is enough; more are no-ops). */
export function reserveGrow(instanceId: string): () => void {
  reservations.set(instanceId, (reservations.get(instanceId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (reservations.get(instanceId) ?? 1) - 1;
    if (left > 0) reservations.set(instanceId, left); else reservations.delete(instanceId);
  };
}

/** The last grow this process ran for the box, or null. */
export function lastGrow(instanceId: string): GrowRecord | null {
  return grows.get(instanceId) ?? null;
}

/** Put a grow record in place, as startGrow and its settle leave one. */
export function recordGrowForTests(instanceId: string, rec: GrowRecord): void {
  grows.set(instanceId, rec);
}

export function resetGrowsForTests(): void {
  grows.clear();
  reservations.clear();
}

type GrowBox = Pick<Instance, 'id' | 'kind' | 'status' | 'ec2InstanceId' | 'region'>;

/** Why this box can't be grown right now, or null when it can. */
export function growRefusal(box: GrowBox, capabilities: string[] | null): string | null {
  if (box.kind !== 'ec2' || !box.ec2InstanceId) return 'only an EC2 box termag runs has a volume to grow';
  if (box.status !== 'ready') return `the box is ${box.status}; start it first (its agent grows the file system)`;
  if (!capabilities) return 'the box agent is not connected';
  if (!capabilities.includes(DISK_GROW_CAPABILITY)) return 'the box agent is too old to grow its file system; update the box first';
  const g = grows.get(box.id);
  if ((g && (g.state === 'modifying' || g.state === 'filesystem')) || reservations.has(box.id)) return 'a grow is already running on this box';
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

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * EBS's one change per volume per six hours, said before EC2 is asked: null
 * when the volume may change now. A failed modification doesn't count.
 */
export function cooldownRefusal(volume: Pick<RootVolume, 'modification'>, nowMs = Date.now()): string | null {
  const m = volume.modification;
  if (!m || m.state === 'failed' || !m.startedAt) return null;
  const at = Date.parse(m.startedAt);
  if (!Number.isFinite(at) || nowMs - at >= EBS_MODIFY_COOLDOWN_MS) return null;
  return `EBS allows one change to a disk every six hours. This one was last changed at ${utc(at)}, so it can grow again after ${utc(at + EBS_MODIFY_COOLDOWN_MS)}.`;
}

/**
 * An owner's grow request: parseGrowBody, capped at OWNER_MAX_GB (or what the
 * disk already has, when an admin grew it past that), and refused inside the
 * six hours when it would modify the volume. A same-size request re-runs only
 * the file system step, which EBS doesn't count.
 */
export function parseOwnerGrowBody(
  body: unknown, volume: Pick<RootVolume, 'sizeGb' | 'modification'>, nowMs = Date.now(),
): { sizeGb: number } | { error: string; code: 'invalid_disk' | 'disk_cooldown' } {
  const parsed = parseGrowBody(body, volume);
  if ('error' in parsed) return { error: parsed.error, code: 'invalid_disk' };
  const max = Math.max(OWNER_MAX_GB, volume.sizeGb);
  if (parsed.sizeGb > max) return { error: `A box's disk grows up to ${max} GB here; an admin can grow it further`, code: 'invalid_disk' };
  const cooldown = parsed.sizeGb > volume.sizeGb ? cooldownRefusal(volume, nowMs) : null;
  if (cooldown) return { error: cooldown, code: 'disk_cooldown' };
  return parsed;
}

/** EC2's refusal of a ModifyVolume, as a person reads it: its rate limit plainly, anything else with EC2's words. */
export function growErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? String(err);
  if (/RateExceeded/i.test(e?.name ?? '') || /modification rate|6 hours|six hours/i.test(message)) {
    return 'EBS allows one change to a disk every six hours, and this one was changed less than six hours ago. Try again later.';
  }
  return `EC2 refused the change: ${message}`;
}

/** A grow as the owner's dialogs show it. */
export interface GrowView {
  fromGb: number;
  toGb: number;
  state: GrowRecord['state'];
  running: boolean;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function growView(rec: GrowRecord | null): GrowView | null {
  if (!rec) return null;
  const { fromGb, toGb, state, detail, startedAt, finishedAt } = rec;
  return { fromGb, toGb, state, running: state === 'modifying' || state === 'filesystem', detail, startedAt, finishedAt };
}

/** The disk in the owner's Resize box dialogs (GET /api/instances/:id/resize `disk`). */
export interface DiskView {
  /** The volume's size as EC2 has it, else the box's recorded disk; null when neither is known. */
  sizeGb: number | null;
  /** The most the owner may ask for. */
  maxGb: number;
  /** Why the disk can't grow now; null when it can. */
  refusal: string | null;
  grow: GrowView | null;
  /**
   * The last grow got the volume to its size but failed at the file system
   * step: asking for that same size again re-runs only that step, which EBS
   * doesn't count, so it is offered even inside the six hours. Null otherwise.
   */
  retry: { sizeGb: number; error: string | null } | null;
}

/** The box's latest `disk-grow` row in box_events, as much as diskView reads of it. */
export interface GrowEventRow {
  phase: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  detail: unknown;
}

/**
 * The last grow when this process has none (an orchestrator restart since),
 * from its box_events row: failed as it ended, or cut off when the row is
 * still open, so the retry outlives the restart (Devin on #1214).
 */
function lastFromRow(row: GrowEventRow | null | undefined, nowMs: number): Pick<GrowRecord, 'state' | 'toGb' | 'detail'> | null {
  const toGb = (row?.detail as { toGb?: unknown } | null)?.toGb;
  if (!row || typeof toGb !== 'number') return null;
  if (row.phase === 'failed') return { state: 'failed', toGb, detail: row.error };
  // Open and fresh (eventOpen) is a grow still running, maybe in another process: not cut off (Cursor on #1214).
  if (!row.finishedAt && row.phase !== 'done' && !eventOpen(row, nowMs)) {
    return { state: 'failed', toGb, detail: 'the last grow was cut off (the orchestrator restarted) before its file system step finished' };
  }
  return null;
}

/**
 * Whether a request for `sizeGb`, the size the volume already has, has a file
 * system step to finish: the last grow (this process's, else its row) failed
 * or was cut off at that size. Otherwise such a request changes nothing.
 */
export function pendingRetry(instanceId: string, sizeGb: number, lastRow: GrowEventRow | null, nowMs = Date.now()): boolean {
  const last = lastGrow(instanceId) ?? lastFromRow(lastRow, nowMs);
  return last?.state === 'failed' && last.toGb === sizeGb;
}

/** Pure: the box, its agent's capabilities, its root volume (or why it couldn't be read) and its latest disk-grow row. */
export function diskView(
  box: GrowBox & Pick<Instance, 'diskGiB'>, capabilities: string[] | null, volume: RootVolume | { error: string } | null, nowMs = Date.now(),
  lastRow: GrowEventRow | null = null,
): DiskView {
  const inMemory = lastGrow(box.id);
  const last = inMemory ?? lastFromRow(lastRow, nowMs);
  // Another process's grow shows only as its row: refuse a second one beside it.
  const elsewhere = !inMemory && !!lastRow && eventOpen(lastRow, nowMs) ? 'a grow is already running on this box' : null;
  const grow = growView(inMemory);
  const canGrow = growRefusal(box, capabilities) ?? elsewhere;
  if (!volume || 'error' in volume) {
    return {
      sizeGb: box.diskGiB ?? null, maxGb: OWNER_MAX_GB, grow, retry: null,
      refusal: canGrow ?? (volume ? `Could not read the disk: ${volume.error}` : 'There is no disk to grow'),
    };
  }
  const maxGb = Math.max(OWNER_MAX_GB, volume.sizeGb);
  const refusal = canGrow
    ?? (volume.sizeGb >= maxGb ? `The disk is already ${volume.sizeGb} GB, the most a box grows to here; an admin can grow it further` : null)
    ?? cooldownRefusal(volume, nowMs);
  const retry = !canGrow && last?.state === 'failed' && last.toGb === volume.sizeGb ? { sizeGb: volume.sizeGb, error: last.detail } : null;
  return { sizeGb: volume.sizeGb, maxGb, refusal, grow, retry };
}

/**
 * Wait until the box's running grow (in this process) has finished; at once
 * when none runs. A resize waits on it before it stops the box, so the
 * agent's file system step isn't cut off. Resolves with the grow, or null;
 * throws when it is still running at the limit, which fails the resize
 * before anything is stopped.
 */
export async function waitForGrow(instanceId: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<GrowRecord | null> {
  const pollMs = opts.pollMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!growRunning(instanceId)) {
      const g = grows.get(instanceId);
      return g ? { ...g } : null;
    }
    // Still growing at the limit: the caller must not stop the box under it (Bugbot on #1214).
    if (Date.now() >= deadline) {
      throw new Error(`The disk is still growing after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes; the box was not stopped. Resize again once it has grown.`);
    }
    await sleep(pollMs);
  }
}

/** Whether a grow runs on the box now, in this process. */
export function growRunning(instanceId: string): boolean {
  const g = grows.get(instanceId);
  return (!!g && (g.state === 'modifying' || g.state === 'filesystem')) || reservations.has(instanceId);
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
/** How long one ask of the agent's disk-grow RPC may take. */
const FS_RPC_TIMEOUT_MS = 180_000;

/**
 * The longest a grow can run with these timings: the wait for EBS, then each
 * file system attempt at its RPC limit with the pauses between them. It stays
 * under the hour an open box_events row counts as running
 * (boxEvents.OPEN_EVENT_STALE_MS), so the row never lets go of a grow still
 * running (boxDiskBusy.ts relies on that).
 */
export function maxGrowMs(timing: SettleTiming = DEFAULT_TIMING): number {
  return timing.modifyTimeoutMs + timing.pollMs + timing.fsAttempts * FS_RPC_TIMEOUT_MS + (timing.fsAttempts - 1) * timing.fsRetryMs;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Start a grow: modify the volume (unless it is already that size) and settle
 * the rest in the background. Throws EC2's refusal (for example the one
 * modification per volume per six hours) for the route to answer with.
 */
export async function startGrow(
  box: GrowBox & { name?: string }, volume: RootVolume, sizeGb: number, by: string, timing: SettleTiming = DEFAULT_TIMING,
  actorId: string | null = null, actorRole: 'owner' | 'admin' = 'admin',
): Promise<GrowRecord> {
  const rec: GrowRecord = {
    volumeId: volume.volumeId, fromGb: volume.sizeGb, toGb: sizeGb, by,
    startedAt: new Date().toISOString(), state: 'modifying', detail: null, finishedAt: null,
  };
  rec.eventId = await bestEffort(box, async () => (await createBoxEvent({
    box: { id: box.id, name: box.name ?? box.id }, kind: 'disk-grow', actorId, actorRole,
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
  // The box's recorded disk follows the volume, for the lists and the dialogs' "Now".
  if (state === 'done') void bestEffort(box, () => prisma.instance.update({ where: { id: box.id }, data: { diskGiB: rec.toGb } }));
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
    const r = await sendToInstanceAgent(box.id, 'disk-grow', {}, FS_RPC_TIMEOUT_MS) as
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
