/**
 * Automatic box lifecycle: the sweep and the settings write.
 * The rules are in boxLifecyclePolicy.ts.
 *
 * Every five minutes, on the leader, each owned EC2 box that can hibernate
 * and has `idleHibernateHours` set is hibernated once it has been idle that
 * long. The hibernate goes through boxPower.requestPower with the plain-stop
 * fallback turned off: if EC2 refuses, the box stays ready and the next sweep
 * tries again. Just before each hibernate the box's agent scans for work
 * that exists only on the box (agent/unsaved-work.js).
 *
 * The same sweep terminates a box that has stayed hibernated for its
 * `hibernatedTerminateDays`, raised to the unsaved-work limit (90 days)
 * unless that scan came back clean. Nothing but a hibernated box is ever
 * terminated. Gated per owner and box by the feature flag
 * box-auto-lifecycle-enabled, default off.
 */
import { Prisma } from '@prisma/client';
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { getBoxConfig } from './boxProvisioner';
import { PowerRequestConflict, requestPower } from './boxPower';
import { instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import {
  autoHibernateNote,
  autoTerminateNote,
  BOX_AUTO_LIFECYCLE_FLAG,
  type IdleDecision,
  idleHibernateDecision,
  type LifecycleSettings,
  type TerminateDecision,
  terminateDecision,
  unsavedWorkTerminateDays,
} from './boxLifecyclePolicy';
import { boolVariation } from './featureFlags';
import { getAllStatuses } from './status';

export { BOX_AUTO_LIFECYCLE_FLAG };

export const LIFECYCLE_SWEEP_MS = 5 * 60 * 1000;

/**
 * Something that must not be interrupted by a hibernate. Given the candidate
 * box ids, answers the ones that are busy. A check that throws counts every
 * candidate as busy, so a broken check can only keep boxes up.
 */
export type BoxBusyCheck = (instanceIds: string[]) => Promise<Set<string>>;

const busyChecks = new Map<string, BoxBusyCheck>();

/** Register a busy check under a name; registering the same name again replaces it. */
export function registerBoxBusyCheck(name: string, check: BoxBusyCheck): void {
  busyChecks.set(name, check);
}

registerBoxBusyCheck('claude-runner', async ids => {
  const live = await prisma.claudeRunnerSession.findMany({
    where: { instanceId: { in: ids }, endedAt: null },
    select: { instanceId: true },
  });
  return new Set(live.map(r => r.instanceId));
});

async function busyBoxes(ids: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  if (ids.length === 0) return busy;
  for (const [name, check] of busyChecks) {
    try {
      for (const id of await check(ids)) busy.add(id);
    } catch (err) {
      console.error(`[LIFECYCLE] busy check ${name} failed; treating every box as busy:`, errMsg(err));
      for (const id of ids) busy.add(id);
    }
  }
  return busy;
}

function workingBoxes(): Set<string> {
  const working = new Set<string>();
  for (const s of getAllStatuses().values()) if (s.status === 'working' && s.instanceId) working.add(s.instanceId);
  return working;
}

export interface SweepResult { box: string; decision: IdleDecision | TerminateDecision; outcome?: string }

export const UNSAVED_WORK_CAPABILITY = 'unsaved-work-v1';
const UNSAVED_WORK_TIMEOUT_MS = 120_000;
const MAX_STORED_REPOS = 50;

/**
 * Terminates a box the sweep found past its limit. The default is the owner's
 * own terminate (archive the projects, revoke the tokens, tear down EC2),
 * loaded lazily because routes/instances imports this module.
 */
export type BoxTerminator = (user: User, box: Instance) => Promise<void>;

const defaultTerminator: BoxTerminator = async (user, box) => {
  const { terminateOwnedBox } = await import('../routes/instances');
  const result = await terminateOwnedBox(user, box.id, true);
  if (result.status !== 200) throw new Error(`terminate answered ${result.status}`);
};

let lastSweepAt: Date | null = null;
let sweeping = false;
let autoHibernations = 0;
let autoTerminations = 0;

/**
 * One pass. Never throws. A pass that starts while another is still running
 * (unsaved-work scans can take minutes) does nothing, so two never scan, and
 * then discard, the same box's scan.
 */
export async function runLifecycleSweep(now: number = Date.now(), terminator: BoxTerminator = defaultTerminator): Promise<SweepResult[]> {
  if (sweeping) return [];
  sweeping = true;
  try {
    lastSweepAt = new Date(now);
    if (!getBoxConfig()) return [];
    return [...await hibernatePass(now), ...await terminatePass(now, terminator)];
  } finally {
    sweeping = false;
  }
}

async function hibernatePass(now: number): Promise<SweepResult[]> {
  const boxes = await prisma.instance.findMany({
    where: {
      status: 'ready', kind: 'ec2', hibernationConfigured: true,
      idleHibernateHours: { not: null }, userId: { not: null }, ec2InstanceId: { not: null },
    },
    include: { user: true },
  });
  const busy = await busyBoxes(boxes.map(b => b.id));
  const working = workingBoxes();
  const results: SweepResult[] = [];
  for (const box of boxes) {
    try {
      results.push(await considerBox(box, box.user!, { nowMs: now, busy: busy.has(box.id), working: working.has(box.id) }));
    } catch (err) {
      console.error(`[LIFECYCLE] ${box.name}: sweep failed:`, errMsg(err));
    }
  }
  return results;
}

async function considerBox(
  box: Instance,
  user: User,
  facts: { nowMs: number; busy: boolean; working: boolean },
): Promise<SweepResult> {
  const flagOn = await boolVariation(BOX_AUTO_LIFECYCLE_FLAG, user, false, { id: box.id, name: box.name, kind: box.kind });
  const decision = idleHibernateDecision(box, { ...facts, flagOn });
  if (!decision.hibernate) return { box: box.name, decision };

  const scannedAt = await recordUnsavedWork(box);
  // The scan can take minutes; decide again on the box as it is now, so
  // typing, a working agent or a runner session during it keeps the box up.
  const fresh = await prisma.instance.findUnique({ where: { id: box.id } });
  if (!fresh) return { box: box.name, decision, outcome: 'conflict' };
  const recheck = idleHibernateDecision(fresh, {
    nowMs: facts.nowMs, flagOn,
    busy: (await busyBoxes([box.id])).has(box.id), working: workingBoxes().has(box.id),
  });
  if (!recheck.hibernate) {
    await discardUnsavedWork(box, scannedAt);
    return { box: box.name, decision: recheck };
  }
  try {
    const status = await requestPower(fresh, 'hibernate', { onHibernateRefused: 'throw' });
    await prisma.instance.updateMany({
      where: { id: box.id, status },
      data: { lifecycleNote: autoHibernateNote(box.idleHibernateHours!) },
    });
    autoHibernations++;
    console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): idle ${box.idleHibernateHours} h; hibernating`);
    return { box: box.name, decision, outcome: status };
  } catch (err) {
    await discardUnsavedWork(box, scannedAt);
    if (err instanceof PowerRequestConflict) return { box: box.name, decision, outcome: 'conflict' };
    console.warn(`[LIFECYCLE] ${box.name}: hibernate refused; trying again next sweep:`, errMsg(err));
    return { box: box.name, decision, outcome: 'refused' };
  }
}

/**
 * Ask the box's agent for work that exists only on the box, and store the
 * answer. A missing or old agent, or a scan that fails, is stored as an
 * error, which keeps the box for the long limit. The time stamped is the
 * scan's start, so activity during the scan makes it count as stale.
 * Returns that stamp, or null when the answer could not be stored.
 */
async function recordUnsavedWork(box: Instance): Promise<Date | null> {
  const startedAt = new Date();
  let scan: Record<string, unknown>;
  const transport = instanceAgentTransport(box.id);
  if (!transport) scan = { error: 'agent not connected' };
  else if (!transport.capabilities.includes(UNSAVED_WORK_CAPABILITY)) scan = { error: 'agent too old to scan for unsaved work' };
  else {
    try {
      const reply = await sendToInstanceAgent(box.id, 'unsaved-work', {}, UNSAVED_WORK_TIMEOUT_MS);
      scan = reply && typeof reply === 'object' ? reply : { error: 'empty reply' };
      if (Array.isArray(scan.repos)) scan = { ...scan, repos: scan.repos.slice(0, MAX_STORED_REPOS) };
    } catch (err) {
      scan = { error: errMsg(err) };
    }
  }
  try {
    await prisma.instance.update({
      where: { id: box.id },
      data: { unsavedWork: scan as Prisma.InputJsonValue, unsavedWorkCheckedAt: startedAt },
    });
    return startedAt;
  } catch (err) {
    console.warn(`[LIFECYCLE] ${box.name}: could not store the unsaved-work scan:`, errMsg(err));
    return null;
  }
}

/**
 * Drop the scan taken for an automatic hibernate that did not happen. Not all
 * activity bumps lastActivityAt (a runner session doesn't), so a clean scan
 * left behind could let a later manual hibernate go at the box's short limit.
 */
async function discardUnsavedWork(box: Instance, scannedAt: Date | null): Promise<void> {
  if (!scannedAt) return;
  try {
    await prisma.instance.updateMany({
      where: { id: box.id, unsavedWorkCheckedAt: scannedAt },
      data: { unsavedWork: Prisma.DbNull, unsavedWorkCheckedAt: null },
    });
  } catch (err) {
    console.warn(`[LIFECYCLE] ${box.name}: could not discard the unsaved-work scan:`, errMsg(err));
  }
}

async function terminatePass(now: number, terminator: BoxTerminator): Promise<SweepResult[]> {
  const boxes = await prisma.instance.findMany({
    where: {
      status: 'hibernated', kind: 'ec2', hibernationConfigured: true,
      hibernatedTerminateDays: { not: null }, parkedAt: { not: null },
      userId: { not: null }, ec2InstanceId: { not: null },
    },
    include: { user: true },
  });
  const unsavedLimitDays = unsavedWorkTerminateDays();
  const results: SweepResult[] = [];
  for (const box of boxes) {
    try {
      results.push(await considerTerminate(box, box.user!, { nowMs: now, unsavedLimitDays }, terminator));
    } catch (err) {
      console.error(`[LIFECYCLE] ${box.name}: terminate failed; trying again next sweep:`, errMsg(err));
      results.push({ box: box.name, decision: { terminate: false, reason: 'not-due' }, outcome: 'failed' });
    }
  }
  return results;
}

async function considerTerminate(
  box: Instance,
  user: User,
  facts: { nowMs: number; unsavedLimitDays: number },
  terminator: BoxTerminator,
): Promise<SweepResult> {
  const flagOn = await boolVariation(BOX_AUTO_LIFECYCLE_FLAG, user, false, { id: box.id, name: box.name, kind: box.kind });
  const decision = terminateDecision(box, { ...facts, flagOn });
  if (!decision.terminate) return { box: box.name, decision };

  // Claim the box only while it is still the hibernated box we decided on:
  // an owner's start in the meantime clears parkedAt and wins. Once claimed,
  // requestPower refuses every power change, so a start can't race the teardown.
  const claimedAt = new Date(facts.nowMs);
  const claimed = await prisma.instance.updateMany({
    where: { id: box.id, status: 'hibernated', parkedAt: box.parkedAt },
    data: { autoTerminatedAt: claimedAt, lifecycleNote: autoTerminateNote(decision.days) },
  });
  if (claimed.count === 0) return { box: box.name, decision, outcome: 'conflict' };
  try {
    await terminator(user, box);
  } catch (err) {
    // Let go of a box the terminate didn't reach: the claim blocks every
    // start, and the next sweep decides again (a setting or the flag may
    // have changed meanwhile) before claiming it afresh.
    await prisma.instance.updateMany({
      where: { id: box.id, status: 'hibernated', autoTerminatedAt: claimedAt },
      data: { autoTerminatedAt: null, lifecycleNote: box.lifecycleNote },
    }).catch(e => console.error(`[LIFECYCLE] ${box.name}: could not release the terminate claim:`, errMsg(e)));
    throw err;
  }
  autoTerminations++;
  console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): hibernated ${decision.days} d; terminated`);
  return { box: box.name, decision, outcome: 'terminated' };
}

/**
 * Write a box's lifecycle settings, with no owner check: the caller has done
 * that (the settings route), or owns the box itself (phase-2 sandbox boxes,
 * set at creation, with subagentLifecycleDefaults()). Turning auto-hibernate
 * on from off starts the idle clock now, so a box that sat unused for days
 * isn't hibernated on the next sweep; it leaves a parked box's parked state
 * and clock alone, which only an owner's start clears (a bumped clock would
 * also make its unsaved-work scan look stale).
 */
export async function setBoxLifecycle(instanceId: string, settings: Partial<LifecycleSettings>): Promise<void> {
  if (Object.keys(settings).length === 0) return;
  const before = await prisma.instance.findUnique({ where: { id: instanceId }, select: { idleHibernateHours: true, parkedAt: true } });
  const turningOn = settings.idleHibernateHours != null && before?.idleHibernateHours == null && before?.parkedAt == null;
  // One UPDATE, so no sweep can see auto-park on with the old idle clock.
  await prisma.instance.update({
    where: { id: instanceId },
    data: { ...settings, ...(turningOn ? { lastActivityAt: new Date() } : {}) },
  });
}

/** Boxes of this owner the sweep terminated in the last week, for the box list's notice. */
export async function recentAutoTerminations(userId: string, now: number = Date.now()) {
  return prisma.instance.findMany({
    where: { userId, status: 'terminated', autoTerminatedAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    select: { id: true, name: true, autoTerminatedAt: true, lifecycleNote: true },
    orderBy: { autoTerminatedAt: 'desc' },
  });
}

export function lifecycleSweepStatus(): { lastSweepAt: Date | null; autoHibernations: number; autoTerminations: number } {
  return { lastSweepAt, autoHibernations, autoTerminations };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startLifecycleSweep(intervalMs = LIFECYCLE_SWEEP_MS): void {
  if (sweepTimer) return;
  const tick = () => { runLifecycleSweep().catch(err => console.error('[LIFECYCLE] sweep failed:', errMsg(err))); };
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
}

export function stopLifecycleSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
