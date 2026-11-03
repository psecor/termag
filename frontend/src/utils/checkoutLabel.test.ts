import { describe, expect, it } from 'vitest';
import { checkoutLabel } from './checkoutLabel';

describe('checkoutLabel', () => {
  it('shortens a home directory to ~, and leaves anything else as it is', () => {
    expect(checkoutLabel('/home/olive/src/webapp')).toBe('~/src/webapp');
    expect(checkoutLabel('/root/src/termag/.worktrees/x')).toBe('~/src/termag/.worktrees/x');
    expect(checkoutLabel('/data/olive/webapp')).toBe('/data/olive/webapp');
    expect(checkoutLabel('/home/olive')).toBe('/home/olive');
  });
});
