/**
 * Whether a user may start a new share: the boolean feature flag
 * `box-sharing-enabled`, off unless TERMAG_FLAGS turns it on.
 *
 * Evaluated for the person doing the action: the owner sending an invite, the
 * invitee accepting one (routes/sharing.ts). It gates only new shares. A share
 * that already exists keeps working whatever the flag says (terminal, CLI,
 * capture/send-keys, review, listing), and revoke, leave and decline stay open,
 * so turning the flag off never strands anyone.
 */
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';

export const BOX_SHARING_FLAG = 'box-sharing-enabled';

/** The `code` a refused invite or accept carries, for clients to tell it from other 403s. */
export const SHARING_DISABLED_CODE = 'sharing_disabled';

export async function boxSharingEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation(BOX_SHARING_FLAG, user, false);
}
