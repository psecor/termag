/**
 * The automation scheduler: leader work,
 * one pass a minute. Each pass times out runs past their limit, resolves
 * runs waiting for their box, enumerates the occurrences every enabled
 * automation has reached, admits each and starts a run, then retires the
 * worktrees of finished runs beyond keepRuns. Completion is not here: the
 * chat relay finishes a run when its turn ends (complete.ts).
 *
 * Two orchestrator processes can both run a pass during an overlap deploy;
 * the unique (automationId, scheduledFor, trigger) key on the run row is
 * what keeps one occurrence to one run.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected, sendForProject } from '../agentRegistry';
import { wakeAction } from '../agentMessages';
import { registerBoxBusyCheck } from '../boxLifecycle';
import { requestPower } from '../boxPower';
import { CHAT_AUTO_CAPABILITY, CHAT_RUNNER_CAPABILITY, chatKeyFor } from '../chatRunner';
import { boolVariation } from '../featureFlags';
import { removeWorkstreamFor } from '../../routes/workstreams';
import { admitRun, type AdmitDecision } from './admit';
import { reportRun, settleInterruptedRun } from './complete';
import { automationLimitsFor, type AutomationLimits } from './limits';
import { startRun } from './runner';
import { MAX_ENUMERATED, newestOccurrence, occurrenceMinute, occurrencesBetween, nextOccurrence } from './schedule';
import { FINISHED_RUN_STATES } from './store';

export const AUTOMATIONS_FLAG = 'automations-enabled';
export const TICK_MS = 60_000;
/** How long after an interrupt the turn gets to stop writing before its notes are pushed (agent INTERRUPT_GRACE_MS is 3 s). */
export const NOTES_PUSH_DELAY_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

type Row = Prisma.AutomationGetPayload<{ include: { project: { include: { user: { select: { id: true; unixUsername: true; googleEmail: true; displayName: true; defaultAgentProvider: true } }; instance: true } } } }>;

const ROW_INCLUDE = {
  project: { include: { user: { select: { id: true, unixUsername: true, googleEmail: true, displayName: true, defaultAgentProvider: true } }, instance: true } },
} satisfies Prisma.AutomationInclude;

/** Run-minutes the owner has spent today (UTC), live runs counted so far. */
export async function dailyMinutesUsed(userId: string, now: Date): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await prisma.automationRun.findMany({
    where: { automation: { userId }, startedAt: { gte: dayStart } },
    select: { startedAt: true, finishedAt: true, state: true },
  });
  let ms = 0;
  for (const r of rows) {
    if (!r.startedAt) continue;
    const end = r.finishedAt ?? (r.state === 'running' ? now : r.startedAt);
    ms += Math.max(0, end.getTime() - r.startedAt.getTime());
  }
  return Math.round(ms / 60_000);
}

async function liveRunsOnBox(instanceId: string): Promise<number> {
  return prisma.automationRun.count({ where: { instanceId, state: 'running' } });
}

async function previousLive(automationId: string, exceptRunId: string): Promise<boolean> {
  return (await prisma.automationRun.count({ where: { automationId, state: { in: ['pending', 'running'] }, id: { not: exceptRunId } } })) > 0;
}

/** Whether this automation's owner has the flag on for its box. */
async function flagOn(a: Row): Promise<boolean> {
  const box = a.project.instance ? { id: a.project.instance.id, name: a.project.instance.name, kind: a.project.instance.kind } : null;
  return boolVariation(AUTOMATIONS_FLAG, a.project.user, false, box);
}

function runnerCapable(instanceId: string, tier: string): boolean {
  const caps = instanceAgentTransport(instanceId)?.capabilities ?? [];
  if (!caps.includes(CHAT_RUNNER_CAPABILITY)) return false;
  return tier === 'full' ? caps.includes(CHAT_AUTO_CAPABILITY) : true;
}

/** What decideAndStart says: the admit decision, or a start that failed on the box. */
export type StartDecision = AdmitDecision | { kind: 'failed'; reason: string; error: string };

/** Decide one run row: start it, leave it pending, skip it, or report the start's failure. Exported for the route's Run now. */
export async function decideAndStart(a: Row, runId: string, limits: AutomationLimits, now: Date): Promise<StartDecision> {
  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  if (!run || (run.state !== 'pending')) return { kind: 'skip', reason: 'paused' };
  const inst = a.project.instance;
  const decision = admitRun({
    pausedReason: a.pausedReason,
    flagOn: await flagOn(a),
    previousLive: await previousLive(a.id, run.id),
    dailyMinutesUsed: await dailyMinutesUsed(a.userId, now),
    boxLiveRuns: inst ? await liveRunsOnBox(inst.id) : 0,
    boxWake: wakeAction(inst?.status ?? null),
    boxConnected: inst ? isInstanceAgentConnected(inst.id) : false,
    runnerCapable: inst ? runnerCapable(inst.id, a.tier) : false,
    wakeBox: a.wakeBox,
    limits,
  });
  if (decision.kind === 'skip') {
    // Only a row still pending is this decision's: another leader, or Run now
    // against resolvePending, may have claimed and started it meanwhile, and
    // a live turn's row must stay `running` for completion, the timeout and Stop.
    const skipped = await prisma.automationRun.updateMany({ where: { id: run.id, state: 'pending' }, data: { state: 'skipped', reason: decision.reason, finishedAt: now } });
    if (skipped.count === 0) return { kind: 'skip', reason: 'previous_running' };
    if (decision.reason === 'box_gone') await prisma.automation.update({ where: { id: a.id }, data: { pausedReason: 'box_gone' } });
    console.log(`[AUTOMATION] ${a.project.user.unixUsername} ${a.project.name} ${run.scheduledFor.toISOString()} → skipped ${decision.reason}`);
    return decision;
  }
  if (decision.kind === 'pending') {
    if (decision.wake && inst) {
      try {
        await requestPower(inst, 'start');
        console.log(`[AUTOMATION] ${a.project.name}: starting box ${inst.name} for ${run.scheduledFor.toISOString()}`);
      } catch (err) {
        console.warn(`[AUTOMATION] ${a.project.name}: could not start box ${inst.name}: ${(err as Error).message}`);
      }
    }
    return decision;
  }
  if (!inst) return { kind: 'skip', reason: 'box_gone' };
  // Claim the start: `running` with startedAt before anything happens on the
  // box, so a second process does not start the same run.
  const claimed = await prisma.automationRun.updateMany({
    where: { id: run.id, state: 'pending' },
    data: { state: 'running', startedAt: now, instanceId: inst.id },
  });
  if (claimed.count === 0) return { kind: 'skip', reason: 'previous_running' };
  // The box's cap was read before the claim, and two leader processes can
  // both have seen room for one more. The claims are rows, so after it the
  // box's running rows are ordered and this one steps back if it is beyond
  // the cap; both processes see the same order, so only the excess does.
  const live = await prisma.automationRun.findMany({ where: { instanceId: inst.id, state: 'running' }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  if (live.findIndex(r => r.id === run.id) >= limits.perBoxConcurrent) {
    await prisma.automationRun.updateMany({ where: { id: run.id, state: 'running' }, data: { state: 'skipped', reason: 'box_concurrent', finishedAt: now, startedAt: null, instanceId: null } });
    console.log(`[AUTOMATION] ${a.project.name} ${run.scheduledFor.toISOString()} → skipped box_concurrent (claimed past the box's cap)`);
    return { kind: 'skip', reason: 'box_concurrent' };
  }
  const outcome = await startRun({
    automation: a, run: { ...run, state: 'running', startedAt: now, instanceId: inst.id },
    project: { id: a.project.id, name: a.project.name, userId: a.project.userId, instanceId: inst.id, repoDefaultBranch: a.project.repoDefaultBranch, chatTrustedAt: a.project.chatTrustedAt },
    owner: a.project.user, box: { id: inst.id, hostHome: inst.hostHome },
  });
  if (outcome.kind === 'failed') {
    const skip = outcome.reason === 'runner_outdated';
    // Only a row still running is ours to fail: a fast turn may have ended
    // (and completion written the row) before the send's error came back.
    const failed = await prisma.automationRun.updateMany({
      where: { id: run.id, state: 'running' },
      data: { state: skip ? 'skipped' : 'failed', reason: outcome.reason, summary: outcome.error, finishedAt: new Date() },
    });
    if (failed.count > 0) {
      if (!skip) await noteFailure(a, limits);
      console.warn(`[AUTOMATION] ${a.project.name} ${run.scheduledFor.toISOString()} → ${skip ? 'skipped' : 'failed'} ${outcome.reason}: ${outcome.error}`);
      // No turn, so no turn-end: the channel hears about a failed launch from here.
      if (!skip) await reportRun(run.id).catch(err => console.warn(`[AUTOMATION] ${a.project.name}: report failed: ${(err as Error).message}`));
    } else if (outcome.reason !== 'interrupted') {
      // Completion finished the row first (a fast turn): the start stands.
      return { kind: 'start' };
    }
    // 'interrupted': Stop or the timeout sweep finished the row before the brief went out (runner.ts).
    return skip ? { kind: 'skip', reason: 'runner_outdated' } : { kind: 'failed', reason: outcome.reason, error: outcome.error };
  }
  // The run's workstream link is the runner's, written before the brief went out.
  await prisma.automation.update({ where: { id: a.id }, data: { lastOccurrence: run.trigger === 'schedule' ? run.scheduledFor : a.lastOccurrence } });
  return { kind: 'start' };
}

async function noteFailure(a: Row, limits: AutomationLimits): Promise<void> {
  const failures = a.consecutiveFailures + 1;
  await prisma.automation.update({
    where: { id: a.id },
    data: { consecutiveFailures: failures, ...(failures >= limits.pauseAfterFailures ? { pausedReason: 'consecutive_failures' } : {}) },
  });
}

/** The owner's and box's real flag contexts for an automation whose row was read without them. */
async function limitsForAutomation(userId: string, instanceId: string | null): Promise<AutomationLimits> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, unixUsername: true, googleEmail: true, displayName: true, defaultAgentProvider: true } });
  const box = instanceId ? await prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } }) : null;
  return automationLimitsFor(user ?? { id: userId, unixUsername: '', googleEmail: '', displayName: '', defaultAgentProvider: '' }, box);
}

/**
 * Step 1: runs past their time limit are failed and interrupted, in that
 * order. The interrupt ends the turn, and the relay's completion would
 * otherwise race this write and record `interrupted` (or `done`, with a
 * result frame already in) in place of `timeout`; completion checks the
 * state before writing, so a row already failed here is left alone.
 */
export async function timeOutRuns(now: Date): Promise<number> {
  const running = await prisma.automationRun.findMany({
    where: { state: 'running', startedAt: { not: null } },
    include: { automation: { include: { project: { select: { id: true, name: true, userId: true, instanceId: true } } } }, workstream: { select: { id: true } } },
  });
  let n = 0;
  for (const r of running) {
    const limitMs = r.automation.maxRunMinutes * 60_000;
    if (!r.startedAt || now.getTime() - r.startedAt.getTime() < limitMs) continue;
    const p = r.automation.project;
    const updated = await prisma.automationRun.updateMany({
      where: { id: r.id, state: 'running' },
      data: { state: 'failed', reason: 'timeout', finishedAt: now, summary: `stopped after ${r.automation.maxRunMinutes} minutes` },
    });
    if (updated.count === 0) continue; // finished on its own meanwhile
    if (r.workstream && p.instanceId) {
      await sendForProject({ userId: p.userId, instanceId: p.instanceId }, 'chat-interrupt', { chatKey: chatKeyFor(p.id, r.workstream.id) }, 10_000)
        .catch(err => console.warn(`[AUTOMATION] ${p.name}: interrupt failed: ${(err as Error).message}`));
    }
    n++;
    const limits = await limitsForAutomation(r.automation.userId, p.instanceId);
    await noteFailure(r.automation as unknown as Row, limits);
    console.warn(`[AUTOMATION] ${p.name} ${r.scheduledFor.toISOString()} → failed timeout`);
    // This sweep owns the run's end: its notes push takes its place in the
    // queue now, before startDue below can start the next run's pull, and
    // the push and the branch summary and report happen once the interrupt
    // has stopped the turn's writes (complete.ts settleInterruptedRun); a
    // snapshot taken now would keep the turn's in-flight state as Changes.
    await settleInterruptedRun(r.id, NOTES_PUSH_DELAY_MS);
  }
  return n;
}

/**
 * Step 2: pending runs whose box is now up start; ones that waited too long
 * are skipped. A run left pending by an automation that has since been
 * disabled or whose project was archived is skipped too: startDue filtered
 * on those when it made the row, and the wake must not undo the owner's
 * change (a manual run goes through the route, not here).
 */
export async function resolvePending(now: Date): Promise<void> {
  const rows = await prisma.automationRun.findMany({ where: { state: 'pending' }, select: { id: true, automationId: true, createdAt: true } });
  for (const r of rows) {
    const a = await prisma.automation.findUnique({ where: { id: r.automationId }, include: ROW_INCLUDE });
    if (!a) continue;
    if (!a.enabled || a.project.archived) {
      await prisma.automationRun.updateMany({ where: { id: r.id, state: 'pending' }, data: { state: 'skipped', reason: 'disabled', finishedAt: now } });
      console.log(`[AUTOMATION] ${a.project.name}: skipped a pending run; the automation was ${a.project.archived ? 'archived' : 'disabled'} while it waited`);
      continue;
    }
    const box = a.project.instance ? { id: a.project.instance.id, name: a.project.instance.name, kind: a.project.instance.kind } : null;
    const limits = await automationLimitsFor(a.project.user, box);
    if (now.getTime() - r.createdAt.getTime() > limits.pendingMinutes * 60_000) {
      await prisma.automationRun.updateMany({ where: { id: r.id, state: 'pending' }, data: { state: 'skipped', reason: 'box_unavailable', finishedAt: now } });
      console.log(`[AUTOMATION] ${a.project.name}: skipped box_unavailable after ${limits.pendingMinutes} min pending`);
      continue;
    }
    await decideAndStart(a, r.id, limits, now).catch(err => console.error(`[AUTOMATION] ${a.project.name}: pending run failed:`, (err as Error).message));
  }
}

/**
 * Step 3: for every enabled automation, the occurrences since the last one
 * it enumerated (or since it was last saved, for a new one), newest last.
 * The newest becomes a pending run; the rest are recorded as missed.
 */
export async function startDue(now: Date): Promise<number> {
  const due = await prisma.automation.findMany({
    where: { enabled: true, pausedReason: null, nextRunAt: { lte: now }, project: { archived: false } },
    include: ROW_INCLUDE,
  });
  let started = 0;
  for (const a of due) {
    try {
      const from = a.lastOccurrence ?? a.updatedAt;
      const occurrences = occurrencesBetween(a.schedule, a.timezone, from, now).map(occurrenceMinute);
      const next = nextOccurrence(a.schedule, a.timezone, now);
      if (occurrences.length === 0) {
        await prisma.automation.update({ where: { id: a.id }, data: { nextRunAt: next } });
        continue;
      }
      // A list cut off at MAX_ENUMERATED holds only the oldest occurrences of a
      // long gap: the run is the newest one due, found separately, and the
      // cut-off list is only what is recorded as missed.
      const truncated = occurrences.length >= MAX_ENUMERATED;
      const newest = truncated
        ? occurrenceMinute(newestOccurrence(a.schedule, a.timezone, from, now) ?? occurrences[occurrences.length - 1])
        : occurrences[occurrences.length - 1];
      for (const missed of occurrences.filter(o => o.getTime() < newest.getTime())) {
        await prisma.automationRun.create({ data: { automationId: a.id, trigger: 'schedule', scheduledFor: missed, state: 'skipped', reason: 'missed', finishedAt: now } })
          .catch(err => { if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err; });
      }
      let run;
      try {
        run = await prisma.automationRun.create({ data: { automationId: a.id, trigger: 'schedule', scheduledFor: newest, state: 'pending' } });
      } catch (err) {
        // Another process made this occurrence's row first: it owns it.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          await prisma.automation.update({ where: { id: a.id }, data: { nextRunAt: next, lastOccurrence: newest } });
          continue;
        }
        throw err;
      }
      await prisma.automation.update({ where: { id: a.id }, data: { nextRunAt: next, lastOccurrence: newest } });
      const box = a.project.instance ? { id: a.project.instance.id, name: a.project.instance.name, kind: a.project.instance.kind } : null;
      const limits = await automationLimitsFor(a.project.user, box);
      const decision = await decideAndStart(a, run.id, limits, now);
      if (decision.kind === 'start') started++;
    } catch (err) {
      console.error(`[AUTOMATION] ${a.project.name}: occurrence failed:`, (err as Error).message);
    }
  }
  return started;
}

/** Step 4: finished runs beyond keepRuns lose their worktree (git's own refusals stand; the row stays). */
export async function retireBeyondKeep(now: Date): Promise<number> {
  const automations = await prisma.automation.findMany({
    where: { project: { archived: false } },
    select: { id: true, keepRuns: true, userId: true, projectId: true, project: { select: { name: true } } },
  });
  let retired = 0;
  for (const a of automations) {
    const extra = await prisma.automationRun.findMany({
      where: { automationId: a.id, state: { in: [...FINISHED_RUN_STATES] }, workstreamId: { not: null }, retiredAt: null },
      orderBy: { createdAt: 'desc' },
      skip: a.keepRuns,
      select: { id: true, workstreamId: true },
    });
    // A launch recorded as skipped (runner_outdated, a send that never took)
    // never ran, so it does not count toward keepRuns; one still linked to a
    // workstream is a worktree whose discard git refused, and is retried here.
    const strays = await prisma.automationRun.findMany({
      where: { automationId: a.id, state: 'skipped', workstreamId: { not: null }, retiredAt: null },
      select: { id: true, workstreamId: true },
    });
    for (const r of [...extra, ...strays]) {
      const result = await removeWorkstreamFor({ id: a.userId } as Express.User, a.projectId, r.workstreamId!, { force: false }).catch(err => ({ status: 500, body: { error: (err as Error).message } }));
      if (result.status < 300 || result.status === 404) {
        await prisma.automationRun.update({ where: { id: r.id }, data: { retiredAt: now, workstreamId: null } });
        retired++;
      } else {
        console.log(`[AUTOMATION] ${a.project.name}: kept run ${r.id}'s worktree: ${(result.body as { error?: string }).error}`);
      }
    }
  }
  return retired;
}

export async function schedulerTick(now: Date = new Date()): Promise<void> {
  await timeOutRuns(now).catch(err => console.error('[AUTOMATION] timeout sweep failed:', (err as Error).message));
  await resolvePending(now).catch(err => console.error('[AUTOMATION] pending sweep failed:', (err as Error).message));
  await startDue(now).catch(err => console.error('[AUTOMATION] due sweep failed:', (err as Error).message));
  await retireBeyondKeep(now).catch(err => console.error('[AUTOMATION] retire sweep failed:', (err as Error).message));
}

export function startAutomationScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    schedulerTick().catch(err => console.error('[AUTOMATION] tick failed:', (err as Error).message)).finally(() => { ticking = false; });
  }, TICK_MS);
  timer.unref?.();
}

export function stopAutomationScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// A box with a run inside its time limit is busy: auto-hibernate must not
// park it. Past the limit the run is the
// timeout sweep's, so it never keeps a box up for good.
registerBoxBusyCheck('automation-run', async ids => {
  const rows = await prisma.automationRun.findMany({
    where: { instanceId: { in: ids }, state: 'running' },
    select: { instanceId: true, startedAt: true, automation: { select: { maxRunMinutes: true } } },
  });
  const now = Date.now();
  const busy = new Set<string>();
  for (const r of rows) {
    if (!r.instanceId) continue;
    if (!r.startedAt || now - r.startedAt.getTime() < r.automation.maxRunMinutes * 60_000) busy.add(r.instanceId);
  }
  return busy;
});
