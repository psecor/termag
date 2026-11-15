// The sidebar's stuck head and scroll edges (useListEdges.ts).
import { describe, expect, it } from 'vitest';
import { moreToScroll, stuckHead } from './useListEdges';

describe('stuckHead', () => {
  const EDGE = 100;
  it('is none at the top of the list, where nothing is under a head', () => {
    expect(stuckHead([{ top: 100, sectionBottom: 300 }], EDGE, false)).toBe(-1);
  });

  it('is the head at the edge while its section reaches below it', () => {
    expect(stuckHead([{ top: 100, sectionBottom: 300 }, { top: 300, sectionBottom: 500 }], EDGE, true)).toBe(0);
  });

  it('stays the head being pushed out, until its section has gone; then the next', () => {
    // Handover: the first is 12 px out, its section's bottom is the second's top.
    expect(stuckHead([{ top: 88, sectionBottom: 120 }, { top: 120, sectionBottom: 400 }], EDGE, true)).toBe(0);
    // Its section has gone past the edge: the second has reached the edge and is stuck.
    expect(stuckHead([{ top: 68, sectionBottom: 100 }, { top: 100, sectionBottom: 380 }], EDGE, true)).toBe(1);
  });

  it('is none when no head has reached the edge yet', () => {
    expect(stuckHead([{ top: 140, sectionBottom: 300 }], EDGE, true)).toBe(-1);
  });
});

describe('moreToScroll', () => {
  it('says there is more above only once scrolled, and below until the end, rounding aside', () => {
    expect(moreToScroll(0, 500, 1200)).toEqual({ above: false, below: true });
    expect(moreToScroll(300, 500, 1200)).toEqual({ above: true, below: true });
    expect(moreToScroll(700, 500, 1200)).toEqual({ above: true, below: false });
    expect(moreToScroll(699.6, 500, 1200)).toEqual({ above: true, below: false });
    expect(moreToScroll(0, 500, 500)).toEqual({ above: false, below: false });
  });
});
