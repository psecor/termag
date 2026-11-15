// A session card's swipe on a phone (step 11), since there's no hover: right pins or
// unpins it, left archives it with the card's own Archive (its Undo, and asking first only when a box would stop).
// Touch only; a mouse or a pen gets the hover controls. The card follows the finger once the drag goes sideways
// (chat/cardSwipe.ts), with what it will do showing under it, and springs back unless released past the threshold.
// The browser keeps vertical scrolling (touch-action: pan-y), and a drag that starts as a scroll stays one. Composed
// with the long press (ContextMenu.tsx useLongPress), whose own slop cancels it as soon as the finger moves.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { swipeActs, swipeAction, swipeLock, swipeOffset, type SwipeAction } from '../../chat/cardSwipe';
import { LONG_PRESS_MS, type PressHandlers } from './ContextMenu';

interface Drag { id: number; x: number; y: number; at: number; lock: 'swipe' | 'scroll' | null; el: HTMLElement; dx: number }
export interface SwipeOffers {
  /** Pin or unpin, if the card can be pinned; `pinned` names which. */
  pin?: (() => void) | null;
  pinned?: boolean;
  archive?: (() => void) | null;
}

const LABEL: Record<SwipeAction, (pinned: boolean) => string> = { pin: p => (p ? 'Unpin' : 'Pin'), archive: () => 'Archive' };

/**
 * How long after a swipe's release a click on its card is still the release's. A browser that clicks after a drag
 * does it at once; a phone usually doesn't at all, so a longer window would eat the next real tap on the card.
 */
const RELEASE_CLICK_MS = 80;

function swallowReleaseClick(el: HTMLElement): void {
  const swallow = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); done(); };
  const done = () => { el.removeEventListener('click', swallow, true); window.clearTimeout(timer); };
  const timer = window.setTimeout(done, RELEASE_CLICK_MS);
  el.addEventListener('click', swallow, true);
}

function reset(el: HTMLElement, animate: boolean): void {
  const card = el.firstElementChild as HTMLElement | null;
  if (card) {
    card.style.transition = animate ? 'transform 160ms ease-out' : '';
    card.style.transform = '';
  }
  delete el.dataset.swipe;
  delete el.dataset.swipeLabel;
}

export function useCardSwipe(enabled: boolean): (offers: SwipeOffers) => Partial<PressHandlers> {
  const drag = useRef<Drag | null>(null);
  const clear = useCallback(() => { if (drag.current) reset(drag.current.el, false); drag.current = null; }, []);
  useEffect(() => clear, [clear]);
  return useMemo(() => (offers: SwipeOffers): Partial<PressHandlers> => {
    if (!enabled) return {};
    const can = { pin: Boolean(offers.pin), archive: Boolean(offers.archive) };
    if (!can.pin && !can.archive) return {};
    return {
      onPointerDown: e => {
        if (e.pointerType !== 'touch') return;
        const prev = drag.current;
        // A second finger while one swipes is ignored; a drag left behind (its card gone, or its pointer lost) is undone.
        if (prev && prev.lock === 'swipe' && prev.el.isConnected && prev.id !== e.pointerId) return;
        if (prev) reset(prev.el, false);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, lock: null, el: e.currentTarget as HTMLElement, dx: 0 };
      },
      onPointerMove: e => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        if (!d.lock) {
          // Held still until the long press fired: that's the menu's finger now, and a slide after it isn't a swipe.
          if (e.timeStamp - d.at >= LONG_PRESS_MS) { drag.current = null; return; }
          d.lock = swipeLock(dx, e.clientY - d.y);
          if (d.lock === 'scroll') { drag.current = null; return; }
          if (d.lock === 'swipe') { try { d.el.setPointerCapture(e.pointerId); } catch { /* gone already */ } }
        }
        if (d.lock !== 'swipe') return;
        d.dx = dx;
        const card = d.el.firstElementChild as HTMLElement | null;
        if (card) { card.style.transition = ''; card.style.transform = `translateX(${swipeOffset(dx, can)}px)`; }
        const action = swipeAction(dx, can);
        if (action) { d.el.dataset.swipe = action; d.el.dataset.swipeLabel = LABEL[action](offers.pinned === true); }
        else { delete d.el.dataset.swipe; delete d.el.dataset.swipeLabel; }
      },
      onPointerUp: e => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        drag.current = null;
        if (d.lock !== 'swipe') return;
        // The release isn't a tap on the card's link.
        swallowReleaseClick(d.el);
        const act = swipeActs(d.dx, d.el.getBoundingClientRect().width, can);
        reset(d.el, true);
        if (act === 'pin') offers.pin?.();
        else if (act === 'archive') offers.archive?.();
      },
      onPointerCancel: e => { if (!drag.current || drag.current.id === e.pointerId) clear(); },
    };
  }, [enabled, clear]);
}

/** Both sets of pointer handlers on one element: each of `a`'s, then `b`'s. */
export function bothPress(a: Partial<PressHandlers>, b: Partial<PressHandlers>): Partial<PressHandlers> {
  const keys = ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel'] as const;
  const out: Partial<PressHandlers> = {};
  for (const k of keys) {
    const f = a[k];
    const g = b[k];
    if (f && g) out[k] = ((e: React.PointerEvent<HTMLElement>) => { f(e); g(e); }) as never;
    else if (f || g) out[k] = (f ?? g) as never;
  }
  return out;
}
