import { useEffect } from 'react';

/**
 * The viewport meta's content without its zoom lock. index.html locks zoom
 * (`maximum-scale=1, user-scalable=no`) for the workspace, whose terminals and
 * chrome block touch zoom on purpose (App.css); this drops those two parts and
 * keeps the rest (width, initial-scale, interactive-widget, viewport-fit).
 */
export function zoomableViewportContent(content: string): string {
  return content
    .split(',')
    .map(p => p.trim())
    .filter(p => p && !/^(maximum-scale|user-scalable)\s*=/i.test(p))
    .join(', ');
}

/**
 * Pinch-zoom back on while mounted and `enabled`: the
 * phone client (/m) always, the simple UI (/chat) on a phone except while its
 * side-panel overlay is open, where a pinch would fight xterm. The page's
 * inputs must be 16 px at that width, or iOS zooms into each one it focuses.
 * Turning it off, or unmounting, puts the original content back.
 */
export function useZoomableViewport(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    meta.content = zoomableViewportContent(original);
    return () => { meta.content = original; };
  }, [enabled]);
}
