/**
 * Whether a due occurrence becomes a run, as a pure decision over what the scheduler has read. The order
 * is the order the reasons are cheap to know and useful to show: a paused
 * automation first, then the flag, then the previous run, then budget and
 * box room, then the box's power and its runner.
 */
import type { AutomationLimits } from './limits';

export type SkipReason =
  | 'paused' | 'flag_off' | 'previous_running' | 'budget' | 'box_concurrent'
  | 'box_gone' | 'box_unavailable' | 'runner_outdated'
  /** Scheduler only: the run waited as pending and the automation was disabled or archived meanwhile. */
  | 'disabled';

export type AdmitDecision =
  | { kind: 'start' }
  /** The box is off or coming up: the run waits as `pending` (and is started when wakeBox says so). */
  | { kind: 'pending'; wake: boolean }
  | { kind: 'skip'; reason: SkipReason };

export interface AdmitInput {
  pausedReason: string | null;
  flagOn: boolean;
  /** This automation already has a run that has not finished. */
  previousLive: boolean;
  /** Run-minutes this owner has used today, counting the live ones so far. */
  dailyMinutesUsed: number;
  /** Runs live on the target box right now. */
  boxLiveRuns: number;
  /** 'start' (stopped or hibernated), 'wait' (coming up or ready), 'gone' (terminated, failed, missing): services/agentMessages.ts wakeAction. */
  boxWake: 'start' | 'wait' | 'gone';
  boxConnected: boolean;
  /** The box's agent advertises the chat runner's auto mode (chat-auto-v1), or the run is read-tier and needs only the runner. */
  runnerCapable: boolean;
  wakeBox: boolean;
  limits: AutomationLimits;
}

export function admitRun(i: AdmitInput): AdmitDecision {
  if (i.pausedReason) return { kind: 'skip', reason: 'paused' };
  if (!i.flagOn) return { kind: 'skip', reason: 'flag_off' };
  if (i.previousLive) return { kind: 'skip', reason: 'previous_running' };
  if (i.dailyMinutesUsed >= i.limits.dailyRunMinutes) return { kind: 'skip', reason: 'budget' };
  if (i.boxLiveRuns >= i.limits.perBoxConcurrent) return { kind: 'skip', reason: 'box_concurrent' };
  if (i.boxWake === 'gone') return { kind: 'skip', reason: 'box_gone' };
  if (!i.boxConnected) {
    if (i.boxWake === 'start') return i.wakeBox ? { kind: 'pending', wake: true } : { kind: 'skip', reason: 'box_unavailable' };
    // Starting, or ready with its agent not yet connected: wait for the hello either way.
    return { kind: 'pending', wake: false };
  }
  if (!i.runnerCapable) return { kind: 'skip', reason: 'runner_outdated' };
  return { kind: 'start' };
}

/** The words a run row shows for a skip. */
export function skipReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'paused': return 'paused';
    case 'flag_off': return 'automations are off for you';
    case 'previous_running': return 'the previous run was still going';
    case 'budget': return "today's run budget is used up";
    case 'box_concurrent': return 'the box was already running its share of automations';
    case 'box_gone': return 'the box is gone';
    case 'box_unavailable': return 'the box was asleep';
    case 'runner_outdated': return 'the box runs an older termag; it needs an update';
    case 'disabled': return 'the automation was disabled while the run waited for its box';
    case 'missed': return 'missed while termag or the box was down';
    default: return reason ?? '';
  }
}
