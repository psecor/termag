/**
 * Environment pool planner.
 *
 * The pure half of the environment pool's reconciler, as warmPoolPlanner.ts is
 * the warm pool's: one environment's rows and what the environment is now in,
 * the actions out. envPool.ts reads the rows, resolves the environment and
 * carries the plan out. Nothing here reads the clock, the database or GitHub.
 *
 * What it decides, per environment:
 *   - how many boxes to launch (to its target, counting the ones still
 *     preparing), and in which subnet each goes: the one where this
 *     environment has the fewest boxes, so a claim refused for capacity in one
 *     zone can take a box in another;
 *   - which rows to retire: stale (prepared for another `setup`, image, type
 *     or size), surplus (newest prepared kept), or every one when the
 *     environment has no pool any more;
 *   - which `env-preparing` rows have been at it too long, and fail them;
 *   - whether a failure blocks launches: a `setup` that ran and failed at the
 *     environment's current hash and default-branch heads means a broken
 *     `setup`, and the pool waits for either to change rather than launching
 *     into it again; any other failure at them (a launch, the image, a clone,
 *     a timeout) only delays the next launch by `retryAfterMs`.
 *
 * The refresh is planEnvPoolRefresh,
 * on the plan's `stoppedRows`: each is checked every ENV_POOL_REFRESH_MINUTES,
 * skipped when its environment's default-branch heads are the ones it was
 * prepared at, refreshed in place otherwise. A row whose `poolSetupHash`
 * changed is stale and replaced by planEnvironmentPool, never refreshed.
 */

export type EnvPoolStatus = 'env-preparing' | 'env-stopping' | 'env-stopped' | 'env-starting' | 'env-failed';

export interface EnvPoolRowView {
  id: string;
  status: EnvPoolStatus;
  poolSetupHash: string | null;
  /** {"owner/name": sha}: what was prepared (or, on a failed row, what the attempt was at). */
  preparedCommit: Record<string, string> | null;
  preparedAt: Date | null;
  createdAt: Date;
  subnetId: string | null;
  /** When the refresh now running started it (env-preparing), else null: its prepare time counts from here. */
  refreshStartedAt: Date | null;
  /** When the refresh last checked it, skipped or started; null before its first check. */
  refreshCheckedAt: Date | null;
  /** When it failed (env-failed: terminatedAt); null on the other statuses. */
  terminatedAt?: Date | null;
  /** env-failed only: its setup ran and failed (Instance.poolSetupFailed), rather than its launch, image, clone or a timeout. */
  setupFailed?: boolean;
}

/** What the environment is now, or why the reconciler couldn't say. */
export type EnvPoolCurrent =
  | { ok: true; hash: string; heads: Record<string, string> }
  | { ok: false; reason: string };

export interface EnvPoolPlanInput {
  rows: EnvPoolRowView[];
  current: EnvPoolCurrent;
  target: number;
  /** What the in-flight cap leaves for this environment this tick. */
  headroom: number;
  /** BOX_SUBNET_ID then BOX_FALLBACK_SUBNET_IDS: where launches may go. */
  subnets: string[];
  prepareTimeoutMs: number;
  /** After a failure that wasn't setup's own (no heads recorded), no launch until this long has passed. */
  retryAfterMs?: number;
  now: Date;
}

export type EnvPoolRetireReason = 'stale' | 'surplus' | 'drain' | 'superseded';

export interface EnvPoolPlan {
  /** One entry per box to launch, with the subnet it starts its walk in (null: no subnets configured). */
  launch: { subnetId: string | null }[];
  retire: { id: string; reason: EnvPoolRetireReason }[];
  fail: { id: string; reason: string }[];
  /** Set when a failed setup at the current hash and heads holds the pool back. */
  blocked: { rowId: string } | null;
  /** Set when a recent failure that wasn't setup's own delays the next launch, until `until`. */
  retryAt: Date | null;
  supply: { stopped: number; preparing: number };
  /** The current `env-stopped` rows, newest prepared first: the claim order, and planEnvPoolRefresh's input. */
  stoppedRows: string[];
}

/** The statuses that hold a box in EC2 for this environment, for the zone balance. */
const HOLDS_A_BOX: ReadonlySet<EnvPoolStatus> = new Set(['env-preparing', 'env-stopping', 'env-stopped', 'env-starting']);

export function sameHeads(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (!a) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function planEnvironmentPool(input: EnvPoolPlanInput): EnvPoolPlan {
  const { rows, current, now } = input;
  const fail: EnvPoolPlan['fail'] = [];
  const retire: EnvPoolPlan['retire'] = [];

  // A prepare past its time is failed, whatever it is doing: a healthy one
  // clones and runs setup well inside the window.
  const timedOut = new Set<string>();
  for (const r of rows) {
    // A refresh's prepare counts from its start, not the box's launch hours ago.
    if (r.status === 'env-preparing' && now.getTime() - attemptAt(r).getTime() >= input.prepareTimeoutMs) {
      fail.push({ id: r.id, reason: `prepare timed out after ${Math.round(input.prepareTimeoutMs / 60_000)} min` });
      timedOut.add(r.id);
    }
  }
  const live = rows.filter(r => !timedOut.has(r.id));

  const failed = live.filter(r => r.status === 'env-failed');
  // A row is current when it was prepared for what the environment is now.
  // Unresolved (GitHub down, the credential gone), nothing is stale: the pool
  // is held as it is, and nothing new is launched until it resolves again.
  const isCurrent = (r: EnvPoolRowView) => !current.ok || r.poolSetupHash === current.hash;
  // Launched for what the environment is now: its setup hash, and the default-branch heads it launched at.
  const atCurrent = (r: EnvPoolRowView) => current.ok && r.poolSetupHash === current.hash && sameHeads(r.preparedCommit, current.heads);

  const blockedBy = current.ok
    ? [...failed].sort(newestCreated).find(r => r.setupFailed === true && atCurrent(r)) ?? null
    : null;
  // A failure the environment has moved past goes; the newest one is kept for
  // the environment's page, until a newer box succeeds or fails.
  const newestFailed = [...failed].sort(newestCreated)[0];
  for (const r of failed) {
    if (r === blockedBy) continue;
    if (r === newestFailed && !stoppedAfter(live, r)) continue;
    retire.push({ id: r.id, reason: 'superseded' });
  }

  const stopped = live.filter(r => r.status === 'env-stopped' || r.status === 'env-stopping');
  const preparing = live.filter(r => r.status === 'env-preparing');

  if (input.target <= 0) {
    // No pool wanted: every box this environment holds goes, except one a
    // claim is starting (that is somebody's box in a moment).
    for (const r of [...preparing, ...stopped]) retire.push({ id: r.id, reason: 'drain' });
    return { launch: [], retire, fail, blocked: null, retryAt: null, supply: { stopped: 0, preparing: 0 }, stoppedRows: [] };
  }

  for (const r of [...preparing, ...stopped]) if (!isCurrent(r)) retire.push({ id: r.id, reason: 'stale' });

  const currentStopped = stopped.filter(isCurrent).sort(newestPrepared);
  const currentPreparing = preparing.filter(isCurrent);
  // Surplus: the oldest prepared go first, so what is kept is the freshest checkout.
  for (const r of currentStopped.slice(input.target)) retire.push({ id: r.id, reason: 'surplus' });
  const keptStopped = currentStopped.slice(0, input.target);
  // Boxes still preparing past what the target leaves room for: the newest go, the oldest is closest to done.
  const room = Math.max(0, input.target - keptStopped.length);
  for (const r of [...currentPreparing].sort(newestCreated).slice(0, Math.max(0, currentPreparing.length - room))) {
    retire.push({ id: r.id, reason: 'surplus' });
  }

  const supply = { stopped: keptStopped.length, preparing: Math.min(currentPreparing.length, room) };
  const deficit = Math.max(0, input.target - supply.stopped - supply.preparing);
  // Until a box has prepared at the current hash, one at a time: a broken `setup` then costs one box, not a batch.
  const probe = keptStopped.length === 0 ? Math.max(0, 1 - currentPreparing.length) : deficit;
  const retryAt = envPoolRetryAt(failed, current, input.retryAfterMs ?? 0, now);
  const waiting = retryAt !== null;
  const count = !current.ok || blockedBy || waiting ? 0 : Math.min(deficit, probe, Math.max(0, input.headroom));

  // Zones: the subnet holding the fewest of this environment's boxes, ties in
  // configured order. Retired rows don't count; the launches planned here do.
  const retiring = new Set(retire.map(r => r.id));
  const held = new Map(input.subnets.map(s => [s, 0]));
  for (const r of live) {
    if (!HOLDS_A_BOX.has(r.status) || retiring.has(r.id) || !r.subnetId || !held.has(r.subnetId)) continue;
    held.set(r.subnetId, held.get(r.subnetId)! + 1);
  }
  const launch: EnvPoolPlan['launch'] = [];
  for (let i = 0; i < count; i++) {
    const subnetId = pickSubnet(input.subnets, held);
    if (subnetId) held.set(subnetId, held.get(subnetId)! + 1);
    launch.push({ subnetId });
  }

  return {
    launch,
    retire,
    fail,
    blocked: blockedBy ? { rowId: blockedBy.id } : null,
    retryAt,
    supply,
    stoppedRows: keptStopped.filter(r => r.status === 'env-stopped').map(r => r.id),
  };
}

/**
 * When launches and refreshes may go again after a failure that wasn't setup's (its launch, the image, a clone, a
 * fetch, a timeout): such a failure doesn't say the setup is broken, so it never holds the pool; it only spaces out
 * the retries of the same definition. Only a failure at the current hash and heads counts: one launched for an older
 * hash or older heads says nothing about the current one, so a new image, setup or commit goes at once. Null when
 * there is nothing to wait for (or the environment is unresolved).
 */
export function envPoolRetryAt(rows: EnvPoolRowView[], current: EnvPoolCurrent, retryAfterMs: number, now: Date): Date | null {
  if (!current.ok || retryAfterMs <= 0) return null;
  const last = rows
    .filter(r => r.status === 'env-failed' && r.setupFailed !== true && r.poolSetupHash === current.hash && sameHeads(r.preparedCommit, current.heads))
    .sort((a, b) => failedAt(b).getTime() - failedAt(a).getTime())[0];
  if (!last) return null;
  const at = new Date(failedAt(last).getTime() + retryAfterMs);
  return at > now ? at : null;
}

// ── Refreshing ───────────────────────────────────────────────────────────────

export interface EnvPoolRefreshInput {
  /** The environment's rows; only those named in `stoppedRows` are considered. */
  rows: EnvPoolRowView[];
  /** The plan's `stoppedRows`: current, kept, `env-stopped`. */
  stoppedRows: string[];
  current: EnvPoolCurrent;
  /** The plan held the pool for a setup that ran and failed at these heads: a refresh to them would fail the same way. */
  blocked: boolean;
  /** The plan's `retryAt`: a recent failure that wasn't setup's own spaces out refreshes as it does launches. */
  retryAt?: Date | null;
  /** ENV_POOL_REFRESH_MINUTES. */
  intervalMs: number;
  /** Boxes launched for the environment in this tick, after `rows` was read: each prepares at the current heads. */
  launched?: number;
  now: Date;
}

export interface EnvPoolRefreshPlan {
  /**
   * Due, and some repository's default branch moved since it was prepared: start it and prepare again. Oldest prepared
   * first; only one until a box has prepared at the current heads.
   */
  refresh: string[];
  /** Due, and nothing to catch up: checked, and left stopped until the next check. */
  skip: { id: string; reason: 'unchanged' }[];
  /**
   * Due, its heads moved, and a setup that failed at those heads holds the pool: not refreshed, and not checked
   * either, so it is still due, and refreshed as soon as the hold lifts (a fixed commit), as within `retryAt`.
   */
  held: string[];
}

/** When a stopped row is next checked: an interval after it was prepared or last checked, whichever is later. */
export function refreshDueAt(r: Pick<EnvPoolRowView, 'preparedAt' | 'refreshCheckedAt' | 'createdAt'>, intervalMs: number): Date {
  const from = Math.max((r.preparedAt ?? r.createdAt).getTime(), r.refreshCheckedAt?.getTime() ?? 0);
  return new Date(from + intervalMs);
}

/**
 * The refresh's check of an environment's stopped rows. A row is due an
 * interval after it was prepared or last checked. Unresolved (GitHub down, no
 * pool credential), or within the plan's `retryAt`, nothing is checked: the
 * rows stay as they are, due, and are checked once it resolves or the wait is
 * over. `blocked` (a setup that ran and failed at these heads, not any failed
 * row) holds a row whose heads moved (`held`), unchecked and still due.
 */
export function planEnvPoolRefresh(input: EnvPoolRefreshInput): EnvPoolRefreshPlan {
  const out: EnvPoolRefreshPlan = { refresh: [], skip: [], held: [] };
  if (!input.current.ok) return out;
  // Waiting out a failure that wasn't setup's (a fetch, the image, a timeout): nothing is checked, so each row is
  // still due, and checked, once the wait is over.
  if (input.retryAt && input.retryAt > input.now) return out;
  const heads = input.current.heads;
  const byId = new Map(input.rows.map(r => [r.id, r]));
  const due = input.stoppedRows.map(id => byId.get(id)).filter((r): r is EnvPoolRowView =>
    !!r && r.status === 'env-stopped' && refreshDueAt(r, input.intervalMs).getTime() <= input.now.getTime());
  for (const r of [...due].sort((a, b) => -newestPrepared(a, b))) {
    if (sameHeads(r.preparedCommit, heads)) out.skip.push({ id: r.id, reason: 'unchanged' });
    else if (input.blocked) out.held.push(r.id);
    else out.refresh.push(r.id);
  }
  // One box first, as launches probe: until a box has prepared at these heads, a broken setup must cost one box, not
  // every one that came due together. A box preparing at them (a refresh or a launch, including
  // one launched this tick, which `rows` predates) is that probe; once one has
  // prepared at them, the rest go together within the in-flight cap. Rows not started stay due, so the next tick
  // takes them.
  const provenAtHeads = input.rows.some(r => (r.status === 'env-stopped' || r.status === 'env-stopping') && sameHeads(r.preparedCommit, heads));
  if (!provenAtHeads) {
    const probing = (input.launched ?? 0) > 0 || input.rows.some(r => r.status === 'env-preparing' && sameHeads(r.preparedCommit, heads));
    out.refresh = probing ? [] : out.refresh.slice(0, 1);
  }
  return out;
}

/**
 * When the pool's stopped rows are next checked, for the environment's page:
 * the soonest any is due, never before `now` (one waiting for the in-flight
 * cap is due now) nor before `retryAt`. Null with no stopped row to check.
 */
export function nextRefreshAt(rows: Pick<EnvPoolRowView, 'preparedAt' | 'refreshCheckedAt' | 'createdAt'>[], intervalMs: number, now: Date, retryAt: Date | null = null): Date | null {
  if (!rows.length) return null;
  const soonest = Math.min(...rows.map(r => refreshDueAt(r, intervalMs).getTime()));
  // planEnvPoolRefresh checks nothing until the plan's retryAt (envPoolRetryAt).
  return new Date(Math.max(soonest, now.getTime(), retryAt?.getTime() ?? 0));
}

/** The subnet with the fewest boxes, the first configured on a tie; null with none configured. */
export function pickSubnet(subnets: string[], held: Map<string, number>): string | null {
  let best: string | null = null;
  for (const s of subnets) if (best === null || held.get(s)! < held.get(best)!) best = s;
  return best;
}

/** Whether a box was prepared after the failed row: a later success supersedes the failure. */
function stoppedAfter(rows: EnvPoolRowView[], failed: EnvPoolRowView): boolean {
  return rows.some(r => (r.status === 'env-stopped' || r.status === 'env-stopping') && r.preparedAt !== null && r.preparedAt > attemptAt(failed));
}

/** When the row's latest attempt began: its refresh's start, else its launch. */
export function attemptAt(r: Pick<EnvPoolRowView, 'refreshStartedAt' | 'createdAt'>): Date {
  return r.refreshStartedAt ?? r.createdAt;
}

function failedAt(r: EnvPoolRowView): Date {
  return r.terminatedAt ?? r.createdAt;
}

function newestCreated(a: EnvPoolRowView, b: EnvPoolRowView): number {
  return attemptAt(b).getTime() - attemptAt(a).getTime() || a.id.localeCompare(b.id);
}

function newestPrepared(a: EnvPoolRowView, b: EnvPoolRowView): number {
  return (b.preparedAt?.getTime() ?? 0) - (a.preparedAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
}
