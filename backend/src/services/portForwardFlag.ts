/**
 * Whether the native port forward may reach a box: the
 * boolean flag `box-port-forward-enabled`, off by default and
 * whenever flags are. Evaluated for the box's owner and the box, so it
 * can be turned on for one person or one box first.
 */
import { boolVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';

export const PORT_FORWARD_FLAG = 'box-port-forward-enabled';

export async function portForwardEnabled(user: FlagUser, box: FlagBox): Promise<boolean> {
  return boolVariation(PORT_FORWARD_FLAG, user, false, box);
}

/** What a box agent that can open `port` tunnels announces in its hello. */
export const PORT_FORWARD_CAPABILITY = 'port-forward-v1';
