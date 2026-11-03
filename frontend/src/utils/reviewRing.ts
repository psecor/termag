// The review ring: which ring, if any, a sidebar
// project tile or workstream row shows for its Devin review. Pure, so the
// aggregation and the seen rule are unit-tested and the tile, the row and
// future surfaces call the same code.
//
// Rules (user decisions, 2026-10-08):
//   - blue pulse while Devin reviews; amber pulse when it needs an answer
//     (amber wins at the tile);
//   - solid blue when the review is ready, cleared the moment the user clicks
//     into the Devin pane (the review terminal takes focus → seenAt);
//   - a later done (a follow-up turn) rings again, because seenAt is then
//     older than doneAt;
//   - blue throughout; amber only for waiting.

import type { SessionReview } from '../types';
import { reviewerDisplayName } from './review';

export type RingState = 'reviewing' | 'waiting' | 'done';

/** The ring for one workstream: null = no ring at all. */
export function ringStateFor(review: SessionReview | null | undefined): RingState | null {
  if (!review) return null;
  if (review.state === 'waiting') return 'waiting';
  if (review.state === 'reviewing') return 'reviewing';
  if (review.state !== 'done') return null; // the reviewer exited — nothing to look at yet
  const done = review.doneAt ? Date.parse(review.doneAt) : NaN;
  const seen = review.seenAt ? Date.parse(review.seenAt) : null;
  // No doneAt stamp (defensive: the backend stamps transitions into done):
  // treat the record's arrival as the done moment so the ring still shows.
  if (!Number.isFinite(done)) return 'done';
  // The ring's job ends when you look: gone as soon as the review terminal
  // was focused after the done it answered.
  return seen != null && seen >= done ? null : 'done';
}

/**
 * A workstream's review panes from its agent session's status:
 * `reviews`, else the one `review` an older
 * backend sends.
 */
export function reviewsOf(status: { review?: SessionReview | null; reviews?: SessionReview[] | null } | null | undefined): SessionReview[] {
  if (status?.reviews) return status.reviews;
  return status?.review ? [status.review] : [];
}

/**
 * One ring for a workstream's panes: the most urgent (waiting > reviewing >
 * done), the PR and reviewer of the first pane in that state, and how many
 * panes share it.
 */
export function ringForReviews(reviews: SessionReview[]): { ring: RingState | null; pr: number | null; reviewer: string | null; count: number } {
  const rings = reviews.map(ringStateFor);
  const ring = aggregateReviewRing(rings);
  if (!ring) return { ring: null, pr: null, reviewer: null, count: 0 };
  const top = reviews[rings.indexOf(ring)];
  return { ring, pr: top?.pr ?? null, reviewer: top?.reviewer ?? null, count: rings.filter(r => r === ring).length };
}

/** Tile aggregation: waiting > reviewing > done > none. */
export function aggregateReviewRing(rings: Array<RingState | null | undefined>): RingState | null {
  if (rings.includes('waiting')) return 'waiting'; // wins over everything at the tile
  if (rings.includes('reviewing')) return 'reviewing';
  return rings.some(r => r === 'done') ? 'done' : null;
}

/**
 * The tooltip for one ring. Without a recovered PR the wording carries on
 * without the number. `count` > 1: that many review panes share the ring.
 */
export function reviewRingTooltip(ring: RingState, pr: number | null | undefined, reviewer?: string | null, count: number = 1): string {
  if (count > 1) {
    switch (ring) {
      case 'waiting': return `${count} reviews need an answer`;
      case 'reviewing': return `${count} reviews running`;
      case 'done': return `${count} reviews ready`;
    }
  }
  const name = reviewerDisplayName(reviewer);
  switch (ring) {
    case 'waiting': return `${name} needs an answer in the review pane`;
    case 'reviewing': return pr != null ? `${name} reviewing PR #${pr}` : `${name} reviewing…`;
    case 'done': return pr != null ? `Review of PR #${pr} ready` : 'Review ready';
  }
}
