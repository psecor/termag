// Session milestones: "the agent just did something that makes this a natural
// point to shrink its context" — today, opening or merging a PR. The Claude
// Code PostToolUse hook (deploy/termag-status post-tool) classifies the tool
// call on the box and POSTs only {kind, url}; this module validates that body
// and owns the lifecycle rules. Pure, so it is unit-tested without a server.

export const MILESTONE_KINDS = ['pr_created', 'pr_merged'] as const;
export type MilestoneKind = typeof MILESTONE_KINDS[number];

export interface SessionMilestone {
  kind: MilestoneKind;
  /** The PR URL when the tool output carried one; null otherwise. */
  url: string | null;
  at: Date;
  /**
   * The context reading when the milestone was recorded, refreshed by later
   * non-null readings while it is pending. This is what the prompt gates and
   * displays on: the live reading goes null on its own once the transcript
   * is 10 minutes stale (agent/agent.js CONTEXT_FRESH_MS), which says nothing
   * about whether the context was reset.
   */
  contextTokens: number | null;
}

/** A milestone nobody acted on for this long is stale and is dropped. */
export const MILESTONE_TTL_MS = 30 * 60 * 1000;

/**
 * A fresh reading this far below the recorded one means the conversation was
 * compacted or cleared (both leave the next turn's context a fraction of what
 * it was). A reading that merely drifts does not resolve the prompt.
 */
export const MILESTONE_RESOLVED_RATIO = 0.5;

const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export function parseMilestoneBody(body: unknown): { session: string; kind: MilestoneKind; url: string | null } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be an object' };
  const { session, kind, url } = body as { session?: unknown; kind?: unknown; url?: unknown };
  if (typeof session !== 'string' || !session) return { error: 'session required' };
  if (typeof kind !== 'string' || !(MILESTONE_KINDS as readonly string[]).includes(kind)) {
    return { error: `kind must be one of ${MILESTONE_KINDS.join(', ')}` };
  }
  let cleanUrl: string | null = null;
  if (url !== undefined && url !== null) {
    if (typeof url !== 'string') return { error: 'url must be a string' };
    // Only a GitHub PR URL is accepted: this value is rendered as a link in the
    // UI, so it must not be an arbitrary string from a box.
    cleanUrl = GITHUB_PR_URL.test(url) ? url : null;
  }
  return { session, kind: kind as MilestoneKind, url: cleanUrl };
}

export function isMilestoneExpired(m: Pick<SessionMilestone, 'at'>, now: number): boolean {
  return now - m.at.getTime() >= MILESTONE_TTL_MS;
}

/**
 * What a new context reading means for a pending milestone:
 *   'resolve' — the context was reset (compact/clear happened); drop the prompt
 *   'update'  — still big; remember this reading as the current size
 *   'ignore'  — null (stale transcript) or no basis for comparison
 */
export function milestoneOnReading(
  m: Pick<SessionMilestone, 'contextTokens'>,
  reading: number | null | undefined,
): 'resolve' | 'update' | 'ignore' {
  if (reading == null) return 'ignore';
  if (m.contextTokens != null && reading < m.contextTokens * MILESTONE_RESOLVED_RATIO) return 'resolve';
  return 'update';
}

/** Strip the PR link for recipients who are not the session's owner. */
export function milestoneForSharedViewer<T extends { url: string | null }>(m: T | null | undefined): T | null | undefined {
  return m ? { ...m, url: null } : m;
}
