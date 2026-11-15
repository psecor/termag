/**
 * Which placement policy a person's New sessions follow:
 * their own setting (User.boxPlacement) once they have set one, else the org
 * default box-placement-policy serves them. Kept apart from the route so
 * /auth/me can say both without loading the box reads.
 */
import { stringVariation } from './featureFlags';
import { BOX_PLACEMENT_POLICY_FLAG, DEFAULT_PLACEMENT_POLICY, isPlacementPolicy, type PlacementPolicy } from './boxPlacement';

let loggedPolicy: string | null = null;

/** The org default for this person: box-placement-policy, where anything but a policy reads as reuse first (logged once). */
export async function orgPlacementPolicy(user: Express.User): Promise<PlacementPolicy> {
  const served = await stringVariation(BOX_PLACEMENT_POLICY_FLAG, user, DEFAULT_PLACEMENT_POLICY);
  if (isPlacementPolicy(served)) return served;
  if (loggedPolicy !== served) {
    loggedPolicy = served;
    console.warn(`[PLACEMENT] ${BOX_PLACEMENT_POLICY_FLAG} served ${JSON.stringify(served)}, not reuse-first or fresh-first; reading it as ${DEFAULT_PLACEMENT_POLICY}`);
  }
  return DEFAULT_PLACEMENT_POLICY;
}

/** The policy this person's New sessions follow, and where it came from. */
export async function placementPolicyFor(user: Express.User): Promise<{ policy: PlacementPolicy; source: 'personal' | 'org' }> {
  if (isPlacementPolicy(user.boxPlacement)) return { policy: user.boxPlacement, source: 'personal' };
  return { policy: await orgPlacementPolicy(user), source: 'org' };
}
