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

export const INSTANCE_STATUSES = [
  'provisioning', 'awaiting-agent', 'warming', 'warm', 'ready', 'stopping', 'stopped', 'starting',
  'hibernating', 'hibernated', 'failed', 'terminated',
] as const;
export type InstanceStatus = typeof INSTANCE_STATUSES[number];

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
 * `hibernated` follow the same two rules.
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
  'terminated': 'terminated',
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
  instance: Pick<Instance, 'id' | 'status'>,
  now: Date,
): { where: { id: string; status: string }; data: { status: string; lastConnectedAt: Date } } {
  // Deliberately no agentDisconnectedAt. The close path is its only writer,
  // and the two writes are unordered, so clearing it here would revive a box
  // whose disconnect had already landed. The columns are independent facts;
  // a reader decides liveness with
  // `agentDisconnectedAt IS NULL OR agentDisconnectedAt < lastConnectedAt`.
  return {
    where: { id: instance.id, status: instance.status },
    data: {
      status: nextStatusOnConnect(instance.status),
      lastConnectedAt: now,
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
