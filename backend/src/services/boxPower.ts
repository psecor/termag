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
import { isAutoHibernateNote } from './boxLifecyclePolicy';
import { resizeFreeWhere } from './boxResizeLock';
import { startOnFallbackType } from './boxStartFallback';
import { armBoxStart, recordBoxStartFailed, recordBoxStartStillStarting, type StartedBy } from './boxStartLatency';
import { traceSweep } from './tracing/spans';
import { forgetSleepRequest, recordSleepRequested, recordSleepSettled, sleepOutcome, type SleepRequestedBy } from './boxPowerEvents';
import {
  hibernateFallbackNote,
  hibernationRefreshDue,
  hibernationRefreshMsFromEnv,
  isHibernateRefusal,
  POWER_TRANSITIONS,
  PowerAction,
  powerTimeoutsFromEnv,
  REFRESH_STOP_NOTE,
  settlePowerState,
  sleepKeepsDownClock,
} from './boxPowerPolicy';
import { QUARANTINED, QUARANTINED_OWNER_ERROR } from './boxQuarantinePolicy';

export class PowerRequestConflict extends Error {}

/**
 * When each box's current power request was made. In memory only, so an
 * orchestrator restart restarts the timeout clock for a box caught mid-way;
 * that only delays a timeout message, never a settle.
 */
const requestedAt = new Map<string, number>();

/** When the box's current power request was made, as this process knows it; null when it has none. */
export function powerRequestedAt(instanceId: string): number | null {
  return requestedAt.get(instanceId) ?? null;
}

/** Attempts per box to put it back down after a 60-day refresh resume, for the log. */
const rehibernateAttempts = new Map<string, number>();

function ec2For(instance: Pick<Instance, 'region'>): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, instance.region ?? cfg.region));
}

async function sendPower(instance: Instance, action: PowerAction, opts: RequestPowerOptions = {}): Promise<void> {
  const ec2 = ec2For(instance);
  const InstanceIds = [instance.ec2InstanceId!];
  if (action === 'start') {
    // A resize walks its own types; any other start of a stopped box EC2 has
    // no room for may go to another type of the same shape (boxStartFallback.ts).
    try {
      await ec2.send(new StartInstancesCommand({ InstanceIds }));
    } catch (err) {
      if (opts.forResize) throw err;
      await startOnFallbackType(ec2, instance, err);
    }
  }
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
  /**
   * The lifecycle sweep's park: move only while the idle clock is still the
   * one the decision read, so a keystroke since wins and the request answers
   * PowerRequestConflict.
   */
  expectLastActivityAt?: Date | null;
  /**
   * Who a start is for, for box.resumed's `by` (the regret measure: an owner
   * starting a box soon after the sweep parked it). Defaults to `owner` for
   * markInUse and `guest` for guestWake.
   */
  startedBy?: StartedBy;
  /**
   * Who a stop or hibernate is for, for box.sleep.requested's `by`. Defaults
   * to `owner` for byOwner; null (left out) otherwise.
   */
  sleepBy?: SleepRequestedBy;
  /** The sweep's park: move only while the box's own idle setting is the one the decision read. */
  expectIdleHibernateHours?: number | null;
  /** The sweep's retried stuck stop: move only while no agent has connected since the decision. */
  expectLastConnectedAt?: Date | null;
  /**
   * More columns for the same guarded write as the status (the sweep's note
   * and autoParkedAt), so nothing that settles the box can see the status
   * without them. A request EC2 refuses puts them back with the status.
   */
  andSet?: Prisma.InstanceUpdateManyMutationInput;
  /**
   * The resize's own stops and starts (services/boxResize.ts). Every other
   * request is refused while a resize holds the box, so nothing starts a box
   * the resize stopped to retype, or parks one it is bringing back.
   */
  forResize?: boolean;
}

/**
 * Told when a box the lifecycle sweep parked (`autoParkedAt`) settles to
 * stopped or hibernated, so its owner hears what EC2 actually did. Set by
 * boxLifecycle.ts; this module can't import it (it imports this one).
 */
export type AutoParkSettledListener = (box: Instance, settled: 'stopped' | 'hibernated') => void;
let autoParkSettled: AutoParkSettledListener | null = null;

export function onAutoParkSettled(listener: AutoParkSettledListener | null): void {
  autoParkSettled = listener;
}

/**
 * Move the box to its transitional status and ask EC2 to do it. The row is
 * written first so the UI and the create guards see the change immediately;
 * if EC2 refuses, it goes back to the status it had. Resolves to the status
 * written, which is `stopping` when a hibernate fell back to a plain stop.
 */
export async function requestPower(instance: Instance, action: PowerAction, opts: RequestPowerOptions = {}): Promise<string> {
  // Every caller that wakes a box (Claude runner, asks, automations, preview
  // wakes) comes through here; the guarded write below would otherwise
  // happily move a quarantined row to `starting`.
  if (instance.status === QUARANTINED) throw new PowerRequestConflict(QUARANTINED_OWNER_ERROR);
  const to = POWER_TRANSITIONS[action].to;
  const data: Prisma.InstanceUpdateManyMutationInput = {
    status: to,
    provisioningError: null,
    rehibernatePending: !!opts.rehibernate,
  };
  // A start keeps hibernatedAt so a resume that doesn't take settles back to
  // hibernated; anything that powers the box down starts from a clean slate.
  if (action !== 'start') data.hibernatedAt = null;
  // A start begins with no warning: one from before the box went down
  // promises nothing now, so a warning on a `starting` box is the stuck-start
  // pass's, which the box list shows (Bugbot on #623).
  if (action === 'start') Object.assign(data, { idleWarnedAt: null, idleParkAt: null });
  if (opts.markInUse) Object.assign(data, boxInUseFields(instance.id));
  else if (opts.guestWake && action === 'start') Object.assign(data, guestWakeFields(instance.id));
  if (opts.byOwner && action !== 'start') data.lifecycleNote = null;
  // The refresh's start keeps the box's down clock on the row before its
  // re-hibernate resets hibernatedAt: a box hibernated before downSince was
  // recorded has only hibernatedAt to say when it went down.
  if (action === 'start' && opts.rehibernate) data.downSince = instance.downSince ?? instance.hibernatedAt;
  // A box going down from up ends its down clock, so the settle starts a new
  // one; only the refresh's own re-hibernate of an untouched box keeps it.
  else if (action !== 'start' && !sleepKeepsDownClock(instance, sleepByFor(opts))) data.downSince = null;
  if (opts.andSet) Object.assign(data, opts.andSet);
  // A box the lifecycle sweep has claimed for terminate stays down: the
  // claim leaves it hibernated, so the status alone wouldn't stop a start.
  const where: Prisma.InstanceWhereInput = { id: instance.id, status: instance.status, autoTerminatedAt: null };
  // And no resize holds it (an open resize row in box_events), checked in the
  // write itself so a caller that read the box before the lock can't move it
  // (Bugbot on #877). Only the resize's own stops and starts skip it.
  if (!opts.forResize) Object.assign(where, resizeFreeWhere());
  if ('expectLastActivityAt' in opts) where.lastActivityAt = opts.expectLastActivityAt ?? null;
  if ('expectIdleHibernateHours' in opts) where.idleHibernateHours = opts.expectIdleHibernateHours ?? null;
  if ('expectLastConnectedAt' in opts) where.lastConnectedAt = opts.expectLastConnectedAt ?? null;
  const moved = await prisma.instance.updateMany({ where, data });
  if (moved.count === 0) {
    const resizing = !opts.forResize && await resizeHolds(instance.id);
    throw new PowerRequestConflict(resizing ? RESIZING_ERROR : 'The box changed state; reload and try again');
  }
  const previousRequest = requestedAt.get(instance.id);
  const requested = Date.now();
  requestedAt.set(instance.id, requested);
  // Same instant as the timeout clock. `source` splits a caller's start from
  // the sweep's 60-day refresh, which is the only start this module makes itself.
  if (action === 'start') {
    armBoxStart(instance, opts.rehibernate ? 'sweep' : 'user', requested,
      opts.startedBy ?? (opts.markInUse ? 'owner' : opts.guestWake ? 'guest' : null));
  }
  // Whatever socket a hibernated box still holds predates the hibernate, and
  // only a fresh connect after the resume makes the box ready.
  if (action === 'start' && instance.status === 'hibernated') dropInstanceAgent(instance.id, 'resuming from hibernation');

  try {
    await sendPower(instance, action, opts);
  } catch (err) {
    if (action === 'hibernate' && isHibernateRefusal(err) && (opts.onHibernateRefused ?? 'stop') === 'stop') {
      const status = await fallBackToStop(instance, err);
      recordSleepRequested(instance, 'hibernate', status, sleepByFor(opts), requested);
      return status;
    }
    await revert(instance, to);
    // A request that didn't take leaves the box's earlier transition, and its
    // age, as they were: a stuck start's age must not restart (Devin on #623).
    if (previousRequest !== undefined) requestedAt.set(instance.id, previousRequest);
    throw err;
  }
  if (action !== 'start') recordSleepRequested(instance, action, to, sleepByFor(opts), requested);
  console.log(`[BOX] ${instance.name}: ${action} requested (${instance.ec2InstanceId})`);
  return to;
}

function sleepByFor(opts: RequestPowerOptions): SleepRequestedBy | null {
  return opts.sleepBy ?? (opts.byOwner ? 'owner' : null);
}

const RESIZING_ERROR = 'This box is being resized; try again once that is done';

/** Whether an open resize is why the guarded write matched nothing, for the error; false when it can't be read. */
async function resizeHolds(instanceId: string): Promise<boolean> {
  try {
    return (await prisma.instance.count({ where: { id: instanceId, NOT: resizeFreeWhere() } })) > 0;
  } catch {
    return false;
  }
}

async function revert(instance: Instance, from: string): Promise<void> {
  requestedAt.delete(instance.id);
  if (from === 'starting') recordBoxStartFailed(instance.id);
  else forgetSleepRequest(instance.id);
  await prisma.instance.updateMany({
    where: { id: instance.id, status: from },
    data: {
      status: instance.status,
      hibernatedAt: instance.hibernatedAt,
      rehibernatePending: instance.rehibernatePending,
      parkedAt: instance.parkedAt,
      autoParkedAt: instance.autoParkedAt,
      lifecycleNote: instance.lifecycleNote,
      lastActivityAt: instance.lastActivityAt,
      downSince: instance.downSince,
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
    // resets hibernatedAt), cleared by an owner's start (markInUse) and by
    // the lifecycle sweep's own stop (its andSet), so each of its stops
    // stamps it afresh here and terminate-after counts from the last one.
    // A stop starts it only when the lifecycle sweep asked for it
    // (autoParkedAt): the lifecycle sweep terminates such a box, never one
    // its owner stopped by hand.
    if (settlement.status === 'hibernated' && !box.parkedAt) data.parkedAt = new Date(now);
    if (settlement.status === 'stopped' && box.status === 'stopping' && box.autoParkedAt && !box.parkedAt) data.parkedAt = new Date(now);
    // The down clock for box.resumed's downMinutes, from the row alone: this
    // settle starts it unless one is already running. The connect that brings
    // the box up clears it (connectUpdate), except the 60-day refresh's, so
    // its re-hibernate keeps the clock from before the refresh, whichever
    // process settles it and after a restart.
    // A stop or hibernate that timed out back to ready leaves the box up for
    // use, so whatever clock it still had (the refresh's) ends here.
    const slept = sleepOutcome(box.status, settlement.status);
    if ((slept === 'stopped' || slept === 'hibernated') && !box.downSince) data.downSince = new Date(now);
    if (slept === 'failed') data.downSince = null;
    if (settlement.status && settlement.status !== 'ready') data.rehibernatePending = false;
    // A stop or hibernate that timed out back to ready didn't park the box,
    // so it isn't one the sweep parked and nobody touched: the next sweep's
    // park is a new one, with its notice (Bugbot on #621).
    if (settlement.status === 'ready' && (box.status === 'stopping' || box.status === 'hibernating')) data.autoParkedAt = null;
    const applied = await prisma.instance.updateMany({ where: { id: box.id, status: box.status }, data });
    if (applied.count === 0) continue;
    if (slept) recordSleepSettled(box, slept, now);
    if (box.status === 'starting') {
      if (settlement.status === 'stopped' || settlement.status === 'hibernated') recordBoxStartFailed(box.id, now);
      else if (settlement.provisioningError && !box.provisioningError) recordBoxStartStillStarting(box.id, now);
    }
    if (settlement.status) requestedAt.delete(box.id);
    if (settlement.status === 'hibernated') dropInstanceAgent(box.id, 'hibernated');
    if ((settlement.status === 'stopped' || settlement.status === 'hibernated') && box.autoParkedAt
      && (box.status === 'stopping' || box.status === 'hibernating')) {
      try { autoParkSettled?.(box, settlement.status); } catch (err) { console.warn(`[BOX] ${box.name}: auto-park notice failed:`, errMsg(err)); }
    }
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
      await requestPower(box, 'start', { rehibernate: true, startedBy: 'refresh' });
      console.log(`[BOX] ${box.name}: hibernated since ${box.hibernatedAt!.toISOString()}; resuming to hibernate it again`);
    } catch (err) {
      console.error(`[BOX] ${box.name}: 60-day hibernation refresh could not start it:`, errMsg(err));
    }
  }
}

/**
 * Put every box the refresh resumed back down once its agent is back, by a
 * stop: parking never hibernates, so a hibernated box goes back down as a
 * stopped one, keeping its parked clock.
 */
async function rehibernateRefreshedBoxes(): Promise<void> {
  const boxes = await prisma.instance.findMany({
    where: { status: 'ready', rehibernatePending: true, kind: 'ec2', ec2InstanceId: { not: null } },
  });
  const pending = new Set(boxes.map(b => b.id));
  for (const id of rehibernateAttempts.keys()) if (!pending.has(id)) rehibernateAttempts.delete(id);
  for (const box of boxes) {
    const attempt = (rehibernateAttempts.get(box.id) ?? 0) + 1;
    try {
      const row = box;
      // Only the sweep's own hibernate note is swapped: a box its owner
      // hibernated by hand keeps its note, so a reviewer can't wake it.
      const status = await requestPower(row, 'stop', { sleepBy: 'refresh', ...(isAutoHibernateNote(row.lifecycleNote) ? { andSet: { lifecycleNote: REFRESH_STOP_NOTE } } : {}) });
      rehibernateAttempts.delete(box.id);
      console.log(`[BOX] ${box.name}: 60-day hibernation refresh -> ${status}`);
    } catch (err) {
      if (err instanceof PowerRequestConflict) { rehibernateAttempts.delete(box.id); continue; }
      // The revert put rehibernatePending back, so the next sweep tries again.
      rehibernateAttempts.set(box.id, attempt);
      console.warn(`[BOX] ${box.name}: refresh stop attempt ${attempt} refused:`, errMsg(err));
    }
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startPowerSweep(intervalMs = 10 * 1000): void {
  if (sweepTimer) return;
  // The one 10 s loop with a tick span: it makes the EC2 calls that start and
  // stop boxes. Leader only, as
  // startLeaderWork starts it.
  const sweep = traceSweep('power', () => sweepPowerStates());
  const tick = () => sweep().catch(err => console.error('[BOX] Power sweep failed:', errMsg(err)));
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
