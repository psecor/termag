/**
 * Box stop/start: the pure decisions. `boxPower.ts` owns every EC2 call and
 * Prisma write; this module only decides, so the rules are unit-testable.
 *
 * A stop moves `ready` (or a `starting` box whose agent never came back) to
 * `stopping`, and the power sweep settles it to `stopped` once EC2 reports the
 * instance stopped. A start moves `stopped` to `starting`, and the agent's
 * connect makes it `ready` (CONNECT_TRANSITIONS in instanceLifecycle.ts).
 *
 * A hibernate is the same shape with its own two statuses: `ready` to
 * `hibernating`, settled to `hibernated`, and a start resumes it. They are
 * distinct from `stopping`/`stopped` on purpose: a stopped box has lost its
 * RAM and can be replaced on start, a hibernated one must only be resumed.
 */

import { refuseUnreadySessions, type SessionRefusal } from './sessionGate';

export type PowerAction = 'stop' | 'start' | 'hibernate';

/** Statuses a power request is accepted from, and the status it writes first. */
export const POWER_TRANSITIONS: Readonly<Record<PowerAction, { from: readonly string[]; to: string }>> = {
  stop: { from: ['ready', 'starting'], to: 'stopping' },
  start: { from: ['stopped', 'hibernated'], to: 'starting' },
  // Not from `starting`: EC2 refuses to hibernate an instance whose agent has
  // not prepared the swap file yet, and a box whose agent never came back
  // has nothing worth keeping in RAM.
  hibernate: { from: ['ready'], to: 'hibernating' },
};

const PAST_TENSE: Readonly<Record<PowerAction, string>> = {
  stop: 'stopped', start: 'started', hibernate: 'hibernated',
};

export interface PowerRequestBox {
  userId: string | null;
  kind: string;
  status: string;
  ec2InstanceId: string | null;
  /** Set at launch only; an instance launched without it can never hibernate. */
  hibernationConfigured?: boolean;
  /** Stamped when the lifecycle sweep claims the box for an automatic terminate. */
  autoTerminatedAt?: Date | null;
}

export interface PowerRequestError {
  status: number;
  error: string;
}

/**
 * Why a stop or start request can't go ahead, or null when it can. `box` is
 * the row looked up by id alone, so the owner check happens here rather than
 * in the query: another user's box answers 404 exactly like a missing one.
 */
export function powerRequestError(
  box: PowerRequestBox | null,
  callerId: string,
  action: PowerAction,
  provisioningConfigured: boolean,
): PowerRequestError | null {
  if (!box || box.userId !== callerId) return { status: 404, error: 'Box not found' };
  if (box.kind !== 'ec2') {
    return { status: 400, error: `Only EC2 boxes can be ${PAST_TENSE[action]} from termag` };
  }
  if (!provisioningConfigured) {
    return { status: 503, error: 'Box provisioning is not configured on this orchestrator' };
  }
  if (!box.ec2InstanceId) return { status: 409, error: 'This box has no EC2 instance yet' };
  if (box.autoTerminatedAt) return { status: 409, error: 'This box is being terminated automatically' };
  if (action === 'hibernate' && !box.hibernationConfigured) {
    return { status: 409, error: 'This box was launched without hibernation support. Stop it instead.' };
  }
  const { from } = POWER_TRANSITIONS[action];
  if (!from.includes(box.status)) {
    return { status: 409, error: `Can't ${action} a box that is ${box.status}` };
  }
  return null;
}

/**
 * The error to show when something needs a box's agent and the box is powered
 * down or on its way up or down; null for every other status, where the
 * caller's own "agent is not connected" message still applies.
 */
export function powerStateError(status: string): string | null {
  switch (status) {
    case 'stopping': return 'This box is stopping. Start it again once it has stopped.';
    case 'stopped': return 'This box is stopped. Start it from the Boxes list first.';
    case 'starting': return 'This box is starting. Try again once it is ready.';
    case 'hibernating': return 'This box is hibernating. Resume it once it has hibernated.';
    case 'hibernated': return 'This box is hibernated. Resume it from the Boxes list first.';
    default: return null;
  }
}

/** The power statuses a terminal pane shows as parked. */
export const PARKED_STATUSES = ['stopping', 'stopped', 'starting', 'hibernating', 'hibernated'] as const;
export type ParkedStatus = typeof PARKED_STATUSES[number];

/**
 * Close code for a terminal socket refused because its box is powered down or
 * on its way up or down. Kept in step with BOX_PARKED_CLOSE_CODE in
 * frontend/src/utils/terminalReconnect.ts, which stops retrying on a box that
 * is down or going down and polls slowly on starting.
 */
export const TERMINAL_BOX_PARKED_CLOSE_CODE = 4409;

export interface TerminalBoxParkedNotice {
  type: 'box-power';
  instanceId: string;
  status: ParkedStatus;
  message: string;
}

/**
 * The frame a terminal socket gets before it is closed for a parked box, or
 * null when the status is not a power state. The socket also gets the message
 * as plain output after it, for browser tabs still on a bundle that doesn't
 * know this frame.
 */
export function terminalBoxParkedNotice(instanceId: string, status: string): TerminalBoxParkedNotice | null {
  const message = powerStateError(status);
  if (!message) return null;
  return { type: 'box-power', instanceId, status: status as TerminalBoxParkedNotice['status'], message };
}

export type TerminalAttachRefusal =
  | { kind: 'parked'; notice: TerminalBoxParkedNotice }
  | { kind: 'setup'; refusal: SessionRefusal }
  | { kind: 'agent-not-connected' };

/**
 * Why a terminal attach is refused, or null to route it. The box's power state
 * is checked before its agent's liveness: a stopping box keeps its agent until
 * EC2 powers it off, and an attach in that window would leave the pane on a
 * socket that dies with the agent instead of on the parked notice. A project
 * still being set up comes before the agent too, so a pick on a cold box says
 * it is waiting to clone rather than that the agent is away.
 */
export function terminalAttachRefusal(
  instanceId: string | null,
  boxStatus: string | null,
  agentConnected: boolean,
  project: { id: string; setupStatus: string } | null,
): TerminalAttachRefusal | null {
  const notice = instanceId && boxStatus ? terminalBoxParkedNotice(instanceId, boxStatus) : null;
  if (notice) return { kind: 'parked', notice };
  const refusal = project && refuseUnreadySessions(project);
  if (refusal) return { kind: 'setup', refusal };
  if (!agentConnected) return { kind: 'agent-not-connected' };
  return null;
}

/**
 * Whether an agent connect from this status ends a power transition, so the
 * power error left on the row (a start that timed out) no longer applies.
 */
export function clearsPowerErrorOnConnect(status: string): boolean {
  return status === 'starting' || status === 'stopped' || status === 'hibernated';
}

/**
 * Whether StopInstances with Hibernate refused the hibernate itself, as
 * opposed to the stop. EC2 answers UnsupportedHibernationConfiguration for an
 * instance that can't hibernate and UnsupportedOperation ("not ready to
 * hibernate yet") while hibinit-agent is still preparing the swap file after
 * a boot. Either way a plain stop still works, so the caller falls back to one.
 */
export function isHibernateRefusal(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'UnsupportedHibernationConfiguration' || /hibernat/i.test(message);
}

/** Written to provisioningError when a hibernate falls back to a plain stop. */
export function hibernateFallbackNote(reason: string): string {
  return `EC2 would not hibernate this box (${reason}), so it was stopped instead. `
    + 'Its sessions are recreated when you start it.';
}

/**
 * EC2 does not support keeping an instance hibernated for more than 60 days.
 * The power sweep resumes a box this long into hibernation and hibernates it
 * again, which restarts the clock and keeps its RAM.
 */
export const DEFAULT_HIBERNATION_REFRESH_DAYS = 55;

/** 0 (BOX_HIBERNATION_REFRESH_DAYS=0) turns the refresh off. */
export function hibernationRefreshMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOX_HIBERNATION_REFRESH_DAYS;
  const n = Number(raw);
  const days = raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.min(n, 59) : DEFAULT_HIBERNATION_REFRESH_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export function hibernationRefreshDue(
  box: { status: string; hibernatedAt: Date | null },
  nowMs: number,
  refreshMs: number,
): boolean {
  if (refreshMs <= 0 || box.status !== 'hibernated' || !box.hibernatedAt) return false;
  return nowMs - box.hibernatedAt.getTime() >= refreshMs;
}

export interface PowerTimeouts {
  /** A stop that EC2 still reports running after this long is given up on. */
  stopMs: number;
  /** A start whose agent hasn't connected after this long is reported. */
  startMs: number;
}

export const DEFAULT_POWER_TIMEOUTS: PowerTimeouts = {
  stopMs: 10 * 60 * 1000,
  // Same window as the stuck-provisioning sweep, which a cold boot has to beat.
  startMs: 15 * 60 * 1000,
};

/** EC2 can briefly describe a just-started instance by its old state. */
const START_SETTLE_MS = 60 * 1000;

export function powerTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): PowerTimeouts {
  const seconds = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
  };
  return {
    stopMs: seconds(env.BOX_STOP_TIMEOUT_SECONDS, DEFAULT_POWER_TIMEOUTS.stopMs),
    startMs: seconds(env.BOX_START_TIMEOUT_SECONDS, DEFAULT_POWER_TIMEOUTS.startMs),
  };
}

export interface PowerSettlement {
  status?: 'stopped' | 'hibernated' | 'ready';
  provisioningError: string | null;
}

/** EC2's StateReason code on an instance a hibernate stopped. */
const HIBERNATE_STATE_REASON = 'Client.UserInitiatedHibernate';

/**
 * What the power sweep writes for a box in `stopping`, `hibernating` or
 * `starting`, given what EC2 says about its instance and how long ago the
 * request was made. Null means leave the row alone.
 *
 * `ec2State` is undefined when the instance can't be described; that is
 * left for the terminate path to sort out rather than guessed at here.
 * `stateReasonCode` is EC2's StateReason.Code, which tells a hibernated
 * instance from one that stopped without saving its RAM.
 */
export function settlePowerState(
  box: { status: string; provisioningError: string | null; hibernatedAt?: Date | null },
  ec2State: string | undefined,
  elapsedMs: number,
  timeouts: PowerTimeouts,
  stateReasonCode?: string,
): PowerSettlement | null {
  if (box.status === 'stopping' || box.status === 'hibernating') {
    const verb = box.status === 'stopping' ? 'Stop' : 'Hibernate';
    if (ec2State === 'stopped') {
      if (box.status === 'stopping') return { status: 'stopped', provisioningError: box.provisioningError };
      if (stateReasonCode && stateReasonCode !== HIBERNATE_STATE_REASON) {
        return {
          status: 'stopped',
          provisioningError: `EC2 stopped the box without hibernating it (${stateReasonCode}). `
            + 'Its sessions are recreated when you start it.',
        };
      }
      return { status: 'hibernated', provisioningError: null };
    }
    if ((ec2State === 'running' || ec2State === 'pending') && elapsedMs >= timeouts.stopMs) {
      return {
        status: 'ready',
        provisioningError: `${verb} did not complete: EC2 still reports the instance ${ec2State} after ${minutes(timeouts.stopMs)}`,
      };
    }
    return null;
  }
  if (box.status === 'starting') {
    if (ec2State === 'stopped' && elapsedMs >= START_SETTLE_MS) {
      // A resume that didn't take leaves the RAM image where it was.
      const status = box.hibernatedAt ? 'hibernated' : 'stopped';
      return { status, provisioningError: 'Start did not take: EC2 reports the instance stopped' };
    }
    if (ec2State === 'running' && elapsedMs >= timeouts.startMs && !box.provisioningError) {
      return {
        provisioningError: `The box is running but its agent has not connected after ${minutes(timeouts.startMs)}. `
          + 'Stop it and start it again, or terminate it.',
      };
    }
    return null;
  }
  return null;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  if (m >= 1 && Number.isInteger(m)) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${Math.round(ms / 1000)} seconds`;
}
