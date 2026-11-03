/**
 * Whether the desktop app may reach a box: the boolean feature flag
 * `desktop-app-enabled`, off unless TERMAG_FLAGS turns it on.
 * Evaluated for the box's owner and the box, so it can be turned on for one
 * person or one box first; for the person alone on routes that name no box
 * (the briefing and working time).
 */
import { boolVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';

export const DESKTOP_APP_FLAG = 'desktop-app-enabled';

export async function desktopAppEnabled(user: FlagUser, box?: FlagBox): Promise<boolean> {
  return boolVariation(DESKTOP_APP_FLAG, user, false, box);
}

/** The same flag for the user alone, for the desktop's routes that reach no box (its PR page, routes/cliPrs.ts). */
export async function desktopAppEnabledForUser(user: FlagUser): Promise<boolean> {
  return boolVariation(DESKTOP_APP_FLAG, user, false);
}

/** What a box agent that can run the desktop's t3 server announces (agent/t3-bridge.js). */
export const T3_CAPABILITY = 't3-v1';
