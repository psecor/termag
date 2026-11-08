/**
 * Instance Lifecycle
 *
 * Owns the status vocabulary of an Instance row, the parse of an agent
 * socket's identity, and the pure status decisions that follow from it.
 * Nothing here touches Prisma, the database, or `ws` — `agentRegistry.ts`
 * owns every Prisma call and every socket. That split is what keeps these
 * decisions unit-testable.
 */

import type { Instance, User } from '@prisma/client';
import { isStuckStartNote, STUCK_START_NOTE_PREFIX } from './boxLifecyclePolicy';

/**
 * The stuck-start stop's mark, dropped by any connect of the box's agent:
 * the box came up. connectUpdate puts it in its own write; this is the same
 * drop for a connect whose guarded write missed (agentRegistry), keyed on
 * the note instead of the status (Bugbot on #623).
 */
export function stuckMarkDropUpdate(instanceId: string) {
  return {
    where: { id: instanceId, lifecycleNote: { startsWith: STUCK_START_NOTE_PREFIX } },
    data: { lifecycleNote: null, autoParkedAt: null, idleWarnedAt: null, idleParkAt: null },
  };
}

export const INSTANCE_STATUSES = [
  'provisioning', 'awaiting-agent', 'warming', 'warm', 'ready', 'stopping', 'stopped', 'starting',
  'hibernating', 'hibernated', 'failed', 'quarantined', 'terminated',
  // An environment pool's ownerless boxes.
  'env-preparing', 'env-stopping', 'env-stopped', 'env-starting', 'env-failed',
] as const;
export type InstanceStatus = typeof INSTANCE_STATUSES[number];

/** An environment pool's statuses: an ownerless box prepared for one environment (Instance.poolEnvironmentId). */
export const ENV_POOL_STATUSES = ['env-preparing', 'env-stopping', 'env-stopped', 'env-starting', 'env-failed'] as const satisfies readonly InstanceStatus[];
export function isEnvPoolStatus(status: string): boolean {
  return (ENV_POOL_STATUSES as readonly string[]).includes(status);
}

/** What `validateAgentToken` resolves to. Both halves are nullable because both columns are. */
export interface ValidatedAgentToken {
  user: User | null;
  instance: Instance | null;
}

/**
 * An agent socket whose identity has been resolved. One variant per behaviour
 * the registry has, and deliberately no variant for "no owner and no box".
 */
export type AgentConnection =
  | { kind: 'user-agent'; user: User }
  | { kind: 'owned-box'; user: User; instance: Instance }
  | { kind: 'warm-box'; instance: Instance };

/** Null when the token carries neither an owner nor a box; the caller closes the socket. */
export function parseAgentConnection(token: ValidatedAgentToken): AgentConnection | null {
  const { user, instance } = token;
  if (instance) {
    return user ? { kind: 'owned-box', user, instance } : { kind: 'warm-box', instance };
  }
  return user ? { kind: 'user-agent', user } : null;
}

/**
 * A box termag launched and a user owns. External boxes are the user's own
 * machines: nothing is installed or delivered on them.
 */
export function isManagedBox(instance: Pick<Instance, 'userId' | 'kind'>): boolean {
  return !!instance.userId && instance.kind === 'ec2';
}

/** Which registry map holds this connection, under which key, and how it is logged. */
export function registryKeyOf(conn: AgentConnection): { scope: 'user' | 'instance'; key: string; label: string } {
  switch (conn.kind) {
    case 'user-agent':
      return { scope: 'user', key: conn.user.id, label: conn.user.unixUsername };
    case 'owned-box':
    case 'warm-box':
      return { scope: 'instance', key: conn.instance.id, label: `instance ${conn.instance.name}` };
    default: {
      const unreachable: never = conn;
      return unreachable;
    }
  }
}

/**
 * What an agent connect does to each status. Exhaustive over INSTANCE_STATUSES
 * so adding a status fails `tsc` here until someone decides what a connect
 * does to it.
 *
 * `failed` and `terminated` mapping to themselves is a behaviour change:
 * registerAgent used to write `status: 'ready'` unconditionally, so a box the
 * stuck-provisioning sweep had already failed resurrected itself by dialing in
 * late.
 *
 * `stopped` connecting means the instance was started outside termag (the
 * Resize box workflow), so the box is simply up again. `stopping` stays put: a
 * redial while EC2 is shutting the box down is not the box coming back, and
 * the power sweep settles it from the EC2 state either way. `hibernating` and
 * `hibernated` follow the same two rules. `quarantined` stays put: its tokens
 * are revoked, so a connect means something got past that, and must not make
 * the box usable again.
 */
const CONNECT_TRANSITIONS: Readonly<Record<InstanceStatus, InstanceStatus>> = {
  'provisioning': 'ready',
  'awaiting-agent': 'ready',
  'warming': 'warming',
  'warm': 'warm',
  'ready': 'ready',
  'stopping': 'stopping',
  'stopped': 'ready',
  'starting': 'ready',
  'hibernating': 'hibernating',
  'hibernated': 'ready',
  'failed': 'failed',
  'quarantined': 'quarantined',
  'terminated': 'terminated',
  // A pool box's connect changes nothing yet: the pool code (prepare, stop,
  // claim) moves these rows itself, as the warm pool's on-warm handler does.
  'env-preparing': 'env-preparing',
  'env-stopping': 'env-stopping',
  'env-stopped': 'env-stopped',
  'env-starting': 'env-starting',
  'env-failed': 'env-failed',
};

/** The status to write when an instance-bound agent connects. */
export function nextStatusOnConnect(status: string): string {
  // Instance.status is a free-form Postgres String, so an unrecognised value
  // comes back unchanged rather than being clobbered.
  return CONNECT_TRANSITIONS[status as InstanceStatus] ?? status;
}

/**
 * The guarded connect-time Instance update.
 *
 * The status written here is derived from the row as it was read when the
 * socket authenticated, and the row can move between that read and this write:
 * the stuck sweep can fail it, the reconciler can retire it, and the on-warm
 * handler can promote it. An unguarded write puts the stale status back, which
 * at worst un-promotes a box that had already reached `warm` and hands the
 * pool a row it thinks is still booting. Guarding on the status the decision
 * was made from turns that race into a no-op, and the caller writes
 * `lastConnectedAt` on its own when the guard misses, because the agent really
 * is connected whatever the row now says.
 */
export function connectUpdate(
  instance: Pick<Instance, 'id' | 'status'> & Partial<Pick<Instance, 'autoParkedAt' | 'lifecycleNote' | 'rehibernatePending'>>,
  now: Date,
): {
  where: { id: string; status: string };
  data: {
    status: string; lastConnectedAt: Date; lastReadyAt?: Date; idleWarnedAt?: null; idleParkAt?: null;
    autoParkedAt?: null; lifecycleNote?: null; downSince?: null;
  };
} {
  // Deliberately no agentDisconnectedAt. The close path is its only writer,
  // and the two writes are unordered, so clearing it here would revive a box
  // whose disconnect had already landed. The columns are independent facts;
  // a reader decides liveness with
  // `agentDisconnectedAt IS NULL OR agentDisconnectedAt < lastConnectedAt`.
  // lastReadyAt only when this connect is what makes the box ready (a start,
  // a resume, a first boot), never on a reconnect of a box that already was:
  // the lifecycle sweep's start grace counts from it (boxLifecyclePolicy.ts).
  // The same connect clears the sweep's warning: one written before the box
  // came up (an idle warning before it went down, a stuck-start warning while
  // it wouldn't connect) promises nothing about it now (Bugbot on #623).
  // A box that carries the stuck-start stop's note and whose agent now
  // connects has come up after all, whatever its status: its stuck stop
  // timed out back to `ready`, it was started again after one, or the agent
  // was restarted while the stop was still in flight, as the warning says
  // to. The stuck stop's mark goes, so neither the retry nor the quiet
  // re-park takes it for a box nobody woke; when the connect also makes it
  // ready, it is the box's start (Bugbot and the security review on #623).
  // The connect that brings the box up ends its down clock (box.resumed's
  // downMinutes, boxPower.ts), except the 60-day refresh's: that box goes
  // straight back to hibernated and keeps the clock from before it.
  const status = nextStatusOnConnect(instance.status);
  const cameUp = status === 'ready' && instance.status !== 'ready';
  const stuckStopFailed = isStuckStartNote(instance.lifecycleNote);
  return {
    where: { id: instance.id, status: instance.status },
    data: {
      status,
      lastConnectedAt: now,
      ...(cameUp ? { lastReadyAt: now, idleWarnedAt: null, idleParkAt: null } : {}),
      ...(cameUp && !instance.rehibernatePending ? { downSince: null } : {}),
      ...(stuckStopFailed ? { idleWarnedAt: null, idleParkAt: null, autoParkedAt: null, lifecycleNote: null } : {}),
      ...(stuckStopFailed && status === 'ready' ? { lastReadyAt: now } : {}),
    },
  };
}

/**
 * The guarded updateMany that promotes warming to warm, or null when there is
 * nothing to attempt.
 *
 * The where-clause guards are what make the two racing events (agent connects,
 * on-warm reports success) converge in either order and make repeats no-ops.
 */
export function warmCompletionUpdate(
  instanceId: string,
  agentConnected: boolean,
  now: Date,
):
  | { where: { id: string; status: 'warming'; onWarmStatus: 'succeeded' }; data: { status: 'warm'; warmedAt: Date } }
  | null {
  if (!agentConnected) return null;
  return {
    where: { id: instanceId, status: 'warming', onWarmStatus: 'succeeded' },
    data: { status: 'warm', warmedAt: now },
  };
}
