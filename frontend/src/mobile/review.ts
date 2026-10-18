// Pure helpers for the phone's Review tab: the Devin
// PR review that the desktop's Review button starts in the `review` tmux
// session (backend/src/routes/review.ts). Kept free of React so the mapping
// from Devin's pane state to the capture cadence, and the tab caption, are
// unit-tested.
import type { AgentStatusValue } from '../types';
import type { ReviewDockState, ReviewStatus } from '../utils/review';

/** The three panes a conversation can show. `review` exists only while a review runs. */
export type PaneRole = 'agent' | 'ctrl' | 'review';

export function roleFromParam(v: string | null | undefined): PaneRole {
  return v === 'ctrl' || v === 'review' ? v : 'agent';
}

/**
 * Devin is a poller provider with no live status, so the review pane's
 * state (read off its chrome by the backend) stands in for the capture
 * cadence: fast while Devin thinks, medium while it waits for an answer,
 * slow once the review is there to read. Unknown (agent unreachable) is
 * treated as busy so a pane in progress is not polled lazily.
 */
export function reviewPollStatus(s: Pick<ReviewStatus, 'alive' | 'state'> | null | undefined): AgentStatusValue {
  if (!s || !s.alive) return 'not_running';
  switch (s.state) {
    case 'waiting': return 'waiting';
    case 'done':
    case 'exited': return 'idle';
    default: return 'working';
  }
}

/** The review tab's caption: "review · #123", or just "review" without a number. */
export function reviewTabLabel(s: Pick<ReviewStatus, 'alive' | 'pr'> | null | undefined): string {
  if (!s?.alive || s.pr == null) return 'review';
  return `review · #${s.pr}`;
}

/** The review tab's right-hand key: Close once the review is there to read (or Devin is gone), Stop while it still works. */
export function reviewKeyLabel(dock: ReviewDockState): 'Stop' | 'Close' {
  return dock === 'done' || dock === 'exited' ? 'Close' : 'Stop';
}

/** Copy for the confirm sheet behind that key; both outcomes kill the pane. */
export function reviewStopCopy(dock: ReviewDockState): { verb: 'Stop' | 'Close'; confirmLabel: string } {
  const verb = reviewKeyLabel(dock);
  return { verb, confirmLabel: verb === 'Close' ? 'Close pane' : 'Stop review' };
}

/** The Review sheet's submit button. */
export function reviewSubmitLabel(o: { pr: number | null; currentPr?: number | null; hasReview: boolean; starting: boolean }): string {
  if (o.starting) return 'Starting…';
  if (o.pr == null) return 'Review';
  return o.hasReview && o.pr === o.currentPr ? `Review PR #${o.pr} again` : `Review PR #${o.pr}`;
}
