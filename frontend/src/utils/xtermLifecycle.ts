import type { Terminal } from 'xterm';

interface ViewportInternals {
  _isDisposed?: boolean;
  [method: string]: unknown;
}

/**
 * xterm 5.x's Viewport schedules scroll-area refreshes on its own timers (a
 * setTimeout from its constructor, a requestAnimationFrame from every
 * syncScrollArea/reset) and never cancels them when the terminal is disposed.
 * term.dispose() clears the render service's renderer, so a frame that was
 * already queued then reads `_renderService.dimensions` off an undefined
 * renderer and throws an uncaught "Cannot read properties of undefined
 * (reading 'dimensions')" from Viewport._innerRefresh. Any write in the frame
 * before an unmount (a busy pane, or the error boundary unmounting every pane
 * at once) is enough to hit it.
 *
 * Those timers are internal, so they cannot be cancelled from outside. Instead
 * the two Viewport methods they call become no-ops once the Viewport itself is
 * disposed. This reaches into private xterm state on purpose; it is a no-op if
 * the internals are not shaped as expected (e.g. after an xterm upgrade).
 * Call it after term.open(), which is when the Viewport exists.
 */
export function guardViewportAfterDispose(term: Terminal): void {
  const viewport = (term as unknown as { _core?: { viewport?: ViewportInternals } })._core?.viewport;
  if (!viewport) return;
  for (const name of ['syncScrollArea', '_innerRefresh']) {
    const original = viewport[name];
    if (typeof original !== 'function') continue;
    viewport[name] = function (this: ViewportInternals, ...args: unknown[]) {
      if (this._isDisposed) return;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}

/**
 * FitAddon.fit() on a zero-sized container (a collapsed dock, a pane laid out
 * before its column has a width) shrinks the terminal to its 2x1 minimum,
 * which the resize message then pushes to tmux. Skip the fit instead; the
 * ResizeObserver fits again once the container has a size.
 */
export function hasLayoutSize(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0;
}
