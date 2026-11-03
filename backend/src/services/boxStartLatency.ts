/**
 * How long a stopped or hibernated box takes to come back, and when the
 * wake was asked for.
 *
 * `readyAt` is the first cold connect and the Fleet "provisioned in" column
 * is `readyAt - createdAt`. Neither moves on a later start. The power sweep's
 * `requestedAt` clock only decides timeouts, and a restart forgets it. This
 * module keeps the same kind of clock — one in-memory watch per box, armed
 * in `requestPower` — and turns it into a `box.resumed` product event when
 * the start reaches an outcome. A restart while the box is `starting` drops
 * that sample rather than timing it from when the sweep next noticed it.
 * Stopping the box again before any outcome drops it too.
 *
 * The hour is the request, in UTC, not the outcome. A resume that crosses an
 * hour still counts in the hour the box was woken.
 *
 * `downMinutes` is how long the box had been down when the start was asked
 * for: since the power sweep settled its stop or hibernate (`downSince`), or,
 * for a box hibernated before that column, since `hibernatedAt`.
 */
import type { Instance } from '@prisma/client';
import { boxEventDimensions, minutesSince, type BoxDimensionSource } from './boxPowerEvents';
import { recordProductEvent, type ProductEventDetail } from './productEvents';

export type ResumeFrom = 'stop' | 'hibernate';
export type StartOutcome = 'ready' | 'failed' | 'still-starting';
/** A caller of `requestPower`, or the power sweep's own 60-day refresh. */
export type StartSource = 'user' | 'sweep';
/** Who a start is for, where the caller says (RequestPowerOptions.startedBy). */
export type StartedBy = 'owner' | 'automation' | 'cloud' | 'ask' | 'refresh' | 'guest' | 'resize';

export interface StartLatency {
  /** Whole seconds from the start request to this observation. */
  durationSec: number;
  /** UTC hour (0-23) of the start request. */
  hourUtc: number;
}

/**
 * Seconds from the start request to this observation, and the UTC hour of
 * the request. Null when either instant is not a finite time or the clock
 * went backwards: a missing sample, not a duration of zero.
 */
export function startLatency(requestedAtMs: number, nowMs: number): StartLatency | null {
  if (!Number.isFinite(requestedAtMs) || !Number.isFinite(nowMs)) return null;
  const durationMs = nowMs - requestedAtMs;
  if (durationMs < 0) return null;
  const hourUtc = new Date(requestedAtMs).getUTCHours();
  if (!Number.isInteger(hourUtc)) return null;
  return { durationSec: Math.round(durationMs / 1000), hourUtc };
}

/** What a start is resuming, from the status `requestPower` moved out of. */
export function resumeFromStatus(status: string): ResumeFrom | null {
  if (status === 'stopped') return 'stop';
  if (status === 'hibernated') return 'hibernate';
  return null;
}

interface StartWatch {
  atMs: number;
  from: ResumeFrom;
  source: StartSource;
  by: StartedBy | null;
  /** Minutes since the lifecycle sweep parked the box, when it did and nobody started it since. */
  parkedMinutes: number | null;
  /** Minutes the box was down: since its stop or hibernate settled (`downSince`), else since it last hibernated. */
  downMinutes: number | null;
  /** The box's slicing fields as they were at the request (boxEventDimensions). */
  dimensions: ProductEventDetail;
  userId: string | null;
  stillStartingRecorded: boolean;
}

const watches = new Map<string, StartWatch>();

export function armBoxStart(
  box: Pick<Instance, 'id' | 'status' | 'userId'> & Partial<Pick<Instance, 'autoParkedAt' | 'downSince' | 'hibernatedAt'>> & BoxDimensionSource,
  source: StartSource,
  nowMs = Date.now(),
  by: StartedBy | null = null,
): void {
  const from = resumeFromStatus(box.status);
  if (!from) return;
  const parkedMinutes = box.autoParkedAt ? Math.max(0, Math.round((nowMs - box.autoParkedAt.getTime()) / 60_000)) : null;
  // hibernatedAt covers a box that went down before downSince was recorded; a stopped one has nothing else.
  const downMinutes = minutesSince(box.downSince ?? (from === 'hibernate' ? box.hibernatedAt : null), nowMs);
  watches.set(box.id, {
    atMs: nowMs, from, source, by, parkedMinutes, downMinutes, dimensions: boxEventDimensions(box), userId: box.userId, stillStartingRecorded: false,
  });
}

/** The event's fields past the outcome and the timing: who started it, and how long after an auto-park. */
function startFields(watch: StartWatch) {
  return {
    source: watch.source, by: watch.by, afterAutoPark: watch.parkedMinutes !== null, parkedMinutes: watch.parkedMinutes,
    downMinutes: watch.downMinutes, ...watch.dimensions,
  };
}

function emit(boxId: string, watch: StartWatch, outcome: StartOutcome, nowMs: number): void {
  const latency = startLatency(watch.atMs, nowMs);
  if (!latency) return;
  recordProductEvent('box.resumed', { user: watch.userId, box: boxId }, {
    from: watch.from,
    outcome,
    durationSec: latency.durationSec,
    hourUtc: latency.hourUtc,
    ...startFields(watch),
  });
}

/** The agent's connect landed the `starting` → `ready` write. */
export function recordBoxStartReady(boxId: string, nowMs = Date.now()): void {
  const watch = watches.get(boxId);
  if (!watch) return;
  watches.delete(boxId);
  emit(boxId, watch, 'ready', nowMs);
}

/** EC2 refused the start, or the sweep put the box back down. */
export function recordBoxStartFailed(boxId: string, nowMs = Date.now()): void {
  const watch = watches.get(boxId);
  if (!watch) return;
  watches.delete(boxId);
  emit(boxId, watch, 'failed', nowMs);
}

/**
 * The start timeout fired and the agent is still away. Once per start, and
 * the watch stays so a later ready or failure is timed from the same request.
 */
export function recordBoxStartStillStarting(boxId: string, nowMs = Date.now()): void {
  const watch = watches.get(boxId);
  if (!watch || watch.stillStartingRecorded) return;
  const latency = startLatency(watch.atMs, nowMs);
  if (!latency) return;
  watch.stillStartingRecorded = true;
  recordProductEvent('box.resumed', { user: watch.userId, box: boxId }, {
    from: watch.from,
    outcome: 'still-starting',
    durationSec: latency.durationSec,
    hourUtc: latency.hourUtc,
    ...startFields(watch),
  });
}

/** Test hook. */
export function resetBoxStartsForTests(): void {
  watches.clear();
}

/** Test hook: the watch armed for a box, if the start has not settled. */
export function boxStartWatchForTests(id: string): Pick<StartWatch, 'from' | 'source' | 'by' | 'parkedMinutes' | 'downMinutes' | 'userId' | 'atMs'> | undefined {
  const watch = watches.get(id);
  if (!watch) return undefined;
  return { from: watch.from, source: watch.source, by: watch.by, parkedMinutes: watch.parkedMinutes, downMinutes: watch.downMinutes, userId: watch.userId, atMs: watch.atMs };
}
