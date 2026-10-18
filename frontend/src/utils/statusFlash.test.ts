import { describe, expect, it } from 'vitest';
import { flashesTransition } from './statusFlash';

describe('flashesTransition', () => {
  it('does not flash a first launch out of not running', () => {
    expect(flashesTransition('not_running', 'idle')).toBe(false);
    expect(flashesTransition('not_running', 'working')).toBe(false);
  });

  it('flashes a change between live states, as before', () => {
    expect(flashesTransition('working', 'idle')).toBe(true);
    expect(flashesTransition('idle', 'working')).toBe(true);
    expect(flashesTransition('working', 'waiting')).toBe(true);
    expect(flashesTransition('idle', 'not_running')).toBe(true);
  });

  it('does not flash an unchanged or first-seen status', () => {
    expect(flashesTransition('idle', 'idle')).toBe(false);
    expect(flashesTransition(undefined, 'idle')).toBe(false);
  });
});
