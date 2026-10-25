// mobile-web-push-enabled: the per-user rollout of web push.
// The VAPID keys turn push on for the orchestrator; this decides who gets it.
// Off (the default, and with TERMAG_FLAGS not setting it) the user sees push as
// not available, nothing is sent for their sessions, and their Slack/Discord
// posts are never muted for it.
import { prisma } from '../db';
import { boolVariation } from './featureFlags';

export const WEB_PUSH_FLAG = 'mobile-web-push-enabled';

export async function webPushEnabledFor(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
    if (!user) return false;
    return await boolVariation(WEB_PUSH_FLAG, user, false);
  } catch (err) {
    console.warn(`[PUSH] ${WEB_PUSH_FLAG} for ${userId} failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
