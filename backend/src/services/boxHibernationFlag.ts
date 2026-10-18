/**
 * Whether new boxes launch hibernation-capable: the boolean feature flag
 * `box-hibernation-enabled`, off unless TERMAG_FLAGS turns it on.
 *
 * It is read for two kinds of box, and the two reads are kept apart:
 *
 *   the warm pool   one evaluation per spec, for POOL_FLAG_CONTEXT, a fixed
 *                   context no user targeting matches, so it follows the
 *                   fallthrough. The value is part of the pool spec hash
 *                   (warmPool.currentPoolSpec), so flipping the fallthrough
 *                   rolls the pool.
 *   a user's box    evaluated for the owner (routes/instances.ts). An owner
 *                   whose value differs from the pool's (an individual
 *                   target or a rule) never claims a pool box and gets a
 *                   fresh launch instead, the way a box-image flag does:
 *                   EC2 fixes hibernation at launch.
 *
 * The flag only allows hibernation. The AMI's Hibernation=supported tag and
 * the instance type still decide (boxProvisioner.planHibernation), and an
 * image a user's box-image flag chose opts in on its own
 * (boxProvisioner.hibernationEnabledFor).
 */
import type { FlagContext } from './featureFlags';
import { boolVariation, boolVariationForContext } from './featureFlags';
import type { FlagUser } from './featureFlags';

export const BOX_HIBERNATION_FLAG = 'box-hibernation-enabled';

/** The warm pool's context: a box kind, so user targets and user rules never reach it. */
export const POOL_FLAG_CONTEXT: FlagContext = { kind: 'box', key: 'termag-warm-pool', name: 'warm pool', instanceKind: 'ec2' };

export async function poolHibernationEnabled(): Promise<boolean> {
  return boolVariationForContext(BOX_HIBERNATION_FLAG, POOL_FLAG_CONTEXT, false);
}

/**
 * Evaluated for the owner alone, like box-image: the claim decision it feeds
 * is made before there is a box row to add to the context.
 */
export async function ownerHibernationEnabled(owner: FlagUser): Promise<boolean> {
  return boolVariation(BOX_HIBERNATION_FLAG, owner, false);
}
