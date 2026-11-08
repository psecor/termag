/**
 * Terminal slots: the user's own shell panes beside
 * the ctrl pane, added with the workspace's + button and closed with its ✕.
 * Slot 1 is the ctrl pane itself — the one terminal every project already
 * has — so the slots this module manages are 2..MAX_TERMINAL_SLOTS.
 *
 * The shape is the review slots': fixed session
 * names threaded through every list of legal names, the resolver, renames and
 * teardown, created on demand with RPCs every deployed agent already has
 * (`tmux-has-session` / `tmux-create`), and killed with exact targets. A slot
 * holds no metadata — it is a plain shell — so there is no record to keep and
 * tmux is the only source of truth for "is this tab open".
 *
 * The pure parts live here so the route (routes/terminalSlots.ts) stays a thin
 * wrapper and the tests need no tmux, agent or database.
 */
import { MAX_TERMINAL_SLOTS } from './tmux';

/** The slots the + button may fill: everything but slot 1, the ctrl pane. */
export const FIRST_EXTRA_TERMINAL_SLOT = 2;

/**
 * Pure: the lowest free slot, or none. A slot is free when its session is not
 * alive; a dead-but-recently-killed slot is free at once (a terminal holds
 * nothing worth recovering, unlike a review).
 */
export function chooseTerminalSlot(live: Set<string>, names: string[]): { slot: number } | { full: true } {
  for (let slot = FIRST_EXTRA_TERMINAL_SLOT; slot <= MAX_TERMINAL_SLOTS; slot++) {
    if (!live.has(names[slot - 1])) return { slot };
  }
  return { full: true };
}

/** Pure: the tab's label — the slot number past the ctrl pane. */
export function terminalTabLabel(slot: number): string {
  return slot === 1 ? 'ctrl' : `term ${slot}`;
}
