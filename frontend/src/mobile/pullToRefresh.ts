// Pull to refresh for the phone client's lists. An
// installed app has no reload button, and `.m-scroll` turns the browser's own
// pull off (`overscroll-behavior: contain`), so the lists draw their own.
// Pure gesture math here; PullScroll.tsx wires it to touch events.

/** How far (px, after resistance) the list must be pulled to refresh on release. */
export const PULL_TRIGGER_PX = 64;
/** The indicator never travels further than this. */
export const PULL_MAX_PX = 96;

/** Finger travel → indicator travel: 1:2 resistance, capped. Upward travel is 0. */
export function pullDistance(dy: number): number {
  if (!(dy > 0)) return 0;
  return Math.min(PULL_MAX_PX, dy / 2);
}

export interface PullState {
  /** Finger Y where the pull started, or null when not pulling. */
  startY: number | null;
  distance: number;
}

export const PULL_IDLE: PullState = { startY: null, distance: 0 };

/** A touch began: it can become a pull only while the list is scrolled to the top. */
export function pullStart(scrollTop: number, y: number): PullState {
  return scrollTop <= 0 ? { startY: y, distance: 0 } : PULL_IDLE;
}

/** The finger moved. A pull that turns upward ends without refreshing. */
export function pullMove(s: PullState, y: number): PullState {
  if (s.startY == null) return s;
  if (y < s.startY) return PULL_IDLE;
  return { startY: s.startY, distance: pullDistance(y - s.startY) };
}

/** The finger lifted: refresh when pulled past the trigger. */
export function pullEnd(s: PullState): { refresh: boolean; next: PullState } {
  return { refresh: s.startY != null && s.distance >= PULL_TRIGGER_PX, next: PULL_IDLE };
}
