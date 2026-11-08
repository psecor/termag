// A full-screen phone surface follows the visual viewport (the phone client,
// and the simple UI's tools overlay).
// `interactive-widget=resizes-content` (index.html) shrinks the layout
// viewport for the keyboard in Chromium only; iOS overlays the keyboard and
// scrolls the layout viewport instead, which slid the fixed header off screen
// and left the composer under the keyboard. So the surface (`.m-root`, and
// `.chat-side-panel[data-overlay]`) takes its top and height from
// `window.visualViewport`, through CSS variables `--<prefix>-vvh` and
// `--<prefix>-vvtop`, and is marked `data-keyboard` while a keyboard is up.
import { useEffect } from 'react';

/** Below this many px of shrink, the change is browser chrome, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

export interface ViewportBox {
  height: number;
  offsetTop: number;
}

export interface ViewportVars {
  /** px height for the surface */
  height: number;
  /** px top for the surface */
  top: number;
  /** A software keyboard is up: the home-indicator inset is under it. */
  keyboard: boolean;
}

/**
 * `fullHeight` is the tallest the viewport has been at this width: iOS keeps
 * `innerHeight` when the keyboard opens, but Chromium (resizes-content)
 * shrinks it with the visual viewport, so `innerHeight` alone cannot tell.
 */
export function viewportVars(vv: ViewportBox | null | undefined, fullHeight: number): ViewportVars | null {
  if (!vv || !(vv.height > 0)) return null;
  const height = Math.round(vv.height);
  const top = Math.max(0, Math.round(vv.offsetTop));
  return { height, top, keyboard: fullHeight - height >= KEYBOARD_MIN_PX };
}

/** Track the keyboard-free height per viewport width (a rotation starts over). */
export function nextFullHeight(prev: { width: number; height: number } | null, width: number, heights: number[]): { width: number; height: number } {
  const tallest = Math.max(0, ...heights.filter(h => Number.isFinite(h)));
  if (!prev || prev.width !== width) return { width, height: tallest };
  return { width, height: Math.max(prev.height, tallest) };
}

/** The CSS variables a prefix names: `m` is the phone client's `--m-vvh` / `--m-vvtop`. */
export function viewportVarNames(prefix: string): { height: string; top: string } {
  return { height: `--${prefix}-vvh`, top: `--${prefix}-vvtop` };
}

/**
 * Keep `rootRef`'s element on the visual viewport while `enabled`: the
 * `--<prefix>-vvh` / `--<prefix>-vvtop` variables and `data-keyboard`. Turned
 * off (or unmounted), it removes all three, so CSS falls back to its own size.
 */
export function useVisualViewport(rootRef: React.RefObject<HTMLElement | null>, prefix = 'm', enabled = true): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const el = rootRef.current;
    if (!enabled || !vv || !el) return;
    const names = viewportVarNames(prefix);
    let frame = 0;
    let full: { width: number; height: number } | null = null;
    const apply = () => {
      frame = 0;
      full = nextFullHeight(full, Math.round(window.innerWidth), [window.innerHeight, vv.height]);
      const v = viewportVars(vv, full.height);
      if (!v) return;
      el.style.setProperty(names.height, `${v.height}px`);
      el.style.setProperty(names.top, `${v.top}px`);
      if (v.keyboard) el.dataset.keyboard = ''; else delete el.dataset.keyboard;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      el.style.removeProperty(names.height);
      el.style.removeProperty(names.top);
      delete el.dataset.keyboard;
    };
  }, [rootRef, prefix, enabled]);
}
