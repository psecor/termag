// The redesigned sidebar's scroll edges: which
// section head is stuck at the top of the list, and whether there's more to
// scroll above or below, for the fades (sessionCard.css). The list reads them
// as attributes: `data-stuck` on the stuck head, `data-more-above` and
// `data-more-below` on the list. One passive scroll listener, at most one read
// a frame, and attributes that change only when the answer does, so a scroll
// costs nothing else: the fades and the heads are plain CSS.
// While rows are animating to a new order (useSteadyOrder.ts) the list carries
// `data-moving`, and nothing is read: their transforms would put heads out of
// order. The mover reads once before the moves start and once they end.
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

export interface HeadEdge {
  /** The head's top, in the viewport's pixels. */
  top: number;
  /** Its section's bottom: past the list's top edge, the head is pushed out and no longer stuck. */
  sectionBottom: number;
}

/**
 * The stuck head: the last one whose top has reached the list's top edge while
 * its section still reaches below it. A head being pushed out by the next is
 * still the stuck one until its section has gone. None while the list is at
 * its top (nothing is under a head there). -1 for none.
 */
export function stuckHead(heads: readonly HeadEdge[], edge: number, scrolled: boolean): number {
  if (!scrolled) return -1;
  let stuck = -1;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.top > edge + 0.5) break;
    if (h.sectionBottom > edge + 0.5) stuck = i;
  }
  return stuck;
}

/** Whether there's more to scroll above and below, a half pixel of rounding aside. */
export function moreToScroll(scrollTop: number, clientHeight: number, scrollHeight: number): { above: boolean; below: boolean } {
  return { above: scrollTop > 0.5, below: scrollTop + clientHeight < scrollHeight - 0.5 };
}

const HEADS = ':scope > .chat-group > .pj-head';

/** Reads the edges now, outside the frame loop: for a mover, around its moves. */
export interface ListEdges { readNow(): void }

export function useListEdges(ref: RefObject<HTMLElement | null>, on: boolean): ListEdges {
  const update = useRef<(() => void) | null>(null);
  const now = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return undefined;
    let frame = 0;
    let stuckEl: Element | null = null;
    const read = () => {
      frame = 0;
      if (el.hasAttribute('data-moving')) return;
      const more = moreToScroll(el.scrollTop, el.clientHeight, el.scrollHeight);
      el.toggleAttribute('data-more-above', more.above);
      el.toggleAttribute('data-more-below', more.below);
      const edge = el.getBoundingClientRect().top;
      const heads = [...el.querySelectorAll<HTMLElement>(HEADS)];
      const i = stuckHead(heads.map(h => ({ top: h.getBoundingClientRect().top, sectionBottom: h.parentElement!.getBoundingClientRect().bottom })), edge, more.above);
      const next = i >= 0 ? heads[i] : null;
      if (next !== stuckEl) {
        stuckEl?.removeAttribute('data-stuck');
        next?.setAttribute('data-stuck', '');
        stuckEl = next;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    update.current = schedule;
    now.current = () => { if (frame) cancelAnimationFrame(frame); read(); };
    read();
    el.addEventListener('scroll', schedule, { passive: true });
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    sized?.observe(el);
    return () => {
      el.removeEventListener('scroll', schedule);
      sized?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      stuckEl?.removeAttribute('data-stuck');
      el.removeAttribute('data-more-above');
      el.removeAttribute('data-more-below');
      update.current = null;
      now.current = null;
    };
  }, [ref, on]);
  // The list's content changes with each render (a session moves, a section opens): look again.
  useLayoutEffect(() => { update.current?.(); });
  return useMemo(() => ({ readNow: () => now.current?.() }), []);
}
