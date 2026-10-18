/**
 * The activity clock the lifecycle sweep reads (`Instance.lastActivityAt`).
 *
 * Bumped by human input (terminal keystrokes, send-keys from MetaTerm or
 * Slack/Discord, the UI typing heartbeat) and by an agent reporting `working`.
 * Never by a reconnect, the 60-day refresh or a box update: those are the
 * system, not someone using the box. Writes are throttled per box in memory,
 * so a burst of keystrokes costs one UPDATE a minute.
 */
import { prisma } from '../db';

export const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

const lastWrite = new Map<string, number>();

// xterm.js answers terminal queries on its own: device attributes (CSI … c),
// cursor and status reports (CSI … R / n), focus in/out (CSI I / O) and OSC
// colour replies. Input made only of those is the terminal, not a person.
const TERMINAL_REPORTS = /^(?:\x1b\[[\d;?>=]*[cRnIO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORTS.test(data);
}

/** Record activity on a box. Fire-and-forget; never throws. */
export function noteBoxActivity(instanceId: string | null | undefined, now: number = Date.now()): void {
  if (!instanceId) return;
  const prev = lastWrite.get(instanceId);
  if (prev !== undefined && now - prev < ACTIVITY_WRITE_INTERVAL_MS) return;
  lastWrite.set(instanceId, now);
  Promise.resolve()
    .then(() => prisma.instance.updateMany({ where: { id: instanceId }, data: { lastActivityAt: new Date(now) } }))
    .catch(err => {
      lastWrite.delete(instanceId);
      console.warn(`[LIFECYCLE] activity write for ${instanceId} failed:`, err instanceof Error ? err.message : String(err));
    });
}

/**
 * An owner started the box, or turned its auto-hibernate on: the idle clock
 * starts now and the box is no longer parked. Returned as columns, for the
 * caller to put in the same UPDATE as the change that caused it.
 */
export function boxInUseFields(instanceId: string, now: number = Date.now()) {
  lastWrite.set(instanceId, now);
  return { lastActivityAt: new Date(now), parkedAt: null, lifecycleNote: null };
}

/** Tests only. */
export function resetBoxActivityThrottle(): void {
  lastWrite.clear();
}
