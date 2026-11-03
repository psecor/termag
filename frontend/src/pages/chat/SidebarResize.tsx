// The sidebar's resize handle under the chrome refresh:
// drag it, or focus it and use the arrow
// keys (Shift for bigger steps, Home and End for the limits, Enter or a
// double-click for the default). The width is kept per browser
// (chat/sidebarWidth.ts). Hand-rolled: neither LaunchPad nor React Aria has a
// splitter, and this is a window separator (role="separator"), not a slider.
import React, { useCallback, useRef, useState } from 'react';
import {
  readSidebarWidth, sidebarWidthForKey, writeSidebarWidth,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '../../chat/sidebarWidth';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

export interface SidebarWidth {
  width: number;
  setWidth: (width: number) => void;
  /** Keeps the width shown now. */
  keep: (width: number) => void;
}

/** The sidebar's width, read once from the browser's copy. */
export function useSidebarWidth(): SidebarWidth {
  const [width, setWidth] = useState(() => readSidebarWidth(storage()));
  const keep = useCallback((w: number) => writeSidebarWidth(storage(), w), []);
  return { width, setWidth, keep };
}

export function SidebarResize({ width, setWidth, keep }: SidebarWidth) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const set = (w: number) => { setWidth(w); keep(w); };
  return (
    <div
      className="chat-sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-controls="chat-conversations"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, last: width };
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        d.last = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, d.width + e.clientX - d.x)));
        setWidth(d.last);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && d.last !== d.width) keep(d.last);
      }}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        if (d) setWidth(d.width);
      }}
      onDoubleClick={() => set(SIDEBAR_DEFAULT)}
      onKeyDown={e => {
        const next = sidebarWidthForKey(width, e.key, e.shiftKey);
        if (next == null) return;
        e.preventDefault();
        set(next);
      }}
    />
  );
}
