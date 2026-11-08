/**
 * Box lifecycle product events beyond the start (`box.resumed`, in
 * ./boxStartLatency): every stop or hibernate asked for, by whom, and what
 * EC2 made of it; and a new box's first connect. Plus the dimensions every
 * box lifecycle event carries, so a chart can be cut by them
 * (docs/agents/observability.md, "Product events").
 *
 * The settle is timed like a start: one in-memory watch per box, armed when
 * the request is accepted. A restart before the sweep settles the box drops
 * the clock and who asked, not the event: `settleSec` and `by` are then left
 * out.
 */
import type { Instance } from '@prisma/client';
import { recordProductEvent, type ProductEventDetail } from './productEvents';

/** Who or what asked a box to stop or hibernate. */
export type SleepRequestedBy = 'owner' | 'idle' | 'stuck-start' | 'refresh' | 'resize';
export type SleepAction = 'stop' | 'hibernate';
/** What the power sweep settled a stop or hibernate to: `failed` is a timeout back to ready. */
export type SleepOutcome = 'stopped' | 'hibernated' | 'failed';

export type BoxDimensionSource = Partial<Pick<Instance,
  'kind' | 'region' | 'imageId' | 'imageSource' | 'hibernationConfigured' | 'claimedAt' | 'parentInstanceId'>>;

/**
 * The slicing fields every box lifecycle event carries, from the row alone:
 * ec2 or external, the region, the AMI and how it was chosen, whether the box
 * can hibernate, whether it came from the warm pool, and whether another box
 * created it. Unknown values are left out (productEventRecord skips null).
 * Not here: the instance type (a launch may fall back to another type and the
 * row doesn't record which) and the agent's commit (it arrives in the hello,
 * after the connect that makes a box ready).
 */
export function boxEventDimensions(box: BoxDimensionSource): ProductEventDetail {
  return {
    boxKind: box.kind ?? null,
    region: box.region ?? null,
    imageId: box.imageId ?? null,
    imageSource: box.imageSource ?? null,
    hibernationConfigured: box.hibernationConfigured ?? null,
    fromPool: box.claimedAt === undefined ? null : box.claimedAt !== null,
    child: box.parentInstanceId === undefined ? null : box.parentInstanceId !== null,
  };
}

/** Whole minutes since `since`, or null when there is no such instant or the clock went backwards. */
export function minutesSince(since: Date | null | undefined, nowMs: number): number | null {
  if (!since) return null;
  const ms = nowMs - since.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

interface SleepWatch {
  atMs: number;
  action: SleepAction;
  by: SleepRequestedBy | null;
}

const watches = new Map<string, SleepWatch>();

type SleepBox = Pick<Instance, 'id' | 'userId'> & BoxDimensionSource;

/**
 * EC2 accepted a stop or hibernate. `written` is the status requestPower
 * wrote, `stopping` for a hibernate EC2 refused and that fell back to a plain
 * stop.
 */
export function recordSleepRequested(box: SleepBox, action: SleepAction, written: string, by: SleepRequestedBy | null, nowMs = Date.now()): void {
  const fellBackToStop = action === 'hibernate' && written === 'stopping';
  watches.set(box.id, { atMs: nowMs, action, by });
  recordProductEvent('box.sleep.requested', { user: box.userId, box: box.id }, {
    action, fellBackToStop, by, ...boxEventDimensions(box),
  });
}

/** The status a stop or hibernate settled to, as the event names it; null for any other settle. */
export function sleepOutcome(from: string, to: string | undefined): SleepOutcome | null {
  if (from !== 'stopping' && from !== 'hibernating') return null;
  if (to === 'stopped' || to === 'hibernated') return to;
  if (to === 'ready') return 'failed';
  return null;
}

/**
 * The power sweep settled a `stopping` or `hibernating` box. `action` is what
 * was asked for (from the watch, else the status it settled from), so a
 * hibernate EC2 carried out as a plain stop reads action=hibernate,
 * outcome=stopped.
 */
export function recordSleepSettled(box: SleepBox & Pick<Instance, 'status'>, outcome: SleepOutcome, nowMs = Date.now()): void {
  const watch = watches.get(box.id);
  watches.delete(box.id);
  const action: SleepAction = watch?.action ?? (box.status === 'hibernating' ? 'hibernate' : 'stop');
  const settleMs = watch ? nowMs - watch.atMs : NaN;
  recordProductEvent('box.sleep.settled', { user: box.userId, box: box.id }, {
    action, outcome, by: watch?.by ?? null,
    settleSec: Number.isFinite(settleMs) && settleMs >= 0 ? Math.round(settleMs / 1000) : null,
    ...boxEventDimensions(box),
  });
}

/** A request EC2 refused: there is nothing to settle. */
export function forgetSleepRequest(boxId: string): void {
  watches.delete(boxId);
}

/**
 * A new box's agent connected for the first time (the guarded `readyAt`
 * write landed): cold provisioning, from the row's creation to that connect.
 * Pool boxes never get here; their warm-up is `warmedAt`.
 */
export function recordBoxReady(box: Pick<Instance, 'id' | 'userId' | 'createdAt'> & BoxDimensionSource, readyAt: Date, environment: string | null = null): void {
  // Never throws: the connect it describes must not depend on it.
  const ms = box.createdAt instanceof Date ? readyAt.getTime() - box.createdAt.getTime() : NaN;
  recordProductEvent('box.ready', { user: box.userId, box: box.id }, {
    provisionSec: Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null,
    // The environment the box was made from, null for none: which environments
    // are made most, and how long their boxes take, picks the first environment pools.
    environment,
    ...boxEventDimensions(box),
  });
}

/** Test hook. */
export function resetSleepWatchesForTests(): void {
  watches.clear();
}
