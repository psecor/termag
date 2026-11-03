import { describe, expect, it } from 'vitest';
import { incrementalWindow, moveShown } from './incrementalList';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

describe('moveShown', () => {
  const all = rows(25);
  const shown = [...rows(10), 'r22'];
  it('moves among the rows shown, the hidden ones after them in their order', () => {
    expect(moveShown(all, rows(10), 'r3', 0)).toEqual(['r3', 'r0', 'r1', 'r2', ...all.slice(4)]);
    // The 10th row one step down, past a kept row shown after the window: the kept row comes up instead.
    const next = moveShown(all, shown, 'r9', 10);
    expect(next.slice(0, 11)).toEqual([...rows(9), 'r22', 'r9']);
    expect(next.slice(11)).toEqual(all.slice(10).filter(r => r !== 'r22'));
    expect(incrementalWindow(next, 11).visible).toEqual(next.slice(0, 11));
  });
  it('keeps a list with nothing kept past the window as one move', () => {
    expect(moveShown(rows(4), rows(4), 'r0', 3)).toEqual(['r1', 'r2', 'r3', 'r0']);
  });
});

describe('incrementalWindow', () => {
  it('shows the first step, then more on each widening, until nothing is hidden', () => {
    expect(incrementalWindow(rows(25), 10)).toEqual({ visible: rows(10), hidden: 15 });
    expect(incrementalWindow(rows(25), 20)).toEqual({ visible: rows(20), hidden: 5 });
    expect(incrementalWindow(rows(25), 30)).toEqual({ visible: rows(25), hidden: 0 });
  });

  it('hides nothing in a list that fits', () => {
    expect(incrementalWindow(rows(10), 10)).toEqual({ visible: rows(10), hidden: 0 });
    expect(incrementalWindow([], 10).hidden).toBe(0);
  });

  it('always shows a kept row, in its place, past the window', () => {
    const w = incrementalWindow(rows(25), 10, r => r === 'r17');
    expect(w.visible).toEqual([...rows(10), 'r17']);
    expect(w.hidden).toBe(14);
    // Only the kept row is past the window: nothing is hidden.
    expect(incrementalWindow(rows(11), 10, r => r === 'r10')).toEqual({ visible: rows(11), hidden: 0 });
  });

  it('counts a tree\'s top-level row with its children as one row', () => {
    const places = rows(12).map(r => [r, `${r}.ask`]);
    const w = incrementalWindow(places, 10, p => p.includes('r11.ask'));
    expect(w.visible).toHaveLength(11);
    expect(w.visible.flat()).toContain('r11.ask');
    expect(w.visible.flat()).toContain('r11');
    expect(w.hidden).toBe(1);
  });
});
