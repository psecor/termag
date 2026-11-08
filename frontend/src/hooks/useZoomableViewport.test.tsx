// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useZoomableViewport, zoomableViewportContent } from './useZoomableViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ on }: { on?: boolean }) { useZoomableViewport(on); return null; }

/** Mounts the hook; rerender(on) and unmount() as testing-library's renderHook would. */
function renderHook(on?: boolean) {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe on={on} />));
  return {
    rerender: (next?: boolean) => act(() => root.render(<Probe on={next} />)),
    unmount: () => act(() => root.unmount()),
  };
}

// index.html's viewport meta, verbatim.
const LOCKED = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content, viewport-fit=cover';
const OPEN = 'width=device-width, initial-scale=1.0, interactive-widget=resizes-content, viewport-fit=cover';

describe('zoomableViewportContent', () => {
  it('drops the zoom lock and keeps the rest', () => {
    expect(zoomableViewportContent(LOCKED)).toBe(OPEN);
  });
  it('leaves an unlocked viewport as it is', () => {
    expect(zoomableViewportContent(OPEN)).toBe(OPEN);
  });
  it('matches the lock however it is spaced or cased', () => {
    expect(zoomableViewportContent('width=device-width,Maximum-Scale = 1,user-scalable=0,')).toBe('width=device-width');
  });
});

describe('useZoomableViewport', () => {
  let meta: HTMLMetaElement;
  beforeEach(() => {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = LOCKED;
    document.head.appendChild(meta);
  });
  afterEach(() => { meta.remove(); });

  it('lifts the lock while mounted and puts it back on unmount', () => {
    const { unmount } = renderHook();
    expect(meta.content).toBe(OPEN);
    unmount();
    expect(meta.content).toBe(LOCKED);
  });

  it('follows enabled: locked while off (the terminal overlay open), open again after', () => {
    const { rerender, unmount } = renderHook(true);
    expect(meta.content).toBe(OPEN);
    rerender(false);
    expect(meta.content).toBe(LOCKED);
    rerender(true);
    expect(meta.content).toBe(OPEN);
    unmount();
    expect(meta.content).toBe(LOCKED);
  });

  it('touches nothing when disabled from the start', () => {
    const { unmount } = renderHook(false);
    expect(meta.content).toBe(LOCKED);
    unmount();
    expect(meta.content).toBe(LOCKED);
  });
});
