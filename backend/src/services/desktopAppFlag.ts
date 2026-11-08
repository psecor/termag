import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';

/**
 * `desktop-live-chat-enabled`, for the person: the desktop's thread sends a
 * termag chat's turns through its chat runner (routes/cliChats.ts), so web and
 * the desktop share one live session instead of handing it over. Off by default.
 */
export const DESKTOP_LIVE_CHAT_FLAG = 'desktop-live-chat-enabled';

export async function desktopLiveChatEnabled(user: FlagUser): Promise<boolean> {
  return boolVariation(DESKTOP_LIVE_CHAT_FLAG, user, false);
}

/** What a box agent that can run the desktop's t3 server announces (agent/t3-bridge.js). */
export const T3_CAPABILITY = 't3-v1';
