import { describe, expect, it } from 'vitest';
import { heldNext } from './ReviewSheet';

describe('a review the start route holds while its box wakes, on the phone', () => {
  it('keeps waiting while the box wakes or the start runs', () => {
    expect(heldNext({ state: 'waking' })).toEqual({ waking: true });
    expect(heldNext({ state: 'starting' })).toEqual({ waking: true });
  });
  it('stops when it ran, and says why when it failed', () => {
    expect(heldNext(null)).toEqual({ waking: false });
    expect(heldNext({ state: 'failed', error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.' }))
      .toEqual({ waking: false, error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.' });
  });
});
