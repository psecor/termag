import { describe, expect, it } from 'vitest';
import { easeWarp } from './warp';

describe('easeWarp', () => {
  it('moves part of the way toward the target from either side', () => {
    const up = easeWarp(0.1, 1, 100);
    expect(up).toBeGreaterThan(0.1);
    expect(up).toBeLessThan(1);
    const down = easeWarp(1, 0.1, 100);
    expect(down).toBeLessThan(1);
    expect(down).toBeGreaterThan(0.1);
  });

  it('keeps the old per-frame feel: one 60fps frame closes 15% of the gap', () => {
    expect(easeWarp(0, 1, 1000 / 60)).toBeCloseTo(0.15, 6);
  });

  it('does not depend on step size: two half steps equal one full step', () => {
    const one = easeWarp(0.1, 2, 100);
    const two = easeWarp(easeWarp(0.1, 2, 50), 2, 50);
    expect(two).toBeCloseTo(one, 9);
  });

  it('settles exactly on the target instead of creeping forever', () => {
    let w = 0.1;
    for (let i = 0; i < 200; i++) w = easeWarp(w, 1, 100);
    expect(w).toBe(1);
  });

  it('holds still when no time has passed and recovers from a bad current value', () => {
    expect(easeWarp(0.3, 1, 0)).toBe(0.3);
    expect(easeWarp(Number.NaN, 1, 100)).toBe(1);
  });
});
