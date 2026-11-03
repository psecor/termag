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
 *
 * A box with no `idleHibernateHours` is left alone unless box-idle-stop-enabled
 * is on for its owner and box. Then it is plainly stopped after the default
 * window (`box-idle-park-hours`, else IDLE_STOP_DEFAULT_HOURS), even when it
 * can hibernate. Its owner is warned a lead first (`idleWarnedAt`/
 * `idleParkAt`, `box-idle-park-warn-minutes`), and the stop waits for the
 * time the warning promised. The same activity clock, guards and
 * unsaved-work scan apply.
 *
 * Parking never hibernates: a box's own `idleHibernateHours` stop it,
 * unannounced, whether or not it can hibernate, and the terminate pass takes a
 * `stopped` box auto-park stopped (its `parkedAt` is set) as well as one
 * hibernated before parking became a stop.
 */
import { Prisma } from '@prisma/client';
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { getBoxConfig } from './boxProvisioner';
import { onAutoParkSettled, powerRequestedAt, PowerRequestConflict, requestPower } from './boxPower';
import { automationsPausedMessage, automationsSkippedWhileParked, parkedMessage, sendIdleNotice, stuckStartMessage, stuckStartWarningMessage, warningMessage } from './boxIdleNotices';
import { recordProductEvent } from './productEvents';
import { boxEventDimensions } from './boxPowerEvents';
import { notifyWorkspaceChange } from './workspaceEvents';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from './agentRegistry';
import {
  askBoxLifecycle,
  autoStopNote,
  autoTerminateNote,
  BOX_AUTO_LIFECYCLE_FLAG,
  BOX_IDLE_PARK_HOURS_FLAG,
  BOX_IDLE_PARK_WARN_MINUTES_FLAG,
  BOX_IDLE_STOP_FLAG,
  DEFAULT_WARN_MINUTES,
  IDLE_HIBERNATE_MAX_HOURS,
  IDLE_STOP_DEFAULT_HOURS,
  type IdleDecision,
  idleHibernateDecision,
  idleSince,
  idleStopHours,
  type IdleLimit,
  type IdleStopOptions,
  isCleanScan,
  isIdleSkip,
  type LifecycleSettings,
  type LifecycleView,
  lifecycleView,
  STUCK_START_NOTE_PREFIX,
  type StuckStartDecision,
  stuckStartDecision,
  stuckStartNote,
  stuckStopPending,
  stuckStopRetryDecision,
  type TerminateDecision,
  terminateDecision,
  unsavedWorkTerminateDays,
  warnLeadMs,
} from './boxLifecyclePolicy';
import { powerTimeoutsFromEnv } from './boxPowerPolicy';
import type { FlagUser } from './featureFlags';
import { boolVariation, numberVariation } from './featureFlags';
import { getAllStatuses } from './status';
import { traceSweep } from './tracing/spans';

export { BOX_AUTO_LIFECYCLE_FLAG, BOX_IDLE_STOP_FLAG };

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

/**
 * How long an open runner session holds its box: the runner kills itself
 * after 12 h, so a row still open later belongs to a box whose agent never
 * reported the end, and must not keep that box up for good.
 */
export const RUNNER_BUSY_MAX_MS = 13 * 60 * 60 * 1000;

registerBoxBusyCheck('claude-runner', async ids => {
  const live = await prisma.claudeRunnerSession.findMany({
    where: { instanceId: { in: ids }, endedAt: null, startedAt: { gte: new Date(Date.now() - RUNNER_BUSY_MAX_MS) } },
    select: { instanceId: true },
  });
  return new Set(live.map(r => r.instanceId));
});

/**
 * Sustained load: at least LOAD_BUSY_MIN_SAMPLES of the box's last
 * LOAD_WINDOW_SAMPLES host samples (five minutes apart, so about half an
 * hour) at or above the per-core threshold. One sample is not enough: a
 * cron job, a box update or the unsaved-work scan itself would defer a box
 * for good. A box whose agent doesn't sample has no rows and isn't held.
 */
export const LOAD_WINDOW_SAMPLES = 6;
export const LOAD_BUSY_MIN_SAMPLES = 3;
const LOAD_WINDOW_MS = 35 * 60 * 1000;

export function busyLoadPerCore(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BOX_IDLE_BUSY_LOAD_PER_CORE);
  return Number.isFinite(n) && n > 0 ? n : 0.25;
}

registerBoxBusyCheck('host-load', async ids => {
  const samples = await prisma.hostSample.findMany({
    where: { instanceId: { in: ids }, at: { gte: new Date(Date.now() - LOAD_WINDOW_MS) } },
    select: { instanceId: true, load1: true, cores: true },
    orderBy: { at: 'desc' },
  });
  const threshold = busyLoadPerCore();
  const seen = new Map<string, number>();
  const hot = new Map<string, number>();
  for (const s of samples) {
    // A sample with no core count or no load can't say anything: it doesn't
    // take one of the six places either (Devin on #617).
    if (!s.cores || s.cores <= 0 || s.load1 === null) continue;
    const n = seen.get(s.instanceId) ?? 0;
    if (n >= LOAD_WINDOW_SAMPLES) continue;
    seen.set(s.instanceId, n + 1);
    if (s.load1 / s.cores >= threshold) hot.set(s.instanceId, (hot.get(s.instanceId) ?? 0) + 1);
  }
  return new Set([...hot].filter(([, n]) => n >= LOAD_BUSY_MIN_SAMPLES).map(([id]) => id));
});

/**
 * An open SSH or SSM session in the box's latest host sample (agent/host-sample.js):
 * VS Code or Cursor on Remote-SSH, scp and port forwards go straight to the
 * box and never move the idle clock. Only a sample from the last
 * SSH_SAMPLE_MAX_AGE_MS counts, so a box whose agent stopped sampling isn't
 * held by its last answer.
 */
const SSH_SAMPLE_MAX_AGE_MS = 15 * 60 * 1000;

registerBoxBusyCheck('ssh', async ids => {
  const open = await prisma.instance.findMany({
    where: { id: { in: ids }, sshSessions: { gt: 0 }, hostSampledAt: { gte: new Date(Date.now() - SSH_SAMPLE_MAX_AGE_MS) } },
    select: { id: true },
  });
  return new Set(open.map(b => b.id));
});

/**
 * An open native port forward. It doesn't move the
 * idle clock, so without this a box serving a forwarded dev server could
 * auto-park under it. Two sources: the box's latest host sample, in which the
 * agent counts the forwards itself (`tunnels.port`), so it holds whichever
 * orchestrator process carries the sockets, and only from the last
 * SSH_SAMPLE_MAX_AGE_MS, as for `ssh`; and the forwards this process carries
 * or is opening right now (setLiveTunnels), since a sample is up to five
 * minutes old and a forward opened after it would read as none (Devin on
 * #724). The sweep asks again after the unsaved-work scan, just before the
 * park. The desktop's t3 relay counts in neither: the app holds one open for
 * as long as it is connected, which would keep an idle box up for good. Soft
 * (SOFT_BUSY_CHECKS), like `ssh`: a forgotten `termag forward` with an HMR
 * socket open stops holding the box after SOFT_BUSY_CAP_MS without activity.
 */
let liveTunnels: (ids: string[]) => Set<string> = () => new Set();

/** Where the `tunnels` check reads this process's open forwards (AgentTunnels.boxesWithTunnels, 'port'); index.ts sets it. */
export function setLiveTunnels(source: (ids: string[]) => Set<string>): void {
  liveTunnels = source;
}

registerBoxBusyCheck('tunnels', async ids => {
  const open = await prisma.instance.findMany({
    where: { id: { in: ids }, openTunnels: { gt: 0 }, hostSampledAt: { gte: new Date(Date.now() - SSH_SAMPLE_MAX_AGE_MS) } },
    select: { id: true },
  });
  return new Set([...open.map(b => b.id), ...liveTunnels(ids)]);
});

/**
 * A box update the orchestrator asked for (services/boxUpdate.ts) and the box
 * hasn't reported yet: powering the box off mid-`npm ci` could leave it with
 * an agent that never starts. The report clears `updatePushedAt`
 * (boxUpdateReport.ts), so no box clock is compared. Bounded, since a box
 * whose script predates the report never sends one.
 */
export const BOX_UPDATE_BUSY_MS = 20 * 60 * 1000;

registerBoxBusyCheck('box-update', async ids => {
  const pushed = await prisma.instance.findMany({
    where: { id: { in: ids }, updatePushedAt: { gte: new Date(Date.now() - BOX_UPDATE_BUSY_MS) } },
    select: { id: true },
  });
  return new Set(pushed.map(b => b.id));
});

/**
 * Every check that reports each box busy, by name. A check that throws is
 * recorded as `<name>-failed` for every candidate, which no soft-check cap
 * lets go of, so a broken check can only keep boxes up.
 */
export async function busyBoxes(ids: string[]): Promise<Map<string, string[]>> {
  const busy = new Map<string, string[]>();
  if (ids.length === 0) return busy;
  const add = (id: string, check: string) => busy.set(id, [...(busy.get(id) ?? []), check]);
  for (const [name, check] of busyChecks) {
    try {
      for (const id of await check(ids)) add(id, name);
    } catch (err) {
      console.error(`[LIFECYCLE] busy check ${name} failed; treating every box as busy:`, errMsg(err));
      for (const id of ids) add(id, `${name}-failed`);
    }
  }
  return busy;
}

export function workingBoxes(): Set<string> {
  const working = new Set<string>();
  for (const s of getAllStatuses().values()) if (s.status === 'working' && s.instanceId) working.add(s.instanceId);
  return working;
}

export interface SweepResult { box: string; decision: IdleDecision | TerminateDecision | StuckStartDecision; outcome?: string }

/**
 * `box-idle-stop-enabled` for the owner and box, and only while it is on,
 * the default window's hours and warning lead. The box list's lifecycle
 * view reads them the same way.
 */
export async function idleStopOptionsFor(
  box: Pick<Instance, 'id' | 'name' | 'kind'>,
  user: FlagUser,
): Promise<Required<Pick<IdleStopOptions, 'idleStopOn' | 'idleStopHours'>> & Pick<IdleStopOptions, 'warnMinutes'>> {
  const ctx = { id: box.id, name: box.name, kind: box.kind };
  const idleStopOn = await boolVariation(BOX_IDLE_STOP_FLAG, user, false, ctx);
  if (!idleStopOn) return { idleStopOn, idleStopHours: idleStopHours(undefined) };
  const [hours, warnMinutes] = await Promise.all([
    numberVariation(BOX_IDLE_PARK_HOURS_FLAG, user, IDLE_STOP_DEFAULT_HOURS, ctx),
    numberVariation(BOX_IDLE_PARK_WARN_MINUTES_FLAG, user, DEFAULT_WARN_MINUTES, ctx),
  ]);
  return { idleStopOn, idleStopHours: idleStopHours(hours), warnMinutes };
}


/**
 * Parks the sweep asked for and hasn't told the owner about yet: sent when
 * the box settles (boxPower's onAutoParkSettled), so the DM says what EC2
 * actually did. A quiet re-park adds none. A box seen ready again (a stop
 * that timed out) is dropped. In memory: a restart between the request and
 * the settle loses the DM, never sends a wrong one.
 */
type PendingParkNotice = { limit: IdleLimit } | { stuckSince: Date | null };
const pendingParkNotices = new Map<string, PendingParkNotice>();

/** The busy check each held box was last deferred for, so each busy stretch is recorded once. */
const deferredFor = new Map<string, string>();

onAutoParkSettled((box, settled) => {
  const pending = pendingParkNotices.get(box.id);
  if (!pending) return;
  pendingParkNotices.delete(box.id);
  void tellOwnerParked(box, settled, pending);
});

async function tellOwnerParked(box: Instance, settled: 'stopped' | 'hibernated', pending: PendingParkNotice): Promise<void> {
  try {
    const owner = box.userId
      ? await prisma.user.findUnique({ where: { id: box.userId }, select: { id: true, slackUserId: true, googleEmail: true } })
      : null;
    const message = 'limit' in pending
      ? parkedMessage(box, settled, pending.limit, box.unsavedWork)
      : stuckStartMessage(box, pending.stuckSince);
    if (owner) await sendIdleNotice('parked', owner, box, message);
  } catch (err) {
    console.warn(`[LIFECYCLE] ${box.name}: parked notice failed:`, errMsg(err));
  }
}

/** How many boxes one pass parks at a time: each waits for an unsaved-work scan of up to two minutes. */
export const PARKS_AT_ONCE = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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
  // considerTerminate left out every box with an enabled automation; one
  // enabled since is paused and its owner told, not archived in silence.
  await pauseAutomationsForTerminate(box, 'lifecycle');
  const { terminateOwnedBox } = await import('../routes/instances');
  const result = await terminateOwnedBox(user, box.id, true);
  if (result.status !== 200) throw new Error(`terminate answered ${result.status}`);
};

let lastSweepAt: Date | null = null;
let sweeping = false;
let warnings = 0;
let autoStops = 0;
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
    return [...await hibernatePass(now), ...await stuckStartPass(now), ...await terminatePass(now, terminator)];
  } finally {
    sweeping = false;
  }
}

async function hibernatePass(now: number): Promise<SweepResult[]> {
  const boxes = await prisma.instance.findMany({
    where: {
      status: 'ready', kind: 'ec2', userId: { not: null }, ec2InstanceId: { not: null },
      // A box with no setting is a candidate only for box-idle-stop-enabled,
      // which considerBox reads before anything else happens to it.
    },
    include: { user: true },
  // A box whose stuck-start stop timed out back to ready is retryStuckStops's:
  // the idle rules would take it for a box woken without its owner (Bugbot on #623).
  }).then(rows => rows.filter(b => !stuckStopPending(b)));
  const ids = new Set(boxes.map(b => b.id));
  for (const id of [...deferredFor.keys()]) if (!ids.has(id)) deferredFor.delete(id);
  // A park that is still ready a pass later didn't happen (the stop timed out back to ready).
  for (const id of ids) pendingParkNotices.delete(id);
  const busy = await busyBoxes(boxes.map(b => b.id));
  const working = workingBoxes();
  const results = await mapLimit(boxes, PARKS_AT_ONCE, async box => {
    try {
      return await considerBox(box, box.user!, { nowMs: now, busy: busy.get(box.id) ?? [], working: working.has(box.id) });
    } catch (err) {
      console.error(`[LIFECYCLE] ${box.name}: sweep failed:`, errMsg(err));
      return null;
    }
  });
  return results.filter((r): r is SweepResult => r !== null);
}

/** Null for a box with no setting whose owner and box are not in box-idle-stop-enabled: nothing to report. */
async function considerBox(
  box: Instance,
  user: User,
  facts: { nowMs: number; busy: readonly string[]; working: boolean },
): Promise<SweepResult | null> {
  const boxContext = { id: box.id, name: box.name, kind: box.kind };
  const defaultWindow = box.idleHibernateHours == null;
  const stopOptions = defaultWindow ? await idleStopOptionsFor(box, user) : null;
  const idleStopOn = !!stopOptions?.idleStopOn;
  if (defaultWindow && !idleStopOn) {
    // A warning stands only while the flag is on: the box stayed up past
    // its promise because the flag was off, so it is warned afresh if the
    // flag comes back on.
    if (box.idleWarnedAt) {
      await prisma.instance.updateMany({ where: { id: box.id, idleWarnedAt: box.idleWarnedAt }, data: { idleWarnedAt: null, idleParkAt: null } });
    }
    return null;
  }
  if (!defaultWindow && box.idleWarnedAt) {
    // Own hours are never warned (a box's own hours park it unannounced), so
    // a warning left from the default window stands for nothing now.
    await prisma.instance.updateMany({ where: { id: box.id, idleWarnedAt: box.idleWarnedAt }, data: { idleWarnedAt: null, idleParkAt: null } });
  }
  const flagOn = defaultWindow ? false : await boolVariation(BOX_AUTO_LIFECYCLE_FLAG, user, false, boxContext);
  const defaultHours = stopOptions?.idleStopHours ?? IDLE_STOP_DEFAULT_HOURS;
  const window = { idleStopOn, idleStopHours: defaultHours, leadMs: warnLeadMs(stopOptions?.warnMinutes, defaultHours) };
  const decision = idleHibernateDecision(box, { ...facts, flagOn, ...window });
  noteDeferral(box, user, decision);
  if ('warn' in decision) return warnOwner(box, user, decision, defaultHours, facts.nowMs);
  if (isIdleSkip(decision)) return { box: box.name, decision };

  const scannedAt = await recordUnsavedWork(box);
  // The scan can take minutes; decide again on the box as it is now, so
  // typing, a working agent or a runner session during it keeps the box up.
  const fresh = await prisma.instance.findUnique({ where: { id: box.id } });
  if (!fresh) return { box: box.name, decision, outcome: 'conflict' };
  const recheck = idleHibernateDecision(fresh, {
    nowMs: facts.nowMs, flagOn, ...window,
    busy: (await busyBoxes([box.id])).get(box.id) ?? [], working: workingBoxes().has(box.id),
  });
  // A box that changed during the scan so that it needs a (new) warning gets
  // it from the next pass.
  if (isIdleSkip(recheck) || 'warn' in recheck) {
    await discardUnsavedWork(box, scannedAt);
    return { box: box.name, decision: recheck };
  }
  const hours = fresh.idleHibernateHours ?? defaultHours;
  try {
    const quiet = 'quiet' in recheck && !!recheck.quiet;
    const limit: IdleLimit = { hours, source: fresh.idleHibernateHours != null ? 'own' : 'default' };
    // Only the default window's stop is one its owner didn't set up, so only
    // it is told (an ask's box parks on its own hour, unannounced), and a quiet
    // re-park was told already. Registered before the request: a power sweep
    // can settle the box before it returns (Devin on #621).
    if (!quiet && limit.source === 'default') pendingParkNotices.set(box.id, { limit });
    // Guarded on the clock and the setting the decision read: a keystroke,
    // Keep running or a new idle setting after the re-read turns the park
    // into a conflict. The note and autoParkedAt go in the same write as the
    // status, so a power sweep that settles the box at once still sees them.
    const guard = {
      expectLastActivityAt: fresh.lastActivityAt,
      expectIdleHibernateHours: fresh.idleHibernateHours,
      // parkedAt goes, so the settle stamps it afresh: terminate-after counts
      // from when the box last became stopped, not from an earlier park it
      // was woken from without its owner (babysit-1027, 2026-10-30).
      andSet: { lifecycleNote: autoStopNote(hours), autoParkedAt: new Date(facts.nowMs), parkedAt: null },
      sleepBy: 'idle' as const,
    };
    const status = await requestPower(fresh, 'stop', guard);
    autoStops++;
    notifyWorkspaceChange(user.id, 'boxes');
    recordProductEvent('box.parked', { user: user.id, box: box.id }, {
      action: 'stop', limitHours: hours, limitSource: limit.source, quiet,
      scan: scanState(fresh.unsavedWork), cause: 'idle', ...boxEventDimensions(fresh),
    });
    console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): idle ${idleHours(fresh, facts.nowMs)} h of ${hours} h`
      + `${quiet ? ', untouched since its last auto-park' : ''}; stopping`);
    return { box: box.name, decision: recheck, outcome: status };
  } catch (err) {
    pendingParkNotices.delete(box.id);
    await discardUnsavedWork(box, scannedAt);
    if (err instanceof PowerRequestConflict) return { box: box.name, decision: recheck, outcome: 'conflict' };
    console.warn(`[LIFECYCLE] ${box.name}: stop refused; trying again next sweep:`, errMsg(err));
    return { box: box.name, decision: recheck, outcome: 'refused' };
  }
}

/**
 * Stop the boxes stuck in `starting`: started two start timeouts ago, their
 * agent never connected (stuckStartDecision). They bill and nobody can use
 * them. No scan, since there is no agent to ask, and no warning, since
 * there is nothing on them to keep up; the owner is told once the stop settles.
 */
async function stuckStartPass(now: number): Promise<SweepResult[]> {
  const boxes = await prisma.instance.findMany({
    where: { status: 'starting', kind: 'ec2', userId: { not: null }, ec2InstanceId: { not: null } },
    include: { user: true },
  });
  const startTimeoutMs = powerTimeoutsFromEnv().startMs;
  const results: SweepResult[] = [...await retryStuckStops(now)];
  for (const box of boxes) {
    try {
      const facts = {
        nowMs: now, startRequestedAt: powerRequestedAt(box.id), agentConnected: isInstanceAgentConnected(box.id),
        startTimeoutMs, leadMs: 0, busy: [] as readonly string[], flagOn: true,
      };
      // The cheap checks first: the flags and the busy checks only for a box that is stuck.
      if (stuckStartDecision(box, facts).act === 'none') continue;
      // Behind box-idle-stop-enabled, like the default window's stop; the
      // lead is its warning minutes, not capped by any window.
      const options = await idleStopOptionsFor(box, box.user!);
      const decision = stuckStartDecision(box, {
        ...facts, flagOn: options.idleStopOn,
        leadMs: warnLeadMs(options.warnMinutes, IDLE_HIBERNATE_MAX_HOURS),
        busy: (await busyBoxes([box.id])).get(box.id) ?? [],
      });
      const since = new Date(facts.startRequestedAt!);
      if (decision.act === 'none') {
        // As for the default window, a warning stands only while the flag is on.
        if (decision.reason === 'flag-off' && box.idleWarnedAt) {
          await prisma.instance.updateMany({
            where: { id: box.id, status: 'starting', idleWarnedAt: box.idleWarnedAt }, data: { idleWarnedAt: null, idleParkAt: null },
          });
        }
        if (decision.reason !== 'warned') results.push({ box: box.name, decision });
        continue;
      }
      if (decision.act === 'warn') {
        const applied = await prisma.instance.updateMany({
          where: { id: box.id, status: 'starting', idleWarnedAt: box.idleWarnedAt },
          data: { idleWarnedAt: new Date(now), idleParkAt: decision.stopAt },
        });
        if (applied.count === 0) continue;
        warnings++;
        notifyWorkspaceChange(box.user!.id, 'boxes');
        recordProductEvent('box.idle.warned', { user: box.userId, box: box.id }, {
          cause: 'stuck-start', leadMinutes: Math.round((decision.stopAt.getTime() - now) / 60_000),
        });
        console.log(`[LIFECYCLE] ${box.name} (${box.user!.unixUsername}): started ${since.toISOString()}, agent never connected; warned, stops at ${decision.stopAt.toISOString()}`);
        await sendIdleNotice('warning', box.user!, box, stuckStartWarningMessage(box, since, decision.stopAt, now));
        results.push({ box: box.name, decision, outcome: 'warned' });
        continue;
      }
      // Registered before the request, as for an idle park, so a quick settle finds it.
      pendingParkNotices.set(box.id, { stuckSince: since });
      let status: string;
      try {
        status = await requestPower(box, 'stop', { andSet: { lifecycleNote: stuckStartNote(since), autoParkedAt: new Date(now), parkedAt: null }, sleepBy: 'stuck-start' });
      } catch (err) {
        pendingParkNotices.delete(box.id);
        throw err;
      }
      autoStops++;
      notifyWorkspaceChange(box.user!.id, 'boxes');
      recordProductEvent('box.parked', { user: box.userId, box: box.id }, { action: 'stop', quiet: false, scan: 'unknown', cause: 'stuck-start', ...boxEventDimensions(box) });
      console.log(`[LIFECYCLE] ${box.name} (${box.user!.unixUsername}): started ${since.toISOString()}, agent never connected; ${status}`);
      results.push({ box: box.name, decision, outcome: status });
    } catch (err) {
      if (err instanceof PowerRequestConflict) continue;
      console.warn(`[LIFECYCLE] ${box.name}: stopping a box stuck starting failed; trying again next sweep:`, errMsg(err));
    }
  }
  return results;
}

/** Stop again the boxes whose stuck-start stop timed out back to ready (stuckStopRetryDecision). */
async function retryStuckStops(now: number): Promise<SweepResult[]> {
  const boxes = await prisma.instance.findMany({
    where: {
      status: 'ready', kind: 'ec2', userId: { not: null }, ec2InstanceId: { not: null },
      lifecycleNote: { startsWith: STUCK_START_NOTE_PREFIX },
    },
    include: { user: true },
  });
  const results: SweepResult[] = [];
  for (const box of boxes) {
    try {
      const agentConnected = isInstanceAgentConnected(box.id);
      if (!stuckStopRetryDecision(box, { flagOn: true, agentConnected, busy: [] })) continue;
      const { idleStopOn } = await idleStopOptionsFor(box, box.user!);
      const busy = (await busyBoxes([box.id])).get(box.id) ?? [];
      if (!stuckStopRetryDecision(box, { flagOn: idleStopOn, agentConnected, busy })) continue;
      pendingParkNotices.set(box.id, { stuckSince: null });
      let status: string;
      try {
        // Guarded like an idle park: Keep running (the idle clock) or an
        // agent connecting since the decision turns it into a conflict (Bugbot on #623).
        status = await requestPower(box, 'stop', {
          expectLastActivityAt: box.lastActivityAt,
          expectLastConnectedAt: box.lastConnectedAt,
          andSet: { autoParkedAt: new Date(now), parkedAt: null },
          sleepBy: 'stuck-start',
        });
      } catch (err) {
        pendingParkNotices.delete(box.id);
        throw err;
      }
      autoStops++;
      notifyWorkspaceChange(box.user!.id, 'boxes');
      recordProductEvent('box.parked', { user: box.userId, box: box.id }, { action: 'stop', quiet: false, scan: 'unknown', cause: 'stuck-start', ...boxEventDimensions(box) });
      console.log(`[LIFECYCLE] ${box.name} (${box.user!.unixUsername}): its stuck-start stop didn't take and no agent came back; ${status} again`);
      results.push({ box: box.name, decision: { act: 'stop' }, outcome: status });
    } catch (err) {
      if (err instanceof PowerRequestConflict) continue;
      console.warn(`[LIFECYCLE] ${box.name}: stopping a box stuck starting again failed; trying again next sweep:`, errMsg(err));
    }
  }
  return results;
}

/**
 * Record the default window's warning and the stop time it promises,
 * guarded on the clock and the warning the decision read, so two passes (a
 * deploy's overlap) or a keystroke in between can't make a second or a
 * stale one.
 */
async function warnOwner(
  box: Instance, user: User, decision: Extract<IdleDecision, { warn: true }>, hours: number, nowMs: number,
): Promise<SweepResult> {
  const applied = await prisma.instance.updateMany({
    where: { id: box.id, status: 'ready', lastActivityAt: box.lastActivityAt, idleWarnedAt: box.idleWarnedAt },
    data: { idleWarnedAt: new Date(nowMs), idleParkAt: decision.stopAt },
  });
  if (applied.count === 0) return { box: box.name, decision, outcome: 'conflict' };
  warnings++;
  // Open tabs reload the box list, so the row's countdown and Keep running show (Devin on #622).
  notifyWorkspaceChange(user.id, 'boxes');
  console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): idle ${idleHours(box, nowMs)} h of ${hours} h; warned, stops at ${decision.stopAt.toISOString()}`);
  recordProductEvent('box.idle.warned', { user: user.id, box: box.id }, {
    limitHours: hours, leadMinutes: Math.round((decision.stopAt.getTime() - nowMs) / 60_000),
  });
  // Only the process whose write took gets here, so the DM goes once.
  const skippedAutomations = await automationsSkippedWhileParked(box.id);
  // In minutes for a short window: the 2 h window is warned an hour in (Bugbot on #621).
  const idleMs = nowMs - idleSince(box).getTime();
  await sendIdleNotice('warning', user, box, warningMessage(box, { action: 'stop', parkAt: decision.stopAt, idleMs, skippedAutomations }, nowMs));
  return { box: box.name, decision, outcome: 'warned' };
}

/** Record what held a box up, once per busy stretch. */
function noteDeferral(box: Instance, user: User, decision: IdleDecision): void {
  if (!isIdleSkip(decision) || decision.reason !== 'busy' || !decision.check) {
    deferredFor.delete(box.id);
    return;
  }
  if (deferredFor.get(box.id) === decision.check) return;
  deferredFor.set(box.id, decision.check);
  recordProductEvent('box.park.deferred', { user: user.id, box: box.id }, { check: decision.check });
}

/** The unsaved-work scan, as box.parked reports it. */
function scanState(scan: unknown): 'clean' | 'unsaved' | 'unknown' {
  if (!scan || typeof scan !== 'object' || Array.isArray(scan) || 'error' in scan) return 'unknown';
  return isCleanScan(scan) ? 'clean' : 'unsaved';
}

function idleHours(box: Instance, nowMs: number): number {
  return Math.floor((nowMs - idleSince(box).getTime()) / (60 * 60 * 1000));
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
      kind: 'ec2', hibernatedTerminateDays: { not: null }, parkedAt: { not: null },
      userId: { not: null }, ec2InstanceId: { not: null },
      // A stopped box's parkedAt says auto-park stopped it.
      OR: [{ status: 'hibernated', hibernationConfigured: true }, { status: 'stopped' }],
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

/** The enabled automations whose project lives on the box, by name. */
async function enabledAutomationsOn(boxId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.automation.findMany({
    where: { enabled: true, project: { instanceId: boxId, archived: false } },
    select: { id: true, project: { select: { name: true } } },
  });
  return rows.map(r => ({ id: r.id, name: r.project.name }));
}

/** Boxes already logged as kept for their automations, so the line comes once per process, not every sweep. */
const keptForAutomation = new Set<string>();

/**
 * A terminate that goes ahead on a box with enabled automations (one enabled
 * between the sweep's check and its terminate; an admin's, should one come):
 * each is paused as `box_gone`, so it shows as paused rather than vanishing
 * with its archived project, and the owner is told which, by the same DM as
 * the idle notices. Returns the names paused. Never throws.
 */
export async function pauseAutomationsForTerminate(box: Pick<Instance, 'id' | 'name' | 'userId'>, by: 'lifecycle' | 'admin'): Promise<string[]> {
  try {
    const automations = await enabledAutomationsOn(box.id);
    if (automations.length === 0) return [];
    await prisma.automation.updateMany({ where: { id: { in: automations.map(a => a.id) } }, data: { pausedReason: 'box_gone' } });
    const names = automations.map(a => a.name);
    console.warn(`[LIFECYCLE] ${box.name}: terminated by ${by === 'admin' ? 'an admin' : 'the lifecycle sweep'} with automations on it; paused ${names.join(', ')}`);
    const owner = box.userId
      ? await prisma.user.findUnique({ where: { id: box.userId }, select: { id: true, slackUserId: true, googleEmail: true } })
      : null;
    if (owner) await sendIdleNotice('automation-paused', owner, box, automationsPausedMessage(box, names, by));
    return names;
  } catch (err) {
    console.error(`[LIFECYCLE] ${box.name}: could not pause its automations before the terminate:`, errMsg(err));
    return [];
  }
}

async function considerTerminate(
  box: Instance,
  user: User,
  facts: { nowMs: number; unsavedLimitDays: number },
  terminator: BoxTerminator,
): Promise<SweepResult> {
  const flagOn = await boolVariation(BOX_AUTO_LIFECYCLE_FLAG, user, false, { id: box.id, name: box.name, kind: box.kind });
  let decision = terminateDecision(box, { ...facts, flagOn });
  if (!decision.terminate) return { box: box.name, decision };
  // Only a box that is due is asked about its automations: the query is per box.
  const automations = await enabledAutomationsOn(box.id);
  decision = terminateDecision(box, { ...facts, flagOn, hostsAutomation: automations.length > 0 });
  if (!decision.terminate) {
    if (!keptForAutomation.has(box.id)) {
      keptForAutomation.add(box.id);
      console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): due to terminate, kept: it hosts ${automations.map(a => a.name).join(', ')}`);
    }
    return { box: box.name, decision };
  }
  keptForAutomation.delete(box.id);

  // Claim the box only while it is still the parked box we decided on:
  // an owner's start in the meantime clears parkedAt and wins. Once claimed,
  // requestPower refuses every power change, so a start can't race the teardown.
  const claimedAt = new Date(facts.nowMs);
  const claimed = await prisma.instance.updateMany({
    where: { id: box.id, status: box.status, parkedAt: box.parkedAt },
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
      where: { id: box.id, status: box.status, autoTerminatedAt: claimedAt },
      data: { autoTerminatedAt: null, lifecycleNote: box.lifecycleNote },
    }).catch(e => console.error(`[LIFECYCLE] ${box.name}: could not release the terminate claim:`, errMsg(e)));
    throw err;
  }
  autoTerminations++;
  console.log(`[LIFECYCLE] ${box.name} (${user.unixUsername}): ${box.status} ${decision.days} d; terminated`);
  return { box: box.name, decision, outcome: 'terminated' };
}

/**
 * Write a box's lifecycle settings, with no owner check: the caller has done
 * that (the settings route), or made the box itself (applyAskBoxPolicy).
 * Turning auto-hibernate
 * on from off starts the idle clock now, so a box that sat unused for days
 * isn't hibernated on the next sweep; it leaves a parked box's parked state
 * and clock alone, which only an owner's start clears (a bumped clock would
 * also make its unsaved-work scan look stale).
 */
/**
 * The lifecycle block on the box list and the settings answer. Reads
 * `box-idle-stop-enabled` (and its two number flags) for a box with no idle
 * hours, and `box-auto-lifecycle-enabled` for one with its own, so its park
 * time and warning are the ones the sweep acts on.
 */
export async function lifecycleViewFor(
  user: FlagUser,
  box: Parameters<typeof lifecycleView>[0] & { id: string; name: string; kind: string },
  nowMs: number = Date.now(),
): Promise<LifecycleView> {
  const options: IdleStopOptions = box.idleHibernateHours == null
    ? await idleStopOptionsFor(box, user)
    : { autoLifecycleOn: await boolVariation(BOX_AUTO_LIFECYCLE_FLAG, user, false, { id: box.id, name: box.name, kind: box.kind }) };
  // A parked box the sweep would terminate shows no date while it hosts an
  // enabled automation (terminateDecision); asked only of those.
  if (box.parkedAt && box.hibernatedTerminateDays != null) options.hostsAutomation = (await enabledAutomationsOn(box.id)).length > 0;
  return lifecycleView(box, unsavedWorkTerminateDays(), options, nowMs);
}

export async function setBoxLifecycle(instanceId: string, settings: Partial<LifecycleSettings>): Promise<void> {
  if (Object.keys(settings).length === 0) return;
  const before = await prisma.instance.findUnique({ where: { id: instanceId }, select: { idleHibernateHours: true, parkedAt: true } });
  const turningOn = settings.idleHibernateHours != null && before?.idleHibernateHours == null && before?.parkedAt == null;
  // Turning its own hours off puts the box under the default window, whose
  // quiet re-park is for a box its owner was told the window stopped. A
  // hibernate on its own hours wasn't that, so it is forgotten.
  const turningOff = settings.idleHibernateHours === null && before?.idleHibernateHours != null;
  // One UPDATE, so no sweep can see auto-park on with the old idle clock.
  await prisma.instance.update({
    where: { id: instanceId },
    data: { ...settings, ...(turningOn ? { lastActivityAt: new Date() } : {}), ...(turningOff ? { autoParkedAt: null } : {}) },
  });
}

/**
 * Everything a box made for an ask gets, in one place: the record
 * (`createdFor: 'ask'`) and askBoxLifecycle()'s settings (stopped by the
 * default idle window, never hibernated, never terminated on its own). Its
 * size was decided at the create (boxSize.decideBoxSize with forAsk). Called
 * once, right after the create, by whoever made it (the CLI's box create
 * with `createdFor: 'ask'`: `termag ask --new-box`, and the deprecated
 * `--for-ask`).
 */
export async function applyAskBoxPolicy(instanceId: string): Promise<void> {
  await prisma.instance.update({ where: { id: instanceId }, data: { createdFor: 'ask' } });
  await setBoxLifecycle(instanceId, askBoxLifecycle());
}

/** Boxes of this owner the sweep terminated in the last week, for the box list's notice. */
export async function recentAutoTerminations(userId: string, now: number = Date.now()) {
  return prisma.instance.findMany({
    where: { userId, status: 'terminated', autoTerminatedAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    select: { id: true, name: true, autoTerminatedAt: true, lifecycleNote: true },
    orderBy: { autoTerminatedAt: 'desc' },
  });
}

export function lifecycleSweepStatus(): {
  lastSweepAt: Date | null; warnings: number; autoStops: number; autoTerminations: number;
} {
  return { lastSweepAt, warnings, autoStops, autoTerminations };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startLifecycleSweep(intervalMs = LIFECYCLE_SWEEP_MS): void {
  if (sweepTimer) return;
  const sweep = traceSweep('lifecycle', () => runLifecycleSweep());
  const tick = () => { sweep().catch(err => console.error('[LIFECYCLE] sweep failed:', errMsg(err))); };
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
}

export function stopLifecycleSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
