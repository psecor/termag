// An instant tooltip, for controls whose meaning is worth a sentence (the
// simple UI's composer pills and drawer triggers). The browser's `title`
// waits about a second and can't be styled; this shows at once on a mouse
// hover or a keyboard focus, above the control (below when there is no room),
// and never on touch, where a hover would stick. It hides on leave, blur,
// press and Escape, and while the control's own menu or dialog is open
// (aria-expanded="true"). The control is described by it (aria-describedby).
// It is portaled to the body so no overflow can clip it.
import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { scrollMoves } from '../utils/scrollMoves';

const GAP = 8;
const EDGE = 8;

type TriggerProps = {
  ref?: React.Ref<HTMLElement>;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean | 'true' | 'false';
  onPointerEnter?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
};

/** Where the tooltip goes: centred above the trigger, below it when the top has no room, inside the viewport. */
export function tooltipPosition(
  trigger: { top: number; bottom: number; left: number; width: number },
  tip: { width: number; height: number },
  viewport: { width: number },
): { top: number; left: number; side: 'top' | 'bottom' } {
  const above = trigger.top - GAP - tip.height;
  const side = above >= EDGE ? 'top' : 'bottom';
  const top = side === 'top' ? above : trigger.bottom + GAP;
  const centred = trigger.left + trigger.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, viewport.width - EDGE - tip.width));
  return { top, left, side };
}

export function Tooltip({ content, children }: {
  content: React.ReactNode;
  children: React.ReactElement<TriggerProps>;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const child = children.props;
  const expanded = child['aria-expanded'] === true || child['aria-expanded'] === 'true';
  const shown = open && !expanded && content != null && content !== '';

  useLayoutEffect(() => {
    if (!shown) { setPos(null); return; }
    const t = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!t || !tip) return;
    setPos(tooltipPosition(t, tip, { width: window.innerWidth }));
  }, [shown, content]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Only a scroll that moves the control: the chat streaming above the composer leaves its tip up.
    const onScroll = (e: Event) => { if (scrollMoves(e, triggerRef.current)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [shown]);

  const setRef = (el: HTMLElement | null) => {
    triggerRef.current = el;
    const r = child.ref;
    if (typeof r === 'function') r(el);
    else if (r && typeof r === 'object') (r as React.MutableRefObject<HTMLElement | null>).current = el;
  };

  const trigger = cloneElement(children, {
    ref: setRef,
    'aria-describedby': [child['aria-describedby'], shown ? id : null].filter(Boolean).join(' ') || undefined,
    onPointerEnter: e => { child.onPointerEnter?.(e); if (e.pointerType === 'mouse') setOpen(true); },
    onPointerLeave: e => { child.onPointerLeave?.(e); setOpen(false); },
    onPointerDown: e => { child.onPointerDown?.(e); setOpen(false); },
    onFocus: e => {
      child.onFocus?.(e);
      // Keyboard focus only: a click focuses the control too, and has just hidden the tip.
      try { if (e.currentTarget.matches(':focus-visible')) setOpen(true); } catch { /* no :focus-visible */ }
    },
    onBlur: e => { child.onBlur?.(e); setOpen(false); },
  });

  return (
    <>
      {trigger}
      {shown && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className="ui-tooltip"
          data-side={pos?.side}
          style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: 'hidden' }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
