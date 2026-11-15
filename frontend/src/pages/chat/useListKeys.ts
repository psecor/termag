// The redesigned sidebar's keys (chat/listKeys.ts)
// on its list: j/k and the arrows move keyboard focus between the cards,
// Enter opens the focused one (a card is a link), e archives it and p pins or
// unpins it, through the same actions as its buttons (ProjectsList's
// `actions`, by row key). The listener sits on the list itself, in the capture
// phase, so it hears keys only while focus is in the list, before any control
// in it (a React Aria button, which would stop them) can swallow them; it
// ignores anything typed into a field, with a modifier, or an arrow on a
// control that opens a menu (the arrow opens it). It doesn't stop the event,
// so the list's own handlers (useSteadyOrder's hold) still see it. Focus is
// moved, not a selection drawn: the focused card gets the hover-style fill
// (sessionCard.css), and screen readers follow it as they do Tab. When the
// card focus is on leaves the list (archived, or pinned into a folded
// section), focus goes to the card now in its place, but only if focus was
// lost with it; the watch ends as soon as focus goes anywhere else.
import { useEffect, type RefObject } from 'react';
import { listKeyAction, moveTo } from '../../chat/listKeys';

export interface CardKeyActions { archive?: (() => void) | null; pin?: (() => void) | null }

const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';

/** The cards keyboard focus can be on, in the order they're drawn. */
function cardsIn(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('.sc')].filter(c => c.getClientRects().length > 0 || !c.closest('[hidden]'));
}

/** The card focus is on or in (its own controls float beside it, in its wrap). */
function cardOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('.sc') ?? el?.closest('.sc-wrap')?.querySelector<HTMLElement>('.sc') ?? null;
}

/** The row key a card stands for (its li's data-flip, `row:<key>`), if it's a session's. */
function rowKeyOf(card: HTMLElement): string | null {
  const flip = card.closest<HTMLElement>('[data-flip^="row:"]')?.dataset.flip;
  return flip ? flip.slice(4) : null;
}

function focusCard(card: HTMLElement | undefined) {
  if (!card) return;
  card.focus({ preventScroll: true });
  card.scrollIntoView?.({ block: 'nearest' });
}

/** Focus fell out with the element that had it (it left the page): nothing the person chose has it now. */
const focusLost = () => !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;

/** How long after a key the focused card is watched for leaving: an archive may wait on its confirm, or be slow. */
const REFOCUS_WATCH_MS = 30_000;
/** Focus is in a dialog (Archive's confirm, a menu): it holds focus a while, then gives it back. */
const inDialog = () => document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') != null;

/**
 * Watch `watched` (the row of the card focus is on, its own controls included) as the list redraws and focus moves:
 * once the row has left the list, and focus is lost (it left with the row, or a dialog closed with nothing to give it
 * back to), put focus on the card for `key` (where it moved to), else on the card now at `at` (the one in its place),
 * else the last. While a dialog holds focus it waits. It ends then, as soon as focus is anywhere else (the person
 * moved it), or after a while. Started before the action, so a move made at once is still seen. Returns its stop.
 */
function refocus(root: HTMLElement, watched: HTMLElement, key: string | null, at: number): () => void {
  let timer = 0;
  const check = () => {
    if (!root.isConnected) { stop(); return; }
    const lost = focusLost();
    if (watched.isConnected) {
      if (!lost && !inDialog() && !watched.contains(document.activeElement)) stop();
      return;
    }
    if (inDialog()) return;
    if (!lost) { stop(); return; }
    const moved = key ? root.querySelector<HTMLElement>(`[data-flip="row:${CSS.escape(key)}"] .sc`) : null;
    const cards = cardsIn(root);
    const card = moved ?? cards[Math.min(Math.max(at, 0), cards.length - 1)];
    if (card) focusCard(card);
    stop();
  };
  const watch = new MutationObserver(check);
  // Focus settles after its focusout (a dialog closing gives it back, or doesn't): look then.
  const onFocusOut = () => { window.setTimeout(check, 0); };
  const stop = () => {
    watch.disconnect();
    document.removeEventListener('focusout', onFocusOut, true);
    window.clearTimeout(timer);
  };
  watch.observe(root, { childList: true, subtree: true });
  // And the page's overlays (portalled onto the body): a dialog that closes as it's removed sends no focusout.
  watch.observe(document.body, { childList: true });
  document.addEventListener('focusout', onFocusOut, true);
  timer = window.setTimeout(stop, REFOCUS_WATCH_MS);
  return stop;
}

/** The row a card stands in (its li), with the controls that float beside it; the card itself when it has none. */
const rowOf = (card: HTMLElement): HTMLElement => card.closest<HTMLElement>('[data-flip^="row:"]') ?? card.closest<HTMLElement>('.sc-wrap') ?? card;

export function useListKeys(list: RefObject<HTMLElement | null>, actions: RefObject<Map<string, CardKeyActions>>, on: boolean): void {
  useEffect(() => {
    const root = list.current;
    if (!on || !root) return undefined;
    // The focus watches still running (refocus), stopped with the list.
    const watches = new Set<() => void>();
    const watchFocus = (watched: HTMLElement, key: string | null, at: number) => {
      const stop = refocus(root, watched, key, at);
      watches.add(stop);
      window.setTimeout(() => watches.delete(stop), REFOCUS_WATCH_MS + 1000);
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // A menu or dialog that a head or card opened is portalled out of the list.
      if (!root.contains(target)) return;
      const arrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
      if (arrow && target.closest('[aria-haspopup]')) return;
      const action = listKeyAction({
        key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, typing: target.closest(TYPING) !== null,
      });
      if (!action) return;
      const cards = cardsIn(root);
      const current = cardOf(target);
      const at = current ? cards.indexOf(current) : -1;
      if (action === 'next' || action === 'prev') {
        let to: number | null;
        if (at >= 0) to = moveTo(at, cards.length, action);
        else {
          // From a head (or another control between cards), the first card after it, or the last before it; none
          // past either end.
          const i = action === 'next'
            ? cards.findIndex(c => target.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
            : cards.map(c => Boolean(target.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING)).lastIndexOf(true);
          to = i >= 0 ? i : null;
        }
        if (to === null) return;
        e.preventDefault();
        focusCard(cards[to]);
        return;
      }
      if (!current) return;
      const key = rowKeyOf(current);
      const card = key ? actions.current?.get(key) : undefined;
      if (action === 'pin') {
        if (!card?.pin) return;
        e.preventDefault();
        // Pinning moves the card to Pinned (or back), maybe at once: focus follows it, or takes its place if it went
        // somewhere folded. Watched from before the pin, so a move made at once is seen.
        watchFocus(rowOf(current), key, at);
        card.pin();
        return;
      }
      if (!card?.archive) return;
      e.preventDefault();
      // Focus stays on the card until it has left the list (it may ask first, and be cancelled); then it goes to the
      // card now in its place, the next one, past any that left with it.
      watchFocus(rowOf(current), null, at);
      card.archive();
    };
    root.addEventListener('keydown', onKey, true);
    return () => {
      root.removeEventListener('keydown', onKey, true);
      for (const stop of watches) stop();
      watches.clear();
    };
  }, [list, actions, on]);
}
