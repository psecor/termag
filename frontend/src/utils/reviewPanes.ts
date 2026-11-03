// A workstream's review panes in the web UI: the
// list the docks render, merged from the sweep's `reviews` on the agent
// session's status and the optimistic entries that bridge a start or a stop
// until the push lands; and the Review dialog's line saying what a start will
// do. Pure, so App.tsx and ReviewButton stay thin and this is unit-tested.

import type { SessionReview } from '../types';
import { MAX_REVIEW_SLOTS, reviewSessionName } from './sessionName';

/** One pane as a dock shows it: always with its session and slot. */
export type ReviewPane = SessionReview & { session: string; slot: number };

/** An optimistic entry for one pane: just started (its review), or just stopped. */
export type PaneOverlay = { review: ReviewPane } | 'cleared';

/**
 * The panes of one workstream, slot order. `reviews` from the status, else
 * the one `review` of an older backend as slot 1; then the overlay: a started
 * pane shows (replacing its slot's entry), a stopped one hides.
 */
export function reviewPanes(
  status: { review?: SessionReview | null; reviews?: SessionReview[] | null } | null | undefined,
  names: { owner: string; project: string; workstream: string },
  overlay: Record<string, PaneOverlay> = {},
): ReviewPane[] {
  const fromStatus = status?.reviews ?? (status?.review ? [status.review] : []);
  const bySession = new Map<string, ReviewPane>();
  for (const r of fromStatus) {
    const slot = r.slot ?? 1;
    const session = r.session ?? reviewSessionName(names.owner, names.project, names.workstream, slot);
    bySession.set(session, { ...r, session, slot });
  }
  for (const [session, o] of Object.entries(overlay)) {
    if (o === 'cleared') bySession.delete(session);
    else bySession.set(session, o.review);
  }
  return [...bySession.values()].sort((a, b) => a.slot - b.slot);
}

/** Whether the pushed truth now covers an optimistic entry, so it can go. */
export function overlayCovered(o: PaneOverlay, session: string, truth: ReviewPane[]): boolean {
  const there = truth.some(p => p.session === session);
  return o === 'cleared' ? !there : there;
}

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

/** A pane's PR as its bar names it: `termag#646` from its link, else `PR #646`. */
export function panePrLabel(pr: number | null, url: string | null): string | null {
  if (pr == null) return null;
  const m = url ? PR_URL.exec(url) : null;
  return m ? `${m[2]}#${pr}` : `PR #${pr}`;
}

function sameRepo(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ra = PR_URL.exec(a);
  const rb = PR_URL.exec(b);
  return !!ra && !!rb && `${ra[1]}/${ra[2]}`.toLowerCase() === `${rb[1]}/${rb[2]}`.toLowerCase();
}

/**
 * What starting a review of `pr` does to the panes, as the backend decides it
 * (routes/review.ts, chooseReviewSlot): the flag off takes slot 1, replacing what runs there;
 * on, the PR's own pane restarts, else a pane is added, unless all are in use.
 */
export function reviewStartPlan(panes: ReviewPane[], want: { pr: number | null; url: string | null }, parallel: boolean):
  | { kind: 'new' }
  | { kind: 'replace'; pane: ReviewPane }
  | { kind: 'restart'; pane: ReviewPane; others: number }
  | { kind: 'add'; inUse: number }
  | { kind: 'full' } {
  if (panes.length === 0) return { kind: 'new' };
  if (!parallel) {
    // Off, the backend starts in slot 1: it replaces only what runs there (Devin, #786).
    const first = panes.find(p => p.slot === 1);
    return first ? { kind: 'replace', pane: first } : { kind: 'new' };
  }
  const same = want.pr == null ? undefined : panes.find(p => p.pr === want.pr && sameRepo(p.url, want.url));
  if (same) return { kind: 'restart', pane: same, others: panes.length - 1 };
  if (panes.length >= MAX_REVIEW_SLOTS) return { kind: 'full' };
  return { kind: 'add', inUse: panes.length };
}

/** The dialog's line for a plan; empty for the first review. */
export function reviewStartNote(plan: ReturnType<typeof reviewStartPlan>): string {
  switch (plan.kind) {
    case 'new': return '';
    case 'replace': return plan.pane.slot === 1 && plan.pane.pr != null
      ? `The running review (${panePrLabel(plan.pane.pr, plan.pane.url)}) is replaced.`
      : 'The running review is replaced.';
    case 'restart': return `Restarts the review of ${panePrLabel(plan.pane.pr, plan.pane.url)}${plan.others ? `; the other ${plan.others} keep${plan.others === 1 ? 's' : ''} running` : ''}.`;
    case 'add': return `Adds a review pane beside the ${plan.inUse} running (${plan.inUse + 1} of ${MAX_REVIEW_SLOTS}).`;
    case 'full': return `All ${MAX_REVIEW_SLOTS} review panes are in use: close one to start another.`;
  }
}
