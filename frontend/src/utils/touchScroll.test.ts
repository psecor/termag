import { describe, expect, it } from 'vitest';
import {
  cellAt, DRAG_SLOP_PX, dragUnits, flingStep, FLING_STOP_VELOCITY, lockAxis, moveDrag, releaseVelocity,
  shouldFling, startDrag, wheelReports, wheelSequence, type DragState,
} from './touchScroll';

describe('lockAxis', () => {
  const s = startDrag(100, 100, 0);
  it('stays pending inside the slop, so a tap stays a tap', () => {
    expect(lockAxis(s, 100 + DRAG_SLOP_PX - 1, 100)).toBe('pending');
    expect(lockAxis(s, 100, 100 - (DRAG_SLOP_PX - 1))).toBe('pending');
  });
  it('locks vertical when the drag moved more up or down than sideways', () => {
    expect(lockAxis(s, 103, 120)).toBe('vertical');
    expect(lockAxis(s, 97, 80)).toBe('vertical');
  });
  it('locks sideways otherwise, and a 45° drag is not ours', () => {
    expect(lockAxis(s, 130, 105)).toBe('other');
    expect(lockAxis(s, 110, 110)).toBe('other');
  });
  it('keeps the axis once locked', () => {
    expect(lockAxis({ ...s, axis: 'other' }, 100, 200)).toBe('other');
    expect(lockAxis({ ...s, axis: 'vertical' }, 300, 100)).toBe('vertical');
  });
});

describe('dragUnits', () => {
  it('moves the content with the finger: up is newer (+), down is older (-)', () => {
    expect(dragUnits(0, -40, 20)).toEqual({ units: 2, remainderPx: 0 });
    expect(dragUnits(0, 40, 20)).toEqual({ units: -2, remainderPx: 0 });
  });
  it('carries the part of a line not yet scrolled', () => {
    const a = dragUnits(0, -15, 20);
    expect(a).toEqual({ units: 0, remainderPx: 15 });
    const b = dragUnits(a.remainderPx, -10, 20);
    expect(b).toEqual({ units: 1, remainderPx: 5 });
  });
  it('a change of direction spends the carried pixels first', () => {
    expect(dragUnits(15, 10, 20)).toEqual({ units: 0, remainderPx: 5 });
    expect(dragUnits(5, 30, 20)).toEqual({ units: -1, remainderPx: -5 });
  });
  it('scrolls nothing before layout (no line height)', () => {
    expect(dragUnits(7, -100, 0)).toEqual({ units: 0, remainderPx: 0 });
  });
  it('a long drag is many lines at once', () => {
    expect(dragUnits(0, 340, 17).units).toBe(-20);
  });
});

describe('moveDrag and releaseVelocity', () => {
  it('follows a drag and measures its speed over the last 100 ms', () => {
    let s: DragState = { ...startDrag(50, 300, 0), axis: 'vertical' };
    let total = 0;
    for (let t = 10, y = 280; t <= 200; t += 10, y -= 20) {
      const r = moveDrag(s, y, t, 20);
      total += r.units;
      s = r.state;
    }
    expect(total).toBe(20);
    expect(releaseVelocity(s, 200)).toBeCloseTo(-2);
    expect(s.samples.every(p => 200 - p.t <= 100)).toBe(true);
  });
  it('a finger that stopped before lifting has no speed', () => {
    const s = moveDrag(startDrag(0, 0, 0), 50, 10, 20).state;
    expect(releaseVelocity(s, 500)).toBe(0);
  });
});

describe('fling', () => {
  it('flings only past the threshold', () => {
    expect(shouldFling(0.1)).toBe(false);
    expect(shouldFling(-1)).toBe(true);
  });
  it('slows each frame and stops', () => {
    let v = 2;
    let frames = 0;
    let px = 0;
    for (;;) {
      const step = flingStep(v, 16);
      if (!step) break;
      expect(Math.abs(step.velocity)).toBeLessThan(Math.abs(v));
      px += step.dy;
      v = step.velocity;
      frames++;
    }
    expect(Math.abs(v)).toBeLessThan(FLING_STOP_VELOCITY);
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(200);
    expect(px).toBeGreaterThan(0);
  });
  it('a frame with no time does nothing', () => {
    expect(flingStep(2, 0)).toBeNull();
  });
});

describe('cellAt', () => {
  const rect = { left: 10, top: 20, width: 400, height: 200 };
  it('names the 1-based cell under the point', () => {
    expect(cellAt(10, 20, rect, 40, 10)).toEqual({ col: 1, row: 1 });
    expect(cellAt(10 + 205, 20 + 105, rect, 40, 10)).toEqual({ col: 21, row: 6 });
  });
  it('clamps a point off the screen', () => {
    expect(cellAt(0, 0, rect, 40, 10)).toEqual({ col: 1, row: 1 });
    expect(cellAt(999, 999, rect, 40, 10)).toEqual({ col: 40, row: 10 });
  });
});

describe('wheel reports', () => {
  it('SGR: 64 up, 65 down, at the cell', () => {
    expect(wheelSequence('up', 3, 7, true)).toBe('\x1b[<64;3;7M');
    expect(wheelSequence('down', 3, 7, true)).toBe('\x1b[<65;3;7M');
  });
  it('X10: CSI M and three bytes offset by 32, capped at 223', () => {
    expect(wheelSequence('up', 1, 1, false)).toBe('\x1b[M`!!');
    expect(wheelSequence('down', 300, 2, false)).toBe(`\x1b[Ma${String.fromCharCode(255)}"`);
  });
  it('a negative count is up (older), a positive one down', () => {
    expect(wheelReports(-2, 1, 1, true)).toBe('\x1b[<64;1;1M\x1b[<64;1;1M');
    expect(wheelReports(1, 1, 1, true)).toBe('\x1b[<65;1;1M');
    expect(wheelReports(0, 1, 1, true)).toBe('');
  });
});
