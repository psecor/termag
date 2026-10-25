import type { AgentStatus } from '../types';

/**
 * One /ws/status push as the browser keeps it (contexts/ProjectContext.tsx).
 * Fields are picked by name, so a field the backend adds to AgentStatus must
 * be added here too, or every surface reading statusMap never sees it.
 */
export function statusFromPush(msg: Record<string, any>): AgentStatus {
  return {
    status: msg.status,
    updatedAt: msg.updatedAt,
    message: msg.message,
    source: msg.source,
    waitingReason: msg.waitingReason,
    activityScore: msg.activityScore,
    tokenBurst: msg.tokenBurst,
    activeTurn: msg.activeTurn,
    threadId: msg.threadId,
    pollerMeta: msg.pollerMeta,
    contextTokens: msg.contextTokens,
    rateLimited: msg.rateLimited,
    stoppedAt: msg.stoppedAt,
    milestone: msg.milestone ?? null,
    // The Devin review pane's state (utils/reviewRing).
    review: msg.review ?? null,
    // A handoff of this pane: HandoffStrip and the phone banner.
    handoff: msg.handoff ?? null,
  };
}
