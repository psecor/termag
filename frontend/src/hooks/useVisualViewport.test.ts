import { describe, expect, it } from 'vitest';
import { nextFullHeight, viewportVars } from './useVisualViewport';

describe('viewportVars', () => {
  it('follows the visual viewport', () => {
    expect(viewportVars({ height: 800.4, offsetTop: 0 }, 800)).toEqual({ height: 800, top: 0, keyboard: false });
  });

  it('flags a keyboard when the viewport shrank a lot, and keeps the iOS scroll offset', () => {
    expect(viewportVars({ height: 450, offsetTop: 210.6 }, 844)).toEqual({ height: 450, top: 211, keyboard: true });
  });

  it('treats a small shrink (toolbar) as no keyboard', () => {
    expect(viewportVars({ height: 760, offsetTop: 0 }, 844)!.keyboard).toBe(false);
  });

  it('ignores a missing or empty viewport, and never goes negative', () => {
    expect(viewportVars(null, 800)).toBeNull();
    expect(viewportVars({ height: 0, offsetTop: 0 }, 800)).toBeNull();
    expect(viewportVars({ height: 500, offsetTop: -8 }, 800)!.top).toBe(0);
  });
});

describe('nextFullHeight', () => {
  it('remembers the tallest height at a width, so a Chromium resize still reads as a keyboard', () => {
    let f = nextFullHeight(null, 411, [811, 811]);
    expect(f).toEqual({ width: 411, height: 811 });
    f = nextFullHeight(f, 411, [498, 498]); // keyboard: both shrink on Android
    expect(f.height).toBe(811);
    expect(viewportVars({ height: 498, offsetTop: 0 }, f.height)!.keyboard).toBe(true);
  });

  it('starts over on rotation', () => {
    const f = nextFullHeight({ width: 411, height: 811 }, 891, [380]);
    expect(f).toEqual({ width: 891, height: 380 });
  });
});
