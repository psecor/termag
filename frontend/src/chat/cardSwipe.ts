// A session card's swipe on a phone (step 11; pages/chat/useCardSwipe.ts), since
// there's no hover: right to pin (or unpin), left to archive (with Undo, as the card's Archive does). A drag is a swipe
// only once it moves sideways more than it moves down; past the threshold on release it acts, else it springs back.

export type SwipeAction = 'pin' | 'archive';

/** How far a drag must go before it's a swipe or a scroll, in CSS pixels. */
export const SWIPE_LOCK_PX = 10;
/** How far, at least, a released swipe must have gone to act. */
export const SWIPE_ACT_PX = 88;

/** Which way a drag is going, once it has gone far enough to say: a swipe sideways, a scroll, or not yet. */
export function swipeLock(dx: number, dy: number): 'swipe' | 'scroll' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_LOCK_PX && ay < SWIPE_LOCK_PX) return null;
  return ax > ay * 1.5 ? 'swipe' : 'scroll';
}

/** The action a swipe that far would take, given what this card offers: right pins, left archives. */
export function swipeAction(dx: number, offers: { pin: boolean; archive: boolean }): SwipeAction | null {
  if (dx > 0 && offers.pin) return 'pin';
  if (dx < 0 && offers.archive) return 'archive';
  return null;
}

/** Where the card is drawn for a drag of `dx`: one-to-one up to the threshold, then with resistance; 0 the way nothing is offered. */
export function swipeOffset(dx: number, offers: { pin: boolean; archive: boolean }): number {
  if (!swipeAction(dx, offers)) return 0;
  const a = Math.abs(dx);
  const shown = a <= SWIPE_ACT_PX ? a : SWIPE_ACT_PX + (a - SWIPE_ACT_PX) * 0.35;
  return Math.sign(dx) * shown;
}

/** Whether a released swipe acts: past the threshold (or a third of the card, on a narrow one), the way something is offered. */
export function swipeActs(dx: number, width: number, offers: { pin: boolean; archive: boolean }): SwipeAction | null {
  const needed = Math.min(SWIPE_ACT_PX, Math.max(48, width / 3));
  return Math.abs(dx) >= needed ? swipeAction(dx, offers) : null;
}
