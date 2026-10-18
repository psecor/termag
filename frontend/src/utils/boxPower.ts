import type { Instance, InstanceStatus } from '../types';

type BoxLike = Pick<Instance, 'kind' | 'status' | 'ec2InstanceId'>;

/** Statuses the box list keeps polling through until they settle. */
export const TRANSITIONAL_BOX_STATUSES: readonly InstanceStatus[] = [
  'provisioning', 'awaiting-agent', 'stopping', 'starting', 'hibernating',
];

// Mirrors POWER_TRANSITIONS in backend/src/services/boxPowerPolicy.ts; the
// backend re-checks, so a stale list only shows a button that answers 409.
export function canStopBox(box: BoxLike): boolean {
  return box.kind === 'ec2' && !!box.ec2InstanceId && (box.status === 'ready' || box.status === 'starting');
}

export function canStartBox(box: BoxLike): boolean {
  return box.kind === 'ec2' && !!box.ec2InstanceId && (box.status === 'stopped' || box.status === 'hibernated');
}

/** Only for boxes launched hibernation-capable; every other box keeps plain Stop. */
export function canHibernateBox(box: BoxLike & Pick<Instance, 'hibernationConfigured'>): boolean {
  return box.kind === 'ec2' && !!box.ec2InstanceId && !!box.hibernationConfigured && box.status === 'ready';
}

/** EC2 supports at most 60 days hibernated; the backend refreshes a box at 55. */
export const HIBERNATION_LIMIT_DAYS = 60;
export const HIBERNATION_WARN_DAYS = 50;

export function hibernatedDays(box: Pick<Instance, 'status' | 'hibernatedAt'>, now = Date.now()): number | null {
  if (box.status !== 'hibernated' || !box.hibernatedAt) return null;
  const at = Date.parse(box.hibernatedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / (24 * 60 * 60 * 1000)));
}

/** A one-line note for a hibernated box nearing EC2's 60-day limit, or null. */
export function hibernationAgeNote(box: Pick<Instance, 'status' | 'hibernatedAt'>, now = Date.now()): string | null {
  const days = hibernatedDays(box, now);
  if (days === null || days < HIBERNATION_WARN_DAYS) return null;
  return `Hibernated ${days} days. EC2 allows ${HIBERNATION_LIMIT_DAYS}; termag resumes and re-hibernates it at 55.`;
}

export interface BoxDisplay {
  dot: string;
  spinning: boolean;
  /** Short state for the box row; null means show the project count instead. */
  label: string | null;
}

export function boxDisplay(status: InstanceStatus): BoxDisplay {
  switch (status) {
    case 'ready': return { dot: 'var(--success)', spinning: false, label: null };
    case 'provisioning': return { dot: 'var(--warning)', spinning: true, label: 'provisioning…' };
    case 'awaiting-agent': return { dot: 'var(--warning)', spinning: true, label: 'awaiting…' };
    case 'stopping': return { dot: 'var(--warning)', spinning: true, label: 'stopping…' };
    case 'starting': return { dot: 'var(--warning)', spinning: true, label: 'starting…' };
    case 'hibernating': return { dot: 'var(--warning)', spinning: true, label: 'hibernating…' };
    case 'stopped': return { dot: 'var(--text-secondary)', spinning: false, label: 'stopped' };
    case 'hibernated': return { dot: 'var(--text-secondary)', spinning: false, label: 'hibernated' };
    case 'failed': return { dot: 'var(--danger)', spinning: false, label: 'failed' };
    default: return { dot: 'var(--danger)', spinning: false, label: status };
  }
}

/**
 * Whether a box's agents are down on purpose (stopped or hibernated, or on
 * the way down or up). Its projects' last reported statuses are stale then,
 * so rows show the box state instead.
 */
export function isBoxParked(status: InstanceStatus | undefined): boolean {
  return status === 'stopping' || status === 'stopped' || status === 'starting'
    || status === 'hibernating' || status === 'hibernated';
}

/**
 * Whether a box's provisioningError is a power error to show under it: a start
 * whose agent never came, a start that didn't take, a stop or hibernate EC2
 * never did (which leaves the box ready), or a hibernate that fell back to a
 * plain stop. The backend clears it on the next power request or post-start
 * connect. A failed box shows its error in the dot's tooltip.
 */
export function showsBoxError(box: Pick<Instance, 'status' | 'provisioningError'>): boolean {
  return !!box.provisioningError && (box.status === 'starting' || box.status === 'stopped'
    || box.status === 'hibernated' || box.status === 'ready');
}
