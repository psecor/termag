/**
 * Box stop/start/hibernate: the EC2 calls, the guarded status writes and the
 * power sweep. The rules they follow are in boxPowerPolicy.ts.
 *
 * Every write is an updateMany guarded on the status it moves from, so a stop
 * racing a terminate, a connect or the sweep turns into a no-op instead of
 * writing a stale status back.
 */

import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import type { Instance, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { awsClientConfig, getBoxConfig } from './boxProvisioner';
import { dropInstanceAgent } from './agentRegistry';
import { boxInUseFields, guestWakeFields } from './boxActivity';
import {
  hibernateFallbackNote,
  hibernationRefreshDue,
  hibernationRefreshMsFromEnv,
  isHibernateRefusal,
  POWER_TRANSITIONS,
  PowerAction,
  powerTimeoutsFromEnv,
  settlePowerState,
} from './boxPowerPolicy';

export class PowerRequestConflict extends Error {}

/**
 * When each box's current power request was made. In memory only, so an
 * orchestrator restart restarts the timeout clock for a box caught mid-way;
 * that only delays a timeout message, never a settle.
 */
const requestedAt = new Map<string, number>();

/**
 * Re-hibernate attempts per box after a 60-day refresh resume. EC2 can refuse
 * a hibernate for a short while after the instance comes up, so the sweep
 * retries before settling for a plain stop.
 */
const rehibernateAttempts = new Map<string, number>();
const REHIBERNATE_MAX_ATTEMPTS = 30;

function ec2For(instance: Pick<Instance, 'region'>): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, instance.region ?? cfg.region));
}

async function sendPower(instance: Instance, action: PowerAction): Promise<void> {
  const ec2 = ec2For(instance);
  const InstanceIds = [instance.ec2InstanceId!];
  if (action === 'start') await ec2.send(new StartInstancesCommand({ InstanceIds }));
  else if (action === 'hibernate') await ec2.send(new StopInstancesCommand({ InstanceIds, Hibernate: true }));
  else await ec2.send(new StopInstancesCommand({ InstanceIds }));
}

export interface RequestPowerOptions {
  /** A start made by the 60-day refresh, which hibernates the box again once it is up. */
  rehibernate?: boolean;
  /**
   * What to do when EC2 refuses the hibernate itself: `stop` (the default, an
   * owner's request) stops the box plainly instead, `throw` puts the status
   * back and rethrows so the caller can try again later.
   */
  onHibernateRefused?: 'stop' | 'throw';
  /**
   * An owner's start: restart the idle clock and clear the parked state in
   * the same write as `starting`, so a box can't come up still carrying the
   * clock it was parked with.
   */
  markInUse?: boolean;
  /**
   * A reviewer's wake of an auto-hibernated box (services/previewShareLinks.ts):
   * the idle clock restarts, but `parkedAt` (the terminate clock) and the idle
   * note stay as they were (boxActivity.guestWakeFields).
   */
  guestWake?: boolean;
  /**
   * The owner's own stop or hibernate: an idle-hibernate note left from
   * before (a start that kept it: the scheduler's, a reviewer's) no longer
   * says why the box is down, so it goes. That keeps the note a true mark of
   * a box the sweep parked, the only kind a reviewer may wake.
   */
  byOwner?: boolean;
}

/**
 * Move the box to its transitional status and ask EC2 to do it. The row is
 * written first so the UI and the create guards see the change immediately;
 * if EC2 refuses, it goes back to the status it had. Resolves to the status
 * written, which is `stopping` when a hibernate fell back to a plain stop.
 */
export async function requestPower(instance: Instance, action: PowerAction, opts: RequestPowerOptions = {}): Promise<string> {
  const to = POWER_TRANSITIONS[action].to;
  const data: Prisma.InstanceUpdateManyMutationInput = {
    status: to,
    provisioningError: null,
    rehibernatePending: !!opts.rehibernate,
  };
  // A start keeps hibernatedAt so a resume that doesn't take settles back to
  // hibernated; anything that powers the box down starts from a clean slate.
  if (action !== 'start') data.hibernatedAt = null;
  if (opts.markInUse) Object.assign(data, boxInUseFields(instance.id));
  else if (opts.guestWake && action === 'start') Object.assign(data, guestWakeFields(instance.id));
  if (opts.byOwner && action !== 'start') data.lifecycleNote = null;
  // A box the lifecycle sweep has claimed for terminate stays down: the
  // claim leaves it hibernated, so the status alone wouldn't stop a start.
  const moved = await prisma.instance.updateMany({ where: { id: instance.id, status: instance.status, autoTerminatedAt: null }, data });
  if (moved.count === 0) throw new PowerRequestConflict('The box changed state; reload and try again');
  requestedAt.set(instance.id, Date.now());
  // Whatever socket a hibernated box still holds predates the hibernate, and
  // only a fresh connect after the resume makes the box ready.
  if (action === 'start' && instance.status === 'hibernated') dropInstanceAgent(instance.id, 'resuming from hibernation');

  try {
    await sendPower(instance, action);
  } catch (err) {
    if (action === 'hibernate' && isHibernateRefusal(err) && (opts.onHibernateRefused ?? 'stop') === 'stop') {
      return fallBackToStop(instance, err);
    }
    await revert(instance, to);
    throw err;
  }
  console.log(`[BOX] ${instance.name}: ${action} requested (${instance.ec2InstanceId})`);
  return to;
}

async function revert(instance: Instance, from: string): Promise<void> {
  requestedAt.delete(instance.id);
  await prisma.instance.updateMany({
    where: { id: instance.id, status: from },
    data: {
      status: instance.status,
      hibernatedAt: instance.hibernatedAt,
      rehibernatePending: instance.rehibernatePending,
      parkedAt: instance.parkedAt,
      lifecycleNote: instance.lifecycleNote,
      lastActivityAt: instance.lastActivityAt,
    },
  }).catch(e => console.error(`[BOX] ${instance.name}: failed to revert ${from}:`, errMsg(e)));
}

/**
 * EC2 refused to hibernate, so stop it plainly: the owner asked for the box to
 * stop costing compute, and a box that can't hibernate right now can still do
 * that. The note on the row says the RAM was not kept.
 */
async function fallBackToStop(instance: Instance, hibernateErr: unknown): Promise<string> {
  const reason = errMsg(hibernateErr);
  console.warn(`[BOX] ${instance.name}: EC2 refused to hibernate (${reason}); stopping it instead`);
  const moved = await prisma.instance.updateMany({
    where: { id: instance.id, status: 'hibernating' },
    data: { status: 'stopping', provisioningError: hibernateFallbackNote(reason).slice(0, 1000) },
  });
  if (moved.count === 0) throw new PowerRequestConflict('The box changed state; reload and try again');
  try {
    await sendPower(instance, 'stop');
  } catch (err) {
    await revert(instance, 'stopping');
    throw err;
  }
  console.log(`[BOX] ${instance.name}: stop requested after hibernate refusal (${instance.ec2InstanceId})`);
  return 'stopping';
}

async function describeState(instance: Instance): Promise<{ state?: string; reasonCode?: string }> {
  const res = await ec2For(instance).send(new DescribeInstancesCommand({ InstanceIds: [instance.ec2InstanceId!] }));
  const inst = res.Reservations?.[0]?.Instances?.[0];
  return { state: inst?.State?.Name, reasonCode: inst?.StateReason?.Code };
}

/**
 * One sweep: settle every box that is `stopping`, `hibernating` or
 * `starting` from its EC2 state, then keep hibernated boxes inside EC2's
 * 60-day limit.
 */
export async function sweepPowerStates(now = Date.now()): Promise<void> {
  if (!getBoxConfig()) return;
  const timeouts = powerTimeoutsFromEnv();
  const boxes = await prisma.instance.findMany({
    where: { status: { in: ['stopping', 'hibernating', 'starting'] }, kind: 'ec2', ec2InstanceId: { not: null } },
  });
  const live = new Set(boxes.map(b => b.id));
  for (const id of requestedAt.keys()) if (!live.has(id)) requestedAt.delete(id);

  for (const box of boxes) {
    if (!requestedAt.has(box.id)) requestedAt.set(box.id, now);
    let described: { state?: string; reasonCode?: string };
    try {
      described = await describeState(box);
    } catch (err) {
      console.error(`[BOX] ${box.name}: describe for power sweep failed:`, errMsg(err));
      continue;
    }
    const settlement = settlePowerState(box, described.state, now - requestedAt.get(box.id)!, timeouts, described.reasonCode);
    if (!settlement) continue;
    const data: Prisma.InstanceUpdateManyMutationInput = { ...settlement };
    if (settlement.status === 'hibernated' && box.status === 'hibernating') data.hibernatedAt = new Date(now);
    // The lifecycle's parked clock: kept through the 60-day refresh (which
    // resets hibernatedAt), cleared only by an owner's start (markInUse).
    if (settlement.status === 'hibernated' && !box.parkedAt) data.parkedAt = new Date(now);
    if (settlement.status && settlement.status !== 'ready') data.rehibernatePending = false;
    const applied = await prisma.instance.updateMany({ where: { id: box.id, status: box.status }, data });
    if (applied.count === 0) continue;
    if (settlement.status) requestedAt.delete(box.id);
    if (settlement.status === 'hibernated') dropInstanceAgent(box.id, 'hibernated');
    console.log(`[BOX] ${box.name}: ${box.status} -> ${settlement.status ?? box.status} (EC2 ${described.state}`
      + `${described.reasonCode ? `, ${described.reasonCode}` : ''})`
      + (settlement.provisioningError ? `: ${settlement.provisioningError}` : ''));
  }

  await refreshLongHibernations(now);
  await rehibernateRefreshedBoxes();
}

/** Resume every box that has been hibernated close to EC2's 60-day limit. */
async function refreshLongHibernations(now: number): Promise<void> {
  const refreshMs = hibernationRefreshMsFromEnv();
  if (refreshMs <= 0) return;
  const due = await prisma.instance.findMany({
    where: {
      status: 'hibernated', kind: 'ec2', ec2InstanceId: { not: null },
      hibernatedAt: { lte: new Date(now - refreshMs) },
    },
  });
  for (const box of due) {
    if (!hibernationRefreshDue(box, now, refreshMs)) continue;
    try {
      await requestPower(box, 'start', { rehibernate: true });
      console.log(`[BOX] ${box.name}: hibernated since ${box.hibernatedAt!.toISOString()}; resuming to hibernate it again`);
    } catch (err) {
      console.error(`[BOX] ${box.name}: 60-day hibernation refresh could not start it:`, errMsg(err));
    }
  }
}

/** Hibernate again every box the refresh resumed, once its agent is back. */
async function rehibernateRefreshedBoxes(): Promise<void> {
  const boxes = await prisma.instance.findMany({
    where: { status: 'ready', rehibernatePending: true, kind: 'ec2', ec2InstanceId: { not: null } },
  });
  const pending = new Set(boxes.map(b => b.id));
  for (const id of rehibernateAttempts.keys()) if (!pending.has(id)) rehibernateAttempts.delete(id);
  for (const box of boxes) {
    const attempt = (rehibernateAttempts.get(box.id) ?? 0) + 1;
    const lastTry = attempt >= REHIBERNATE_MAX_ATTEMPTS;
    try {
      const status = await requestPower(box, 'hibernate', { onHibernateRefused: lastTry ? 'stop' : 'throw' });
      rehibernateAttempts.delete(box.id);
      console.log(`[BOX] ${box.name}: 60-day hibernation refresh -> ${status}`);
    } catch (err) {
      if (err instanceof PowerRequestConflict) { rehibernateAttempts.delete(box.id); continue; }
      // The revert put rehibernatePending back, so the next sweep tries again.
      rehibernateAttempts.set(box.id, attempt);
      console.warn(`[BOX] ${box.name}: re-hibernate attempt ${attempt} refused:`, errMsg(err));
    }
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startPowerSweep(intervalMs = 10 * 1000): void {
  if (sweepTimer) return;
  const tick = () => sweepPowerStates().catch(err => console.error('[BOX] Power sweep failed:', errMsg(err)));
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
}

export function stopPowerSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** A box's current status, for terminalAttachRefusal; null with no box or no row. */
export async function instanceStatus(instanceId: string | null): Promise<string | null> {
  if (!instanceId) return null;
  const box = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
  return box?.status ?? null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
