/**
 * Warm pool planner
 *
 * The pure half of the refill reconciler: a snapshot of the pool's rows plus
 * the policy in, the actions to take out. `warmPool.ts` owns every side effect
 * and `boxProvisioner.ts` owns the stuck sweep, so every rule below is settled
 * by a test with a literal expectation rather than by a live box.
 *
 * Nothing here reads the clock, the database, or the environment. `now` is an
 * input, which is what makes a rollover or a five-minute-old disconnect a
 * one-line test case instead of a staging run.
 */

/** Why a box left the pool without ever being claimed. */
export type FailReason = 'agent lost';

/** Why a box is being torn down. Each value is a distinct operator story. */
export type TerminateReason =
  | 'stale'    // launched from a different pool spec than the current one
  | 'max-age'  // on the current spec but past its recycle age
  | 'surplus'  // more claimable boxes than the target
  | 'drain';   // the target is 0, so the pool should not exist at all

/** The projection of `Instance` the reconciler selects for a tick. */
export interface PoolRowView {
  id: string;
  /**
   * `failed` rows are here only to feed the breaker. The action rules ignore
   * them, because a failed box is left for an operator to look at rather than
   * cleaned up from under them.
   */
  status: 'warming' | 'warm' | 'failed';
  poolSpecHash: string | null;
  createdAt: Date;
  warmedAt: Date | null;
  lastConnectedAt: Date | null;
  agentDisconnectedAt: Date | null;
  /** The recorded failure, quoted in the breaker's log line. */
  provisioningError: string | null;
}

export interface PlanInput {
  rows: PoolRowView[];
  /**
   * The most recent successful warm on ANY box, including boxes that have
   * since been claimed or retired and so are no longer in `rows`. It is what
   * closes the breaker, and reading it off `rows` alone would re-open the
   * breaker the moment the box that closed it got claimed.
   */
  lastWarmedAt: Date | null;
  target: number;
  maxInFlight: number;
  currentHash: string;
  maxAgeMs: number;
  agentLostAfterMs: number;
  breakerWindowMs: number;
  breakerThreshold: number;
  now: Date;
}

export interface PoolPlan {
  /** How many `warming` rows to insert and launch this tick. */
  launch: number;
  fail: { id: string; reason: FailReason }[];
  terminate: { id: string; reason: TerminateReason }[];
  breaker: { open: boolean; failures: number; lastError: string | null };
  /**
   * The two counts the deficit was computed from, both on the current spec.
   * Returned so the reconciler and the pool's read endpoints can report supply
   * without re-deriving liveness or staleness and drifting from the rules used
   * here. Neither is the number the in-flight cap uses, which counts every
   * `warming` row whatever spec it launched from.
   */
  supply: { claimable: number; inFlight: number };
}

/** A pool row with the three questions every rule asks already answered. */
interface Classified {
  row: PoolRowView;
  /** Null when the box still matches the current pool spec and is inside its age. */
  stale: Extract<TerminateReason, 'stale' | 'max-age'> | null;
  agentLive: boolean;
  agentGoneForMs: number;
}

export function planWarmPool(input: PlanInput): PoolPlan {
  const breaker = assessBreaker(input);

  const pool = input.rows
    .filter((row) => row.status === 'warming' || row.status === 'warm')
    .map((row) => classify(row, input));

  const warming = pool.filter((c) => c.row.status === 'warming');
  const warm = pool.filter((c) => c.row.status === 'warm');

  // A warm box whose agent has been gone past the limit is not coming back, so
  // it is failed rather than handed to somebody. It was never counted as
  // supply, so the deficit below already holds its slot and the replacement
  // launches on this same tick.
  const lost = warm.filter((c) => !c.agentLive && c.agentGoneForMs > input.agentLostAfterMs);
  const lostIds = new Set(lost.map((c) => c.row.id));
  const held = warm.filter((c) => !lostIds.has(c.row.id));

  // Supply is the current-spec warm boxes that have not been given up on. A
  // stale box is claimable in SQL but must not count here, or its replacement
  // would never be launched and it would never reach the retirement condition
  // below.
  //
  // A box inside the agent-lost grace window still counts, even though the
  // claim statement would skip it, because every rolling deploy stamps a
  // disconnect on every warm box as the old pod's sockets close. Dropping them
  // from supply on that edge launches a replacement per box, which then retires
  // as surplus once the agents dial back in. The cost of counting them is that
  // a claim in those few minutes can find nothing and fall back to the cold
  // path, which is the fallback WP-5 already requires to work.
  const claimable = held.filter((c) => c.stale === null);
  const inFlight = warming.filter((c) => c.stale === null);
  const supply = { claimable: claimable.length, inFlight: inFlight.length };

  if (input.target <= 0) {
    // Target 0 means the pool should not exist. Everything goes, nothing is
    // launched, and the claim path falls back to cold provisioning on its own.
    //
    // `warm`, not `held`: a box whose agent is gone is exactly the one a drain
    // must not leave behind. Failing it instead would stop at the row and
    // leave its EC2 instance running and billing, because only a retirement
    // reaches terminateBox.
    return {
      launch: 0,
      fail: [],
      terminate: oldestFirst([...warming, ...warm]).map((c) => ({ id: c.row.id, reason: 'drain' as const })),
      breaker,
      supply,
    };
  }

  const deficit = Math.max(0, input.target - (claimable.length + inFlight.length));
  // Every `warming` row counts against the cap, including one being retired as
  // stale: its EC2 instance is still booting until AWS actually kills it, and
  // the cap exists to stop a refill storm starving a real cold provision.
  const headroom = Math.max(0, input.maxInFlight - warming.length);

  const terminate: { id: string; reason: TerminateReason }[] = [];

  // A warming box is not claimable, so retiring a stale one costs no
  // availability and returns its slot to the cap for a replacement.
  for (const c of oldestFirst(warming)) {
    if (c.stale) terminate.push({ id: c.row.id, reason: c.stale });
  }

  // Replacement before retirement. A stale warm box stays claimable until the
  // pool is back at target on the current spec, so publishing a new AMI rolls
  // the pool over without an empty window. The claim statement filters on the
  // current hash, so a stale box is only ever handed out when nothing current
  // is warm.
  if (claimable.length >= input.target) {
    for (const c of oldestFirst(held)) {
      if (c.stale) terminate.push({ id: c.row.id, reason: c.stale });
    }
  }

  // Surplus goes oldest first, which is also claim order, so what survives a
  // lowered target is the newest and longest-lived set.
  const surplus = Math.max(0, claimable.length - input.target);
  for (const c of oldestFirst(claimable).slice(0, surplus)) {
    terminate.push({ id: c.row.id, reason: 'surplus' });
  }

  // Current-spec boxes still booting beyond what the target leaves room for,
  // after a lowered target, would only warm up to be retired as surplus. A
  // warming box is not claimable, so retiring it now costs no availability.
  // Newest first: the oldest is closest to warm.
  const room = Math.max(0, input.target - claimable.length);
  for (const c of oldestFirst(inFlight).reverse().slice(0, Math.max(0, inFlight.length - room))) {
    terminate.push({ id: c.row.id, reason: 'surplus' });
  }

  return {
    launch: breaker.open ? 0 : Math.min(deficit, headroom),
    fail: oldestFirst(lost).map((c) => ({ id: c.row.id, reason: 'agent lost' as const })),
    terminate,
    breaker,
    supply,
  };
}

export type StuckWarmingReason = 'no-agent' | 'incomplete';

/**
 * The stuck sweep's verdict on a `warming` row, or null while it still has
 * time. Pure, and here rather than in the sweep, because the two windows are
 * exactly the sort of number that gets edited without anyone noticing.
 *
 * The second window deliberately does not look at `onWarmStatus`. A healthy
 * box leaves `warming` well inside it, so anything still warming past the
 * window is broken however its on-warm run reports. That includes the box
 * whose scripts succeeded but whose agent died before the promotion could
 * land, which no other rule would ever move.
 */
export function stuckWarmingReason(input: {
  createdAt: Date;
  lastConnectedAt: Date | null;
  now: Date;
  noAgentAfterMs: number;
  incompleteAfterMs: number;
}): StuckWarmingReason | null {
  const ageMs = input.now.getTime() - input.createdAt.getTime();
  if (input.lastConnectedAt === null && ageMs >= input.noAgentAfterMs) return 'no-agent';
  if (ageMs >= input.incompleteAfterMs) return 'incomplete';
  return null;
}

function classify(row: PoolRowView, input: PlanInput): Classified {
  const live = agentLive(row);
  return {
    row,
    stale: staleReason(row, input),
    agentLive: live,
    agentGoneForMs: live || row.agentDisconnectedAt === null
      ? 0
      : input.now.getTime() - row.agentDisconnectedAt.getTime(),
  };
}

/**
 * A connect does not clear `agentDisconnectedAt`. The connect and close
 * writes are both fire-and-forget and unordered, so clearing it would revive a
 * box whose disconnect had already landed. Comparing the two timestamps is
 * therefore the only correct liveness test, and a single-column check on
 * either one reads a live box as dead or a dead box as live.
 */
function agentLive(row: PoolRowView): boolean {
  if (row.agentDisconnectedAt === null) return true;
  if (row.lastConnectedAt === null) return false;
  return row.agentDisconnectedAt.getTime() < row.lastConnectedAt.getTime();
}

function staleReason(row: PoolRowView, input: PlanInput): Classified['stale'] {
  if (row.poolSpecHash !== input.currentHash) return 'stale';
  // Age runs from createdAt, not warmedAt: what goes stale is the image and the
  // toolchain the box booted with.
  if (input.now.getTime() - row.createdAt.getTime() > input.maxAgeMs) return 'max-age';
  return null;
}

function assessBreaker(input: PlanInput): PoolPlan['breaker'] {
  const cutoff = input.now.getTime() - input.breakerWindowMs;
  const lastWarm = input.lastWarmedAt?.getTime() ?? -Infinity;

  const failures = input.rows
    // Only a box that never became claimable. The breaker exists to stop
    // launching into a broken warm path, so a box that warmed and later failed
    // for losing its agent is not evidence against the next launch. Counting
    // it would let one network blip across the fleet stop the refills that
    // blip just made necessary. `warmedAt` is the discriminator because it
    // survives the failure, and the claim, that follows it.
    .filter((row) => row.status === 'failed' && row.warmedAt === null)
    .map((row) => ({ at: failedAtLowerBound(row).getTime(), error: row.provisioningError }))
    // Consecutive, not merely recent. A successful warm is what closes the
    // breaker, so a failure older than the last warm is already spent and
    // three failures either side of one success must not add up to an open
    // breaker.
    .filter((f) => f.at >= cutoff && f.at > lastWarm)
    .sort((a, b) => b.at - a.at);

  return {
    open: failures.length >= input.breakerThreshold,
    failures: failures.length,
    lastError: failures[0]?.error ?? null,
  };
}

/**
 * When a failed row failed, as far as its own columns can say.
 *
 * There is no `failedAt` column and this planner may not add one, so this
 * takes the latest event the row does record. That is a lower bound and never
 * an upper one: the failure cannot predate the last thing that happened to the
 * box. It can lag the truth by as much as the stuck sweep's window, because a
 * box that failed for never connecting records nothing after `createdAt`.
 *
 * The lag only ever ages a failure out of the breaker window, or behind the
 * last successful warm, earlier than the truth would. So the error is always
 * in the direction of leaving launches running, never of wrongly stopping
 * them: this can miss a breaker that should have opened, and cannot open one
 * that should not have.
 */
function failedAtLowerBound(row: PoolRowView): Date {
  const events = [row.createdAt, row.warmedAt, row.lastConnectedAt, row.agentDisconnectedAt]
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime());
  return new Date(Math.max(...events));
}

/** Claim order, and therefore retirement order. Ties break on id so a plan is reproducible. */
function oldestFirst(rows: Classified[]): Classified[] {
  return [...rows].sort((a, b) =>
    a.row.createdAt.getTime() - b.row.createdAt.getTime() || a.row.id.localeCompare(b.row.id));
}
