/**
 * Claiming a warm box
 *
 * Handing a pool box to a user is a loop over candidates, and every rule the
 * plan asks for is a behaviour of that loop: a drained pool, a box handed
 * over, a box whose agent will not answer, three of those in a row.
 * `claimWarmBox` is that loop over injected effects, so those four cases are
 * settled by a test instead of by a staging pool and a deliberately broken
 * box.
 *
 * `prismaClaimEffects` is the one implementation that touches Postgres and the
 * agent socket. `resendStalledClaims` finishes a claim whose SQL committed and
 * whose RPC never landed, which is the crash window the row lock cannot close.
 */

import { Instance, Prisma, User } from '@prisma/client';
import { prisma } from '../db';
import { connectedInstanceIds, disownInstanceAgent, rebindInstanceOwner, sendToInstanceAgent } from './agentRegistry';
import { syncBoxAuthorizedKeys } from './sshKeySync';
import { deliverToInstance } from './credentialDelivery';

/** Per-user gate on the whole claim path. Off unless TERMAG_FLAGS turns it on. */
export const WARM_POOL_ENABLED_FLAG = 'warm-pool-enabled';

/**
 * How many boxes a single Add box click will burn before giving up on the pool.
 * Each failed candidate costs one agent RPC timeout, so this is also the worst
 * case the user waits before the cold path starts.
 */
export const MAX_CLAIM_CANDIDATES = 3;

export const CLAIM_RESEND_AFTER_MS = 2 * 60 * 1000;

/**
 * The claimer. A whole `User` rather than a narrower shape because the claim
 * hands one to `rebindInstanceOwner`, and the `owned-box` connection it builds
 * stores exactly that type.
 */
export type ClaimOwner = User;

export interface ClaimRequest {
  owner: ClaimOwner;
  boxName: string;
  currentHash: string;
}

export interface ClaimEffects {
  /**
   * Instances whose agent socket this process holds. Postgres liveness alone
   * is not enough: after a restart, or on another replica, a row can read as
   * connected while no socket here can reach it, and its RPC would fail a
   * healthy box.
   */
  liveInstanceIds(): string[];
  /** The claim statement plus the token's userId, one transaction, over `liveIds` only. Null when no row matched. */
  takeWarmBox(req: ClaimRequest, liveIds: string[]): Promise<Instance | null>;
  /** Rebind the in-memory agent to the owner and run the box-claim RPC. Throws on either failure, with the rebind undone. */
  configureBox(instance: Instance, owner: ClaimOwner): Promise<BoxClaimAck>;
  /** Mark a candidate whose RPC failed unusable, with the reason. Must not throw. */
  abandonBox(instanceId: string, reason: string): Promise<void>;
  /** Acknowledge the claim: onClaimStatus pending to skipped. Must not throw. */
  settleClaim(instanceId: string): Promise<void>;
  /**
   * What a connect does for an owned box and a claim skips, because the box
   * connected while it had no owner and never reconnects: the owner's SSH
   * keys. Runs only for the box handed over. Must not throw.
   */
  welcomeOwner(instance: Instance, owner: ClaimOwner): Promise<void>;
}

/** What the box's agent said back to box-claim, beyond acknowledging it. */
export interface BoxClaimAck {
  /**
   * The agent will forward on-claim status frames for this claim. An agent
   * that predates dotfiles on claim acks without it, writes no URL and starts
   * no run, so nothing would ever move the row out of `pending`.
   */
  reportsOnClaim: boolean;
}

/**
 * Whether a claim's row stays `pending` for the on-claim run to settle, rather
 * than being settled on the RPC ack: only when there are dotfiles to apply and
 * the agent says it will report on them.
 */
export function claimAwaitsOnClaimReport(owner: { dotfilesRepoUrl: string | null }, ack: BoxClaimAck): boolean {
  return Boolean(owner.dotfilesRepoUrl) && ack.reportsOnClaim;
}

export type ClaimOutcome =
  | { claimed: true; instance: Instance; candidatesTried: number }
  | { claimed: false; reason: 'no-warm-box' | 'every-candidate-failed'; candidatesTried: number };

/**
 * Take a warm box for this owner, or say why not.
 *
 * The two `claimed: false` reasons get the same treatment from the caller, the
 * cold path, and are separate values because a drained pool and three broken
 * boxes are different operational stories and the log line has to tell them
 * apart.
 */
export async function claimWarmBox(req: ClaimRequest, effects: ClaimEffects): Promise<ClaimOutcome> {
  const liveIds = effects.liveInstanceIds();
  // No socket here means nothing this process could configure, whatever
  // Postgres says, so no row is taken (and none is failed) for it.
  if (liveIds.length === 0) return { claimed: false, reason: 'no-warm-box', candidatesTried: 0 };

  for (let tried = 0; tried < MAX_CLAIM_CANDIDATES; tried++) {
    const instance = await effects.takeWarmBox(req, liveIds);
    // An empty pool stays empty for the rest of this request. Asking again
    // would only burn round trips before the cold path everyone is waiting on.
    if (!instance) return { claimed: false, reason: 'no-warm-box', candidatesTried: tried };

    let ack: BoxClaimAck;
    try {
      ack = await effects.configureBox(instance, req.owner);
    } catch {
      await effects.abandonBox(instance.id, 'claim RPC failed');
      continue;
    }

    if (!claimAwaitsOnClaimReport(req.owner, ack)) {
      await effects.settleClaim(instance.id);
    }
    await effects.welcomeOwner(instance, req.owner);
    return { claimed: true, instance, candidatesTried: tried + 1 };
  }

  return { claimed: false, reason: 'every-candidate-failed', candidatesTried: MAX_CLAIM_CANDIDATES };
}

/**
 * Whether a claim's side effects have been outstanding long enough to re-send.
 *
 * Inclusive at the boundary, matching `stuckWarmingReason`, the other sweep
 * predicate in this pool.
 */
export function claimIsStalled(
  row: { claimedAt: Date | null },
  now: Date,
  stalledAfterMs: number,
): boolean {
  if (row.claimedAt === null) return false;
  return now.getTime() - row.claimedAt.getTime() >= stalledAfterMs;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Whether a thrown value is the partial unique index over (userId, name)
 * refusing a second live box with the same name.
 *
 * Three shapes, because the claim writes through `$queryRaw`: Prisma maps its
 * own writes to P2002, wraps a failed raw statement as P2010 carrying the
 * Postgres SQLSTATE, and a driver adapter can surface the SQLSTATE on its own.
 */
export function isNameConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'P2002' || code === UNIQUE_VIOLATION) return true;
  if (code !== 'P2010') return false;
  const meta = (err as Prisma.PrismaClientKnownRequestError).meta as { code?: unknown } | undefined;
  return String(meta?.code) === UNIQUE_VIOLATION;
}

export const prismaClaimEffects: ClaimEffects = {
  liveInstanceIds: connectedInstanceIds,
  takeWarmBox,
  configureBox,
  abandonBox,
  settleClaim,
  welcomeOwner,
};

/**
 * The tech spec's statement, with the row lock doing the work: `FOR UPDATE SKIP
 * LOCKED` is what makes two clicks in the same second take two different boxes,
 * and it holds across the two-pod overlap of a rolling deploy because the lock
 * lives in Postgres rather than in process memory.
 *
 * `onClaimStatus` is written `pending` unconditionally and means "claim side
 * effects outstanding", not "dotfiles running". The route settles it once the
 * RPC is acknowledged, which is what makes a row still reading `pending` a
 * claim whose RPC never landed and therefore re-sendable.
 */
async function takeWarmBox(req: ClaimRequest, liveIds: string[]): Promise<Instance | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Instance[]>`
      UPDATE instances
      SET "userId" = ${req.owner.id},
          name = ${req.boxName},
          status = 'ready',
          "claimedAt" = now(),
          "onClaimStatus" = 'pending'
      WHERE id = (
        SELECT id FROM instances
        WHERE status = 'warm'
          AND "userId" IS NULL
          AND "poolSpecHash" = ${req.currentHash}
          AND ("agentDisconnectedAt" IS NULL OR "agentDisconnectedAt" < "lastConnectedAt")
          AND id = ANY(${liveIds})
        ORDER BY "warmedAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    const claimed = rows[0];
    if (!claimed) return null;

    // userId only. Re-homing the token's instanceId would orphan every project
    // that points at the box the token currently names.
    await tx.agentToken.updateMany({
      where: { instanceId: claimed.id, revokedAt: null },
      data: { userId: req.owner.id },
    });

    return claimed;
  });
}

async function configureBox(instance: Instance, owner: ClaimOwner): Promise<BoxClaimAck> {
  const undoRebind = rebindInstanceOwner(instance, owner);
  if (!undoRebind) throw new Error('Instance agent not connected');
  try {
    return await sendBoxClaim(instance.id, owner);
  } catch (err) {
    undoRebind();
    throw err;
  }
}

async function welcomeOwner(instance: Instance, owner: ClaimOwner): Promise<void> {
  // The box's hello, which is what delivers credentials to an owned box, came
  // while it was ownerless, and the claim rebinds the socket without a redial.
  void deliverToInstance(instance.id, owner.id).catch(err => {
    console.error(`[CRED] delivery to instance ${instance.id} on claim failed:`, errMsg(err));
  });
  if (instance.kind !== 'ec2' || !instance.hostHome) return;
  try {
    await syncBoxAuthorizedKeys(instance.id, owner.id, instance.hostHome);
  } catch (err) {
    // The next reconnect's hello syncs them, as for any owned box.
    console.error(`[SSH-KEYS] instance ${instance.id}: sync on claim failed:`, errMsg(err));
  }
}

/** Git identity plus the optional dotfiles URL. Never a GitHub token. */
export function boxClaimPayload(owner: {
  displayName: string;
  googleEmail: string;
  dotfilesRepoUrl: string | null;
}): { ownerName: string; ownerEmail: string; dotfilesRepoUrl: string | null } {
  return {
    ownerName: owner.displayName,
    ownerEmail: owner.googleEmail,
    dotfilesRepoUrl: owner.dotfilesRepoUrl,
  };
}

async function sendBoxClaim(
  instanceId: string,
  owner: { displayName: string; googleEmail: string; dotfilesRepoUrl: string | null },
): Promise<BoxClaimAck> {
  const reply = await sendToInstanceAgent(instanceId, 'box-claim', boxClaimPayload(owner));
  if (!reply || reply.ok !== true) {
    throw new Error(`box-claim was not acknowledged: ${JSON.stringify(reply ?? null)}`);
  }
  return { reportsOnClaim: reply.reportsOnClaim === true };
}

/**
 * Put a candidate back down, unowned and failed.
 *
 * The owner comes off with it. The partial unique index over (userId, name)
 * counts every non-terminated row, so an abandoned box that kept the name the
 * user asked for would make the very next candidate's claim collide, and the
 * retry this function exists to enable would 409 instead of succeeding.
 * Ownerless and `failed` is also what a broken pool box already means to the
 * reconciler's breaker and to `GET /api/warm-pool`.
 *
 * The guard on `ready` is why the token revert is conditional: a row this
 * process no longer owns must be left entirely alone.
 */
async function abandonBox(instanceId: string, reason: string): Promise<void> {
  try {
    const reverted = await prisma.$transaction(async (tx) => {
      const changed = await tx.instance.updateMany({
        where: { id: instanceId, status: 'ready' },
        data: { userId: null, status: 'failed', provisioningError: reason },
      });
      if (changed.count === 0) return false;
      await tx.agentToken.updateMany({
        where: { instanceId, revokedAt: null },
        data: { userId: null },
      });
      return true;
    });
    // The live connection follows the row, whichever socket holds it now.
    if (reverted) disownInstanceAgent(instanceId);
    console.log(`[POOL] abandon ${instanceId}: ${reason}`);
  } catch (err) {
    console.error(`[POOL] could not abandon ${instanceId}:`, errMsg(err));
  }
}

async function settleClaim(instanceId: string): Promise<void> {
  try {
    await prisma.instance.updateMany({
      where: { id: instanceId, onClaimStatus: 'pending' },
      data: { onClaimStatus: 'skipped' },
    });
  } catch (err) {
    console.error(`[POOL] could not settle the claim on ${instanceId}:`, errMsg(err));
  }
}

/**
 * Re-send `box-claim` for claims whose RPC never landed, which is what a crash
 * between the statement's commit and the RPC leaves behind.
 *
 * Never throws and never fails a box. The user already owns it and it works in
 * every respect except its git identity, so a re-send that fails logs and
 * leaves the row `pending` for the next tick.
 *
 * No rebind here. The only way to reach this state is for the claiming process
 * to have died, which took its sockets with it, and the reconnecting agent's
 * token now carries the owner so `registerAgent` binds it correctly on its own.
 */
export async function resendStalledClaims(now: Date, stalledAfterMs: number = CLAIM_RESEND_AFTER_MS): Promise<void> {
  try {
    const pending = await prisma.instance.findMany({
      where: { status: 'ready', onClaimStatus: 'pending', claimedAt: { not: null } },
      select: {
        id: true,
        claimedAt: true,
        user: { select: { displayName: true, googleEmail: true, dotfilesRepoUrl: true } },
      },
    });

    for (const row of pending) {
      if (!row.user || !claimIsStalled(row, now, stalledAfterMs)) continue;
      try {
        const ack = await sendBoxClaim(row.id, row.user);
        if (!claimAwaitsOnClaimReport(row.user, ack)) await settleClaim(row.id);
        console.log(`[POOL] claim re-sent ${row.id}`);
      } catch (err) {
        console.warn(`[POOL] claim re-send failed for ${row.id}, retrying next tick:`, errMsg(err));
      }
    }
  } catch (err) {
    console.error('[POOL] stalled-claim sweep failed:', errMsg(err));
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
