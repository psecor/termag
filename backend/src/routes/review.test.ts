import { describe, it, expect } from 'vitest';
import { decodePrOption, encodePrOption } from '../services/review';

describe('review PR option codec', () => {
  it('round-trips a PR with and without its url', () => {
    expect(decodePrOption(encodePrOption(205, 'https://github.com/example-org/termag/pull/205')))
      .toEqual({ pr: 205, url: 'https://github.com/example-org/termag/pull/205' });
    expect(decodePrOption(encodePrOption(7, null))).toEqual({ pr: 7, url: null });
  });
  it('re-validates what comes back from tmux', () => {
    expect(decodePrOption('205 https://github.com/o/r/pull/9')).toEqual({ pr: 205, url: null });
    expect(decodePrOption('abc')).toBeNull();
    expect(decodePrOption('')).toBeNull();
    expect(decodePrOption(null)).toBeNull();
  });
});
