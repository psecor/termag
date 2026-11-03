/**
 * Whether a box may update itself: the box-auto-update-enabled flag, evaluated
 * for the box's owner.
 *
 * deploy/termag-box-update --when-enabled (what termag-box-update.service
 * runs when the orchestrator's box-update RPC starts it) asks this through
 * GET /api/box-update/policy (routes/boxUpdatePolicy.ts) before doing
 * anything, and treats every answer but an enabled one as a no. The push
 * checks the same flag before it sends; this is the box's
 * own check, so the flag is the kill switch whatever started the run: off,
 * and the next run on every box does nothing. The box keeps no state of its
 * own.
 */
import { CLAIM_UPDATE_TIMEOUT_MS } from './claimUpdateGate';
import { boolVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';

export const BOX_AUTO_UPDATE_FLAG = 'box-auto-update-enabled';

export interface BoxUpdatePolicy {
  enabled: boolean;
  /** Why not, when not; `claim` when a claim's update opened it (routes/boxUpdatePolicy.ts). */
  reason?: 'flag-off' | 'claim';
}

/** Evaluated on the owner + box multi-context, the same context the push uses (boxUpdate.ts), so one targeting rule reaches both. */
export async function boxUpdatePolicy(owner: FlagUser, box?: FlagBox | null): Promise<BoxUpdatePolicy> {
  const enabled = await boolVariation(BOX_AUTO_UPDATE_FLAG, owner, false, box);
  return enabled ? { enabled: true } : { enabled: false, reason: 'flag-off' };
}

/** How long after `claimUpdateStartedAt` an `updating` row still opens the gate: the claim's whole wait, and some for the box's ask inside it. */
export const CLAIM_UPDATE_POLICY_MS = CLAIM_UPDATE_TIMEOUT_MS + 60_000;

/**
 * Whether a box may update although the flag is off: a claim's update is
 * under way (claimUpdate.ts). Read from the row, since the box's ask can land
 * on any process; a run that never finished stops opening it after
 * CLAIM_UPDATE_POLICY_MS.
 */
export function claimUpdateOpensPolicy(row: { claimUpdateStatus: string | null; claimUpdateStartedAt: Date | null }, now: Date = new Date()): boolean {
  return row.claimUpdateStatus === 'updating' && !!row.claimUpdateStartedAt
    && now.getTime() - row.claimUpdateStartedAt.getTime() < CLAIM_UPDATE_POLICY_MS;
}
