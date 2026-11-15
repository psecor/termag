// The redesigned sidebar's keys: j and k (and
// the arrow keys) move between the cards, Enter opens one (it's a link), e
// archives it, with the same Undo as its button, and p pins or unpins it. Only
// while keyboard focus is in the list, so typing in a composer never reaches
// them. Pure, so it's tested on its own; pages/chat/useListKeys.ts runs it.

export type ListKeyAction = 'next' | 'prev' | 'archive' | 'pin';

/** What a key does in the list, or null for any other key (and any key with a modifier, or typed into a field). */
export function listKeyAction(e: {
  key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  /** Held down: moving may repeat, archiving and pinning don't (a held e would archive card after card). */
  repeat?: boolean;
  /** Focus is in a text field (an input, a textarea, something editable). */
  typing?: boolean;
}): ListKeyAction | null {
  if (e.typing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  // With Caps Lock on a letter comes as its capital, with no Shift: the same key.
  switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
    case 'j': case 'ArrowDown': return 'next';
    case 'k': case 'ArrowUp': return 'prev';
    case 'e': return e.repeat ? null : 'archive';
    case 'p': return e.repeat ? null : 'pin';
    default: return null;
  }
}

/**
 * Which card focus moves to: the next or previous of `count`, from `at` (-1 when none has focus: j takes the
 * first, k the last). It stops at the ends rather than wrapping, as the mock's does.
 */
export function moveTo(at: number, count: number, action: 'next' | 'prev'): number | null {
  if (count === 0) return null;
  if (at < 0) return action === 'next' ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, at + (action === 'next' ? 1 : -1)));
}

