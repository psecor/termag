// The redesigned sidebar's order under Sort: Recent activity
// (chat/sidebarSort.ts), held still while the list is in use. A working
// session's activity keeps changing, and a row that moves as you reach for it
// is a misclick, so while the pointer is over the list, a menu or dialog from
// it is open (`busy`), or keyboard focus is in it, the order shown stays: a new
// session slots in beside its neighbour (holdOrder) and nothing else moves.
// Once that ends the new order applies, each move animated briefly from where
// the row was (none under reduced motion). A head stuck at the top never moves
// with them, so nothing peeks above it, and the list's edges (useListEdges.ts)
// are read before the moves start and once they end, never mid-move. The open
// session (`anchor`) stays in view: if a move would take it out of the list's
// view, the list scrolls by the move instead. The browser's scroll anchoring
// is off while a new order applies: it would follow whichever row it had
// anchored to wherever that row moved, scrolling the list (to the top, when
// that row moved up), so a stuck head would jump.
// Under Created the order is the one given, at once; it's still tracked, so a
// switch to Recent activity animates from it.
import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { holdListOrder, sameListOrder, type ListOrder } from '../../chat/sidebarSort';
import type { ListEdges } from './useListEdges';

/** How long a move takes, in ms. */
export const MOVE_MS = 180;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** What moves: a card's `li` (`row:<key>`) and a group's head (`head:<key>`). */
const MOVER = '[data-flip]';

export interface SteadyOrderOptions {
  /** The redesign's list; off, the order is `live` and nothing is tracked. */
  on: boolean;
  /** Recent activity: hold the order while the list is in use, and animate its moves. */
  steady: boolean;
  /** A menu or dialog from the list is open. */
  busy: boolean;
  /** The open session's mover key (`row:<key>`), kept in view across a move. */
  anchor: string | null;
  edges: ListEdges;
}

export interface ListProps {
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: () => void;
}

interface Moving { gen: number; anims: Animation[] }

const focusVisible = (t: EventTarget): boolean => {
  try { return t instanceof Element && t.matches(':focus-visible'); } catch { return false; }
};

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where each mover is now, by key, in the viewport's pixels. */
function measure(el: HTMLElement): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of el.querySelectorAll<HTMLElement>(MOVER)) {
    const k = n.dataset.flip;
    if (k && !out.has(k)) out.set(k, n.getBoundingClientRect().top);
  }
  return out;
}

/** Moves each mover from where it was (`from`) to where it is now. */
function move(el: HTMLElement, from: ReadonlyMap<string, number>, anchor: string | null, edges: ListEdges, state: Moving): void {
  for (const a of state.anims) a.cancel();
  state.anims = [];
  const gen = ++state.gen;
  el.removeAttribute('data-moving');
  const nodes = [...el.querySelectorAll<HTMLElement>(MOVER)];
  const box = el.getBoundingClientRect();
  // The open session stays in view: a move that would take it out scrolls the list by as much instead.
  const open = anchor ? nodes.find(n => n.dataset.flip === anchor) : undefined;
  const was = anchor ? from.get(anchor) : undefined;
  if (open && was !== undefined) {
    const r = open.getBoundingClientRect();
    const inView = (top: number) => top >= box.top - 0.5 && top + r.height <= box.bottom + 0.5;
    if (inView(was) && !inView(r.top)) el.scrollTop += r.top - was;
  }
  // The stuck head and the fades for the new order, read before anything is moved.
  edges.readNow();
  const settle = () => { el.style.overflowAnchor = ''; };
  if (reducedMotion()) { settle(); return; }
  const scrolled = el.scrollTop > 0.5;
  const anims: Animation[] = [];
  for (const n of nodes) {
    const start = from.get(n.dataset.flip ?? '');
    if (start === undefined || typeof n.animate !== 'function') continue;
    const r = n.getBoundingClientRect();
    const dy = start - r.top;
    if (Math.abs(dy) < 0.5) continue;
    // A head stuck at the top stays put: moving it would show the rows under it.
    if (scrolled && n.classList.contains('pj-head') && Math.abs(r.top - box.top) < 0.5) continue;
    // Out of view before and after: nothing to see.
    const seen = (top: number) => top + r.height > box.top && top < box.bottom;
    if (!seen(start) && !seen(r.top)) continue;
    anims.push(n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: MOVE_MS, easing: EASE }));
  }
  if (!anims.length) { settle(); return; }
  state.anims = anims;
  el.setAttribute('data-moving', '');
  void Promise.allSettled(anims.map(a => a.finished)).then(() => {
    if (state.gen !== gen) return;
    state.anims = [];
    el.removeAttribute('data-moving');
    settle();
    edges.readNow();
  });
}

export function useSteadyOrder(list: RefObject<HTMLElement | null>, live: ListOrder, opts: SteadyOrderOptions): { order: ListOrder; listProps: ListProps } {
  const { on, steady, busy, anchor, edges } = opts;
  // The order last applied; under Recent activity, what's shown while the list is in use.
  const [held, setHeld] = useState<ListOrder | null>(null);
  const [pointer, setPointer] = useState(false);
  const [keys, setKeys] = useState(false);
  const frozen = steady && (pointer || keys || busy);
  const order = on && steady ? holdListOrder(live, held) : live;
  // Where the movers were before a new order applied, for the render that draws it.
  const first = useRef<ReadonlyMap<string, number> | null>(null);
  const moving = useRef<Moving>({ gen: 0, anims: [] });

  useLayoutEffect(() => {
    const el = list.current;
    if (first.current) {
      const from = first.current;
      first.current = null;
      if (el) move(el, from, anchor, edges, moving.current);
    }
    // Focus went with a row that left the list (it moved or closed): nothing has it now.
    if (keys && !(el && el.contains(document.activeElement))) setKeys(false);
    if (!on) {
      if (held) setHeld(null);
      return;
    }
    if (frozen || sameListOrder(held, live)) return;
    if (steady && el && !sameListOrder(order, live)) {
      first.current = measure(el);
      // No scroll anchoring for the reorder (move() turns it back on once the moves end).
      el.style.overflowAnchor = 'none';
    }
    setHeld(live);
  });

  const listProps = useMemo<ListProps>(() => (on ? {
    onPointerEnter: () => setPointer(true),
    onPointerLeave: () => setPointer(false),
    onFocus: e => { if (focusVisible(e.target)) setKeys(true); },
    onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeys(false); },
    // Arrow keys, Tab, j/k: whatever was focused, the list is being used from the keyboard.
    onKeyDown: () => setKeys(true),
  } : {}), [on]);

  return { order, listProps };
}
