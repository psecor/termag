// A one-finger vertical drag on the phone terminal scrolls its history
// (design PR 4); the mapping is utils/touchScroll.ts.
// While tmux has mouse on (scroll mode) the drag becomes wheel reports, so
// tmux's copy-mode scrolls, one report per TMUX_WHEEL_LINES lines dragged;
// otherwise it scrolls xterm's own buffer a line at a time. A quick release
// flings on and slows down. With the select toggle on, the gesture is left to
// xterm, so selecting to copy stays the opt-in mode.
//
// A touch's moves and its end go to the element it started on, even after
// that element leaves the document, and a detached element's events reach
// no ancestor. xterm's DOM renderer replaces its row elements on every
// redraw, and the first wheel report makes tmux redraw, so a listener on the
// pane heard about one report's worth of drag and then nothing. So the
// touchstart (on the pane's wrapper, capture phase) also puts the move and
// end listeners on the touch's own target. While the target is attached the
// wrapper's capture-phase listener sees each move first and stops a claimed
// one there, so xterm's own listeners never scroll it a second time; once it
// is detached, only the target's listener hears it. Each move is handled once. A tap (inside DRAG_SLOP_PX) and a sideways drag
// are never claimed, so tap to type still focuses the pane.
import { useEffect, type RefObject } from 'react';
import type { TerminalHandle } from '../../components/Terminal';
import {
  dragUnits, flingStep, lockAxis, moveDrag, releaseVelocity, shouldFling, startDrag,
  TMUX_WHEEL_LINES, type DragState,
} from '../../utils/touchScroll';

export function useTouchScroll(
  ref: RefObject<HTMLElement | null>,
  terminal: () => TerminalHandle | null,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    let drag: DragState | null = null;
    let fling: number | null = null;
    /** The element the current touch started on, which holds its move and end listeners. */
    let target: EventTarget | null = null;
    const now = () => performance.now();

    const stopFling = () => {
      if (fling !== null) cancelAnimationFrame(fling);
      fling = null;
    };

    /** The scroll unit in px for the pane's current target, or 0 when the gesture isn't ours. */
    const unitPx = (t: TerminalHandle) => {
      const target = t.scrollTarget();
      if (target === 'select') return 0;
      const line = t.lineHeight();
      return target === 'wheel' ? line * TMUX_WHEEL_LINES : line;
    };

    const apply = (t: TerminalHandle, units: number, at: { x: number; y: number }) => {
      if (units === 0) return;
      if (t.scrollTarget() === 'wheel') t.wheel(units, at.x, at.y);
      else t.scrollLines(units);
    };

    const opts = { passive: false } as const;
    const release = () => {
      if (!target) return;
      target.removeEventListener('touchmove', onMove as EventListener);
      target.removeEventListener('touchend', onEnd);
      target.removeEventListener('touchcancel', onEnd);
      target = null;
    };

    const onStart = (ev: TouchEvent) => {
      stopFling();
      release();
      const touch = ev.touches.length === 1 ? ev.touches[0] : null;
      drag = touch ? startDrag(touch.clientX, touch.clientY, now()) : null;
      if (!drag || !ev.target) return;
      target = ev.target;
      target.addEventListener('touchmove', onMove as EventListener, opts);
      target.addEventListener('touchend', onEnd, opts);
      target.addEventListener('touchcancel', onEnd, opts);
    };

    let handled: Event | null = null;
    function onMove(ev: TouchEvent) {
      if (!drag || handled === ev) return;
      handled = ev;
      const t = terminal();
      const touch = ev.touches.length === 1 ? ev.touches[0] : null;
      if (!t || !touch) { drag = null; return; }
      const axis = lockAxis(drag, touch.clientX, touch.clientY);
      drag = { ...drag, axis };
      if (axis !== 'vertical') return;
      const unit = unitPx(t);
      if (unit <= 0) { drag = null; return; }
      if (ev.cancelable) ev.preventDefault();
      ev.stopPropagation();
      const { units, state } = moveDrag(drag, touch.clientY, now(), unit);
      drag = state;
      apply(t, units, { x: drag.startX, y: drag.startY });
    }

    function onEnd() {
      release();
      const d = drag;
      drag = null;
      if (!d || d.axis !== 'vertical') return;
      const t = terminal();
      if (!t) return;
      let velocity = releaseVelocity(d, now());
      if (!shouldFling(velocity)) return;
      let remainder = d.remainderPx;
      let last = now();
      const at = { x: d.startX, y: d.startY };
      const frame = (ts: number) => {
        const step = flingStep(velocity, ts - last);
        last = ts;
        const unit = unitPx(t);
        if (!step || unit <= 0) { fling = null; return; }
        velocity = step.velocity;
        const r = dragUnits(remainder, step.dy, unit);
        remainder = r.remainderPx;
        apply(t, r.units, at);
        fling = requestAnimationFrame(frame);
      };
      fling = requestAnimationFrame(frame);
    }

    const startOpts = { capture: true, passive: true } as const;
    const moveOpts = { capture: true, passive: false } as const;
    el.addEventListener('touchstart', onStart, startOpts);
    el.addEventListener('touchmove', onMove, moveOpts);
    return () => {
      stopFling();
      release();
      el.removeEventListener('touchstart', onStart, startOpts);
      el.removeEventListener('touchmove', onMove, moveOpts);
    };
  }, [ref, terminal, enabled]);
}
