/**
 * The activity clock the lifecycle sweep reads (`Instance.lastActivityAt`).
 *
 * Bumped by human input (terminal keystrokes, send-keys from MetaTerm or
 * Slack/Discord, the UI typing heartbeat), by an agent reporting `working`
 * (except an automation run that can wake the box: noteAgentWorking), by an
 * automation run's start, end and wake (noteAutomationRunActivity) and by
 * a Claude cloud session starting or ending on the box. Never by a
 * reconnect, the 60-day refresh or a box update: those are the system, not
 * someone using the box. Only a ready box's clock moves: a parked box's
 * must still read as untouched. Writes are throttled per box in memory, so
 * a burst of keystrokes costs one UPDATE a minute.
 */
import { prisma } from '../db';
import { sessionName as tmuxSessionName } from './tmux';

export const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

const lastWrite = new Map<string, number>();

const HOLD_CACHE_MS = 60 * 1000;
const HOLD_CACHE_MAX = 500;
/** noteAgentWorking's answers, per box and session. */
const holdCache = new Map<string, { at: number; held: boolean }>();

function throttled(instanceId: string, now: number): boolean {
  const prev = lastWrite.get(instanceId);
  return prev !== undefined && now - prev < ACTIVITY_WRITE_INTERVAL_MS;
}

// xterm.js answers terminal queries on its own: device attributes (CSI … c),
// cursor and status reports (CSI … R / n), focus in/out (CSI I / O) and OSC
// colour replies. Input made only of those is the terminal, not a person.
const TERMINAL_REPORTS = /^(?:\x1b\[[\d;?>=]*[cRnIO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORTS.test(data);
}

/** Record activity on a box. Fire-and-forget; never throws. */
export function noteBoxActivity(instanceId: string | null | undefined, now: number = Date.now()): void {
  if (!instanceId || throttled(instanceId, now)) return;
  lastWrite.set(instanceId, now);
  Promise.resolve()
    .then(() => prisma.instance.updateMany({ where: { id: instanceId, status: 'ready' }, data: { lastActivityAt: new Date(now) } }))
    .catch(err => {
      lastWrite.delete(instanceId);
      console.warn(`[LIFECYCLE] activity write for ${instanceId} failed:`, err instanceof Error ? err.message : String(err));
    });
}

/**
 * An automation run started or finished on the box, or its wake: the box is
 * in use, so its idle clock restarts, whatever Wake the box says. Without
 * this a box woken for a run read as untouched since its auto-park and went
 * straight back down once its start grace was over, and its idle window
 * never counted the runs at all (babysit-1027, 2026-10-30). Awaited, unlike
 * noteBoxActivity, so the scheduler's next step sees the clock, and not
 * throttled. Only a ready box's clock moves. Never throws.
 */
export async function noteAutomationRunActivity(instanceId: string | null | undefined, at: Date = new Date()): Promise<void> {
  if (!instanceId) return;
  lastWrite.set(instanceId, at.getTime());
  try {
    await prisma.instance.updateMany({ where: { id: instanceId, status: 'ready' }, data: { lastActivityAt: at } });
  } catch (err) {
    console.warn(`[LIFECYCLE] run activity write for ${instanceId} failed:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * An agent session on the box reported `working`. That is activity, except
 * for the turns of an automation run whose automation can wake the box (Wake
 * the box on): the run's start and end restart the clock already
 * (noteAutomationRunActivity), and the `automation-run` busy check holds the
 * box while the run lasts, so its turns need not. An automation that can't
 * wake the box needs it up, so its turns still count, as everything else's
 * does. The runs are read from the database, so every process agrees. The
 * answer is cached per session for a minute, apart from the write throttle,
 * so a held turn never keeps a keystroke or another session from moving the
 * clock. Never throws.
 */
export function noteAgentWorking(instanceId: string | null | undefined, session: string, now: number = Date.now()): void {
  if (!instanceId || throttled(instanceId, now)) return;
  const key = `${instanceId}\0${session}`;
  const cached = holdCache.get(key);
  if (cached && now - cached.at < HOLD_CACHE_MS) {
    if (!cached.held) noteBoxActivity(instanceId, now);
    return;
  }
  // Provisional while the lookup runs, so a burst of statuses makes one query.
  holdCache.set(key, { at: now, held: true });
  if (holdCache.size > HOLD_CACHE_MAX) {
    for (const [k, v] of holdCache) if (now - v.at >= HOLD_CACHE_MS) holdCache.delete(k);
  }
  automationHoldsSession(instanceId, session)
    .catch(() => false)
    .then(held => {
      holdCache.set(key, { at: now, held });
      if (!held) noteBoxActivity(instanceId, now);
    });
}

/** Whether `session` is the agent session of a running automation run on the box that can wake the box. */
export async function automationHoldsSession(instanceId: string, session: string): Promise<boolean> {
  const runs = await prisma.automationRun.findMany({
    where: { instanceId, state: 'running', workstreamId: { not: null }, automation: { wakeBox: true } },
    select: {
      workstream: { select: { name: true } },
      automation: { select: { project: { select: { name: true, user: { select: { unixUsername: true } } } } } },
    },
  });
  return runs.some(r => !!r.workstream
    && tmuxSessionName(r.automation.project.user.unixUsername, r.automation.project.name, 'agent', r.workstream.name) === session);
}

/**
 * An owner started the box, or turned its auto-hibernate on: the idle clock
 * starts now and the box is no longer parked, by hand or by the sweep.
 * Returned as columns, for the caller to put in the same UPDATE as the
 * change that caused it.
 */
export function boxInUseFields(instanceId: string, now: number = Date.now()) {
  lastWrite.set(instanceId, now);
  return { lastActivityAt: new Date(now), parkedAt: null, autoParkedAt: null, lifecycleNote: null };
}

/**
 * A reviewer woke an auto-hibernated box (a preview link share):
 * the idle clock starts now, so the
 * sweep doesn't put it straight back to sleep. Unlike an owner's start,
 * `parkedAt` stays (the terminate clock is the owner's, never a guest's to
 * move), and so does the idle note: a resume that doesn't take settles back
 * to hibernated still marked as the sweep's, so it may be woken again.
 */
export function guestWakeFields(instanceId: string, now: number = Date.now()) {
  lastWrite.set(instanceId, now);
  return { lastActivityAt: new Date(now) };
}

/** Tests only. */
export function resetBoxActivityThrottle(): void {
  lastWrite.clear();
  holdCache.clear();
}
