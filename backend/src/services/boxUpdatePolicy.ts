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
import { boolVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';

export const BOX_AUTO_UPDATE_FLAG = 'box-auto-update-enabled';

export interface BoxUpdatePolicy {
  enabled: boolean;
  /** Why not, when not. */
  reason?: 'flag-off';
}

/** Evaluated on the owner + box multi-context, the same context the push uses (boxUpdate.ts), so one targeting rule reaches both. */
export async function boxUpdatePolicy(owner: FlagUser, box?: FlagBox | null): Promise<BoxUpdatePolicy> {
  const enabled = await boolVariation(BOX_AUTO_UPDATE_FLAG, owner, false, box);
  return enabled ? { enabled: true } : { enabled: false, reason: 'flag-off' };
}
