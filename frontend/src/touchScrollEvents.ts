// ui.touch.scrolled (docs/agents/observability.md, "Product events"): a touch
// moved a scroll container, once per kind of container per page load, so a
// query can say whether touch scrolling works on a phone (the iOS chat that
// wouldn't scroll, termag#1482) without watching replays. A `scroll` event
// fires only when a container's position changed, so a touch that the page
// swallowed records nothing. Metadata only: which kind of container and which
// view, never what was in it.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { recordProductEvent } from './observability';
import { clientView } from './usageEvents';
import { tookFollowBottomScroll } from './chat/useFollowBottom';

/** Which kind of container scrolled: the chat transcript, the phone client's list, a terminal, or anything else. */
export type TouchScroller = 'chat' | 'mobile' | 'terminal' | 'other';

// Momentum keeps a container moving after the finger lifts; those scrolls
// still came from the touch.
export const TOUCH_MOMENTUM_MS = 1500;

/** The kind of a scrolled element, from its own classes and its ancestors'. Pure but for the DOM it reads. */
export function touchScroller(target: EventTarget | null): TouchScroller {
  const el = target instanceof Element ? target : null;
  if (!el) return 'other';
  if (el.closest('.xterm')) return 'terminal';
  if (el.closest('.chat-transcript')) return 'chat';
  if (el.closest('.m-scroll')) return 'mobile';
  return 'other';
}

/** The event's attributes. `termag.view` is client.opened's (mobile, simple, full or other). Pure. */
export function touchScrolledAttributes(scroller: TouchScroller, pathname: string): Record<string, string> {
  return { 'termag.scroller': scroller, 'termag.view': clientView(pathname) };
}

const recorded = new Set<TouchScroller>();

/**
 * Whether a touch that began on `origin` is what moved `scrolled`: the
 * scrolled element holds the origin, or both sit in the same xterm root
 * (whose viewport scrolls beside the screen that takes the touch). Pure but
 * for the DOM it reads.
 */
export function touchMoved(scrolled: Node, origin: Node): boolean {
  if (scrolled.contains(origin)) return true;
  const term = scrolled instanceof Element ? scrolled.closest('.xterm') : null;
  return !!term && term.contains(origin);
}

/** Whether a scroll moved `scrolled` px the way a finger that moved `finger` px pushes it: the opposite way. Pure. */
export function withFinger(scrolled: number, finger: number): boolean {
  return scrolled !== 0 && finger !== 0 && Math.sign(scrolled) === -Math.sign(finger);
}

/** Test hook: forget what this page load recorded. */
export function resetTouchScrollForTests(): void {
  recorded.clear();
}

/**
 * Listens on the document, in the capture phase (`scroll` does not bubble),
 * for scrolls during a touch or its momentum, and records each kind of
 * container once. A scroll counts only when the finger moved (a touchmove,
 * not a tap), the scrolled element holds where the touch began, and the
 * position moved the way the finger pushed it (a finger moving up scrolls
 * down). So code that sets scrollTop mid-touch, like a terminal following its
 * output, records nothing unless it happens to move the way the finger did;
 * the chat's follow-bottom, which does, is skipped outright
 * (tookFollowBottomScroll). A terminal is the exception to containment:
 * xterm's scrolling `.xterm-viewport` is a sibling of the `.xterm-screen` the
 * finger is on, so there the touch need only have begun in the same `.xterm`
 * root (see touchMoved). Passive listeners only: this never changes how a
 * page scrolls. Returns the cleanup.
 */
export function watchTouchScroll(doc: Document, path: () => string, now: () => number = Date.now): () => void {
  let touching = 0;
  let liftedAt = -Infinity;
  let origin: Node | null = null;
  let panned = false;
  // Where the finger went down and where it is (or lifted), in client pixels.
  let startX = 0, startY = 0, fingerX = 0, fingerY = 0;
  // Each container's position as of its last scroll event or the touch that
  // could move it, whichever came later.
  const last = new WeakMap<Element, { top: number; left: number }>();
  const mark = (el: Element) => { last.set(el, { top: el.scrollTop, left: el.scrollLeft }); };
  // A touch can scroll the element it lands on, any ancestor, or (on a
  // terminal) the sibling xterm viewport; take their positions as it lands, so
  // a first scroll compares against where the container was, not against 0.
  const markTouched = (node: Node | null) => {
    const start = node instanceof Element ? node : node?.parentElement ?? null;
    for (let el = start; el; el = el.parentElement) mark(el);
    start?.closest('.xterm')?.querySelectorAll('.xterm-viewport').forEach(mark);
    if (doc.scrollingElement) mark(doc.scrollingElement);
  };
  const onStart = (e: TouchEvent) => {
    if (!touching) {
      origin = e.target instanceof Node ? e.target : null;
      panned = false;
      const t = e.touches[0];
      startX = fingerX = t?.clientX ?? 0;
      startY = fingerY = t?.clientY ?? 0;
      markTouched(origin);
    }
    touching = e.touches.length;
  };
  const onMove = (e: TouchEvent) => {
    if (!touching) return;
    panned = true;
    const t = e.touches[0];
    if (t) { fingerX = t.clientX; fingerY = t.clientY; }
  };
  const onEnd = (e: TouchEvent) => { touching = e.touches.length; if (!touching) liftedAt = now(); };
  const onScroll = (e: Event) => {
    const el = e.target === doc ? doc.scrollingElement : e.target;
    if (!(el instanceof Element)) return;
    const was = last.get(el) ?? { top: 0, left: 0 };
    mark(el);
    if (tookFollowBottomScroll(el)) return;
    if (!touching && now() - liftedAt > TOUCH_MOMENTUM_MS) return;
    if (!panned || !origin || !touchMoved(el, origin)) return;
    if (!withFinger(el.scrollTop - was.top, fingerY - startY) && !withFinger(el.scrollLeft - was.left, fingerX - startX)) return;
    const scroller = touchScroller(el);
    if (recorded.has(scroller)) return;
    recorded.add(scroller);
    recordProductEvent('ui.touch.scrolled', touchScrolledAttributes(scroller, path()));
  };
  const passive = { capture: true, passive: true } as const;
  doc.addEventListener('touchstart', onStart, passive);
  doc.addEventListener('touchmove', onMove, passive);
  doc.addEventListener('touchend', onEnd, passive);
  doc.addEventListener('touchcancel', onEnd, passive);
  doc.addEventListener('scroll', onScroll, passive);
  return () => {
    doc.removeEventListener('touchstart', onStart, passive);
    doc.removeEventListener('touchmove', onMove, passive);
    doc.removeEventListener('touchend', onEnd, passive);
    doc.removeEventListener('touchcancel', onEnd, passive);
    doc.removeEventListener('scroll', onScroll, passive);
  };
}

/** Rendered beside RecordClientOpened, inside the flag provider; the view is the path shown when the scroll happens. */
export function RecordTouchScrolled(): null {
  const { pathname } = useLocation();
  const path = useRef(pathname);
  useEffect(() => { path.current = pathname; }, [pathname]);
  useEffect(() => watchTouchScroll(document, () => path.current), []);
  return null;
}
