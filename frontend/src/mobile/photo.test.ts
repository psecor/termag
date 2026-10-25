import { describe, expect, it } from 'vitest';
import { fitWithin, MAX_EDGE_PX } from './photo';

describe('fitWithin', () => {
  it('scales the long edge down to the cap, keeping the aspect', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_EDGE_PX, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: MAX_EDGE_PX });
  });
  it('never upscales', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it('handles a degenerate size', () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});
