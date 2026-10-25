/**
 * Warm pool reconciler
 *
 * The side-effecting half of the pool. Every tick reads the pool's rows, hands
 * them to the pure planner in warmPoolPlanner.ts, and carries the plan out:
 * insert and launch, retire, fail.
 *
 * Shaped after startProvisioningSweep, the other background loop whose state
 * lives entirely in Postgres. That is what lets a rolling deploy run two of
 * these at once: neither holds a decision in memory, and the one insert that
 * two ticks could race on happens inside a serializable transaction that
 * re-counts first.
 */

import { EC2Client } from '@aws-sdk/client-ec2';
import { Instance, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../db';
import { warmPoolConfigFromEnv, type WarmPoolConfig } from '../config/env';
import {
  awsClientConfig,
  buildWarmCloudInit,
  discoverLatestAmi,
  getBoxConfig,
  provisionPoolBox,
  terminateBox,
  type BoxAmi,
  type BoxConfig,
} from './boxProvisioner';
import { poolHibernationEnabled } from './boxHibernationFlag';
import { planWarmPool, type PoolPlan, type PoolRowView } from './warmPoolPlanner';
import { ttlMemo } from './ttlMemo';
import { resendStalledClaims } from './warmPoolClaim';
import { warmPoolSizeOverride, warmPoolTargetSize, WARM_POOL_SIZE_FLAG } from './warmPoolSize';

/** A warm box whose agent has been gone this long is failed, not handed to anyone. */
const AGENT_LOST_AFTER_MS = 5 * 60 * 1000;

const BREAKER_WINDOW_MS = 60 * 60 * 1000;
const BREAKER_THRESHOLD = 3;

/**
 * How far beyond the breaker's window to select failed rows from. There is no
 * failedAt column, so the planner dates a failure from the latest event the
 * row records, which can sit up to the stuck sweep's 45 minutes after
 * createdAt. Selecting on createdAt alone would therefore hide a failure that
 * is still inside the window.
 */
const FAILED_SELECT_SLACK_MS = 45 * 60 * 1000;

let reconcileTimer: NodeJS.Timeout | null = null;

/** Last reported breaker state, so the closing line is logged on the edge. */
let breakerOpen = false;

/** What the last tick to reach the planner decided. */
export interface WarmPoolTickState {
  specHash: string;
  breakerOpen: boolean;
}

let lastTick: WarmPoolTickState | null = null;

/**
 * The reconciler's view, for readers that must not make an AWS call of their
 * own. `GET /api/warm-pool` is polled by every open browser, and re-deriving
 * the spec hash per request would put a DescribeImages behind each poll.
 *
 * Null until a tick has had something to decide, which on a deployment with
 * no pool wanted and none left over is never. Nothing is warm there either,
 * so a null hash and a staleness question have the same answer.
 */
export function lastWarmPoolTick(): WarmPoolTickState | null {
  return lastTick;
}

/**
 * The newest warmedAt this process has already logged. The promotion to `warm`
 * is written by the agent's own event handlers, so the tick is the only place
 * that observes it after the fact; the watermark turns that into one line per
 * box rather than one per tick. It is lost on restart, which re-logs at most
 * the target's worth of lines.
 */
let loggedWarmUpTo: Date | null = null;

export function startWarmPoolReconciler(intervalMs?: number): void {
  if (reconcileTimer) return;
  const policy = warmPoolConfigFromEnv(process.env);
  const override = warmPoolSizeOverride(process.env);
  if (override.ignored) console.warn(`[POOL] ${override.ignored}`);
  else if (override.size !== null) console.log(`[POOL] pool size ${override.size} from WARM_POOL_TARGET_SIZE (AUTH_MODE=local), not ${WARM_POOL_SIZE_FLAG}`);
  if (!getBoxConfig()) console.log('[POOL] box provisioning is not configured; the pool will stay empty');
  reconcileTimer = setInterval(reconcileWarmPool, intervalMs ?? policy.reconcileMs);
  reconcileTimer.unref?.();
}

export function stopWarmPoolReconciler(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

/** One tick. Never throws, so it is safe both on a timer and after a claim. */
export async function reconcileWarmPool(): Promise<void> {
  const cfg = getBoxConfig();
  if (!cfg) return;
  const policy = warmPoolConfigFromEnv(process.env);

  try {
    const now = new Date();
    const target = await warmPoolTargetSize();

    // First, and ahead of the early return below: a claim whose RPC never
    // landed belongs to a user already, so the pool's target has no bearing on
    // it, and the spec hash this tick needs next is an AWS call that can throw.
    await resendStalledClaims(now);

    const rows = await selectPoolRows(now);

    // The default outside staging: no pool wanted and none left over, so the
    // tick costs one indexed query and makes no AWS call at all.
    if (target <= 0 && rows.every((row) => row.status === 'failed')) return;

    const spec = await currentPoolSpec();
    const currentHash = spec.hash;
    const plan = planWarmPool({
      rows,
      lastWarmedAt: await latestWarmedAt(),
      target,
      maxInFlight: policy.maxInFlight,
      currentHash,
      maxAgeMs: policy.maxAgeMs,
      agentLostAfterMs: AGENT_LOST_AFTER_MS,
      breakerWindowMs: BREAKER_WINDOW_MS,
      breakerThreshold: BREAKER_THRESHOLD,
      now,
    });
    lastTick = { specHash: currentHash, breakerOpen: plan.breaker.open };

    logTick(currentHash, target, plan);
    logNewlyWarm(rows);
    logBreaker(plan);
    await failLostBoxes(plan);
    await launchBoxes(plan, spec, target, policy);
    await retireBoxes(plan);
  } catch (err) {
    console.error('[POOL] Reconcile failed:', errMsg(err));
  }
}

// ── The pool spec hash ────────────────────────────────────────────────────────

/**
 * A newly published AMI starts rolling the pool over up to five minutes later,
 * which is nothing against a box's boot time, and the tick stops making one
 * DescribeImages call per minute per replica.
 */
const POOL_SPEC_CACHE_MS = 5 * 60 * 1000;

/** Built on first use rather than at import, so no BoxConfig is snapshotted here. */
let latestPoolAmi: (() => Promise<BoxAmi>) | null = null;

/** Drops the cached AMI lookup, so the next hash re-reads it. Used by tests. */
export function resetPoolSpecCache(): void {
  latestPoolAmi = null;
}

/** The pool's current spec: its hash, and the box-hibernation-enabled value the hash was built from. */
export interface PoolSpec {
  hash: string;
  /** What the pool's launches pass as the flag; the AMI and the type still decide. */
  hibernation: boolean;
}

/**
 * Everything that makes a warm box current, as one value: the image it boots,
 * the instance type it boots on, the script that wires it up, and whether it
 * launches hibernation-capable. A box whose poolSpecHash differs from this is
 * stale and gets replaced.
 *
 * Nothing in it comes from the database, and the flag is read for a fixed
 * context (boxHibernationFlag.POOL_FLAG_CONTEXT), so every replica computes the
 * same hash. Only the AMI lookup is cached: the cloud-init shape is pure CPU,
 * the flag is an in-memory read, and a missing box config throws on every
 * call rather than being remembered.
 */
export async function currentPoolSpecHash(): Promise<string> {
  return (await currentPoolSpec()).hash;
}

export async function currentPoolSpec(): Promise<PoolSpec> {
  const config = requireBoxConfig();
  if (!latestPoolAmi) {
    latestPoolAmi = ttlMemo(
      () => {
        const cfg = requireBoxConfig();
        return discoverLatestAmi(new EC2Client(awsClientConfig(cfg)), cfg);
      },
      POOL_SPEC_CACHE_MS,
    );
  }
  const ami = await latestPoolAmi();
  const hibernation = await poolHibernationEnabled();

  return {
    hash: poolSpecHash({
      amiId: ami.imageId,
      instanceType: config.instanceType,
      warmCloudInit: warmCloudInitShape(config),
      hibernation: hibernation && ami.hibernationSupported,
    }),
    hibernation,
  };
}

/**
 * The hash the claim statement filters on, or null when there is no point
 * asking for one.
 *
 * Deriving it costs a DescribeImages call, so two indexed reads come first: a
 * target of 0 means the pool should not exist and every claim takes the cold
 * path (WP-2), and an empty pool has nothing for the statement to match. Both
 * are the common case on a deployment that has not opted in, and neither
 * should make a user's click wait on AWS. The cache in #104 is what makes the
 * call itself cheap once it is warranted.
 *
 * Failing soft matters more than the call: an AWS hiccup should cost the user
 * a cold box, not an error.
 */
export async function poolSpecHashOrNull(): Promise<string | null> {
  if (await warmPoolTargetSize() <= 0) return null;
  if (await prisma.instance.count({ where: { userId: null, status: 'warm' } }) === 0) return null;
  try {
    return await currentPoolSpecHash();
  } catch (err) {
    console.warn('[POOL] claim skipped, no pool spec hash:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The config both halves of the hash read. The memoized loader reads it again
 * rather than closing over the caller's copy, so a cached AMI can never be
 * paired with a different config's instance type.
 */
function requireBoxConfig(): BoxConfig {
  const config = getBoxConfig();
  if (!config) throw new Error('box provisioning is not configured, so there is no pool spec to hash');
  return config;
}

/**
 * sha256(amiId + "\n" + instanceType + "\n" + sha256(warm cloud-init)), per the
 * tech spec, with "\nhibernation" appended only for hibernation-capable
 * launches, so a pool launched without it keeps its hash and turning it on
 * rolls the pool over onto boxes that can hibernate.
 */
export function poolSpecHash(spec: { amiId: string; instanceType: string; warmCloudInit: string; hibernation?: boolean }): string {
  const template = createHash('sha256').update(spec.warmCloudInit).digest('hex');
  const suffix = spec.hibernation ? '\nhibernation' : '';
  return createHash('sha256').update(`${spec.amiId}\n${spec.instanceType}\n${template}${suffix}`).digest('hex');
}

/**
 * The warm cloud-init with its per-box values blanked. The token differs for
 * every box and the hash cannot contain itself, so neither belongs in the
 * input. The orchestrator URL stays in, because pointing boxes at a different
 * endpoint genuinely is a different spec and should roll the pool over.
 */
function warmCloudInitShape(cfg: BoxConfig): string {
  return buildWarmCloudInit({ termagUrl: cfg.agentWsUrl, agentToken: '', poolSpecHash: '' });
}

// ── Reading the pool ──────────────────────────────────────────────────────────

async function selectPoolRows(now: Date): Promise<PoolRowView[]> {
  const failedSince = new Date(now.getTime() - BREAKER_WINDOW_MS - FAILED_SELECT_SLACK_MS);
  const rows = await prisma.instance.findMany({
    where: {
      // Having no owner is what makes a row the pool's. A cold box has an owner
      // from creation and a claimed box has had one since the claim committed,
      // so neither can be counted as supply or fed to the breaker.
      userId: null,
      OR: [
        { status: { in: ['warming', 'warm'] } },
        { status: 'failed', createdAt: { gte: failedSince } },
      ],
    },
    select: {
      id: true,
      status: true,
      poolSpecHash: true,
      createdAt: true,
      warmedAt: true,
      lastConnectedAt: true,
      agentDisconnectedAt: true,
      provisioningError: true,
    },
  });

  // Instance.status is a free-form Postgres string, so it is parsed here
  // rather than asserted. A value the planner has no rule for is dropped
  // instead of being read as one of the three it does.
  return rows.flatMap((row) => {
    const status = poolStatusOf(row.status);
    return status ? [{ ...row, status }] : [];
  });
}

function poolStatusOf(raw: string): PoolRowView['status'] | null {
  return raw === 'warming' || raw === 'warm' || raw === 'failed' ? raw : null;
}

/**
 * The most recent successful warm on any box, including boxes that have since
 * been claimed or retired. It is what closes the breaker, and reading it off
 * the pool's own rows would re-open the breaker the moment the box that closed
 * it got claimed.
 */
async function latestWarmedAt(): Promise<Date | null> {
  const row = await prisma.instance.findFirst({
    where: { warmedAt: { not: null } },
    orderBy: { warmedAt: 'desc' },
    select: { warmedAt: true },
  });
  return row?.warmedAt ?? null;
}

// ── Carrying out the plan ─────────────────────────────────────────────────────

async function failLostBoxes(plan: PoolPlan): Promise<void> {
  for (const box of plan.fail) {
    // Guarded on `warm` so a box claimed between this tick's read and this
    // write is left alone. The row stays `failed` rather than terminated:
    // the lifecycle hands a failed box to an operator or the cleanup sweep,
    // and the pool has already launched its replacement.
    const changed = await prisma.instance.updateMany({
      where: { id: box.id, userId: null, status: 'warm' },
      data: { status: 'failed', provisioningError: box.reason },
    });
    if (changed.count > 0) console.log(`[POOL] fail ${box.id}: ${box.reason}`);
  }
}

async function launchBoxes(plan: PoolPlan, spec: PoolSpec, target: number, policy: WarmPoolConfig): Promise<void> {
  const currentHash = spec.hash;
  for (let i = 0; i < plan.launch; i++) {
    const launched = await insertPoolRow(currentHash, target, policy.maxInFlight);
    // Null means there is no longer room to launch, either because another pod
    // took the target or the cap, or because this tick's own earlier inserts
    // did. Either way, stop.
    if (!launched) break;

    console.log(`[POOL] launch ${launched.instance.id} (${launched.instance.name}) spec=${currentHash.slice(0, 12)} target=${target} warm=${plan.supply.claimable} warming=${plan.supply.inFlight}`);
    void provisionPoolBox({
      instance: launched.instance,
      token: launched.token,
      poolSpecHash: currentHash,
      hibernation: spec.hibernation,
    });
  }
}

async function insertPoolRow(
  currentHash: string,
  target: number,
  maxInFlight: number,
): Promise<{ instance: Instance; token: string } | null> {
  const rawToken = 'tmag_' + randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.substring(0, 13) + '...';
  // Postgres treats nulls as distinct, so an ownerless row cannot collide on
  // the partial unique index over (userId, name) whatever this name is.
  const name = `warm-${randomBytes(4).toString('hex')}`;

  try {
    const instance = await prisma.$transaction(
      async (tx) => {
        const supply = await tx.instance.count({
          where: { userId: null, status: { in: ['warming', 'warm'] }, poolSpecHash: currentHash },
        });
        if (supply >= target) return null;

        // Both halves of the planner's arithmetic have to hold here, not just
        // the target. A tick reads the pool's rows, resolves the spec hash,
        // and only then inserts, so another pod's launches can land inside
        // that gap. Re-checking the target
        // alone lets each pod insert its own capped batch on top of the
        // other's whenever the target is larger than the cap, and the cap is
        // what stops a refill storm starving a real cold provision.
        //
        // Every `warming` row counts whatever spec it launched from, matching
        // the planner: a box being retired as stale is still booting until AWS
        // kills it.
        const inFlight = await tx.instance.count({
          where: { userId: null, status: 'warming' },
        });
        if (inFlight >= maxInFlight) return null;

        const created = await tx.instance.create({
          data: { userId: null, name, kind: 'ec2', status: 'warming', poolSpecHash: currentHash },
        });
        await tx.agentToken.create({
          data: { userId: null, instanceId: created.id, name: `pool: ${name}`, tokenHash, tokenPrefix },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return instance ? { instance, token: rawToken } : null;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      console.log('[POOL] launch skipped: another tick filled the deficit (P2034)');
      return null;
    }
    throw err;
  }
}

async function retireBoxes(plan: PoolPlan): Promise<void> {
  for (const box of plan.terminate) {
    // Guarded on no owner and the two pool statuses, for the same reason as
    // the fail path: a lowered target or a drain must never reach a box a
    // claim has handed out. Losing a retirement to a claim costs nothing;
    // tearing down a box a user has just been handed costs them their session.
    const changed = await prisma.instance.updateMany({
      where: { id: box.id, userId: null, status: { in: ['warming', 'warm'] } },
      data: { status: 'terminated', terminatedAt: new Date() },
    });
    if (changed.count === 0) {
      console.log(`[POOL] retire ${box.id} skipped: no longer in the pool`);
      continue;
    }

    console.log(`[POOL] retire ${box.id}: ${box.reason}`);
    // Un-awaited, like the DELETE route: terminateBox waits for the EC2
    // instance to disappear before it can delete the security group, which is
    // minutes and must not hold up the tick. The row is marked first so the
    // next tick does not plan the same retirement again.
    const instance = await prisma.instance.findUnique({ where: { id: box.id } });
    if (instance) void terminateBox(instance);
  }
}

// ── Observability ─────────────────────────────────────────────────────────────

function logTick(hash: string, target: number, plan: PoolPlan): void {
  console.log(
    `[POOL] tick spec=${hash.slice(0, 12)} target=${target} warm=${plan.supply.claimable} warming=${plan.supply.inFlight} launch=${plan.launch} retire=${plan.terminate.length} fail=${plan.fail.length} breaker=${plan.breaker.open ? 'open' : 'closed'}`,
  );
}

function logNewlyWarm(rows: PoolRowView[]): void {
  const fresh = rows
    .flatMap((row) => (row.status === 'warm' && row.warmedAt !== null
      ? [{ id: row.id, at: row.warmedAt, bootMs: row.warmedAt.getTime() - row.createdAt.getTime() }]
      : []))
    .filter((box) => loggedWarmUpTo === null || box.at > loggedWarmUpTo)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  for (const box of fresh) {
    console.log(`[POOL] warm ${box.id} after ${Math.round(box.bootMs / 1000)}s`);
    loggedWarmUpTo = box.at;
  }
}

function logBreaker(plan: PoolPlan): void {
  if (plan.breaker.open) {
    // Once per tick while open, not once on the edge, so the condition shows
    // up in a log tail taken at any moment rather than only at the transition.
    console.log(`[POOL] breaker open: ${plan.breaker.failures} warming failures in the last hour, last was ${plan.breaker.lastError ?? 'not recorded'}`);
  } else if (breakerOpen) {
    console.log('[POOL] breaker closed: a box warmed successfully');
  }
  breakerOpen = plan.breaker.open;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
