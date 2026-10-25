import { describe, expect, it } from 'vitest';
import { PULL_IDLE, PULL_MAX_PX, PULL_TRIGGER_PX, pullDistance, pullEnd, pullMove, pullStart } from './pullToRefresh';

describe('pullDistance', () => {
  it('halves finger travel, caps it, and ignores upward travel', () => {
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(40)).toBe(20);
    expect(pullDistance(1000)).toBe(PULL_MAX_PX);
    expect(pullDistance(NaN)).toBe(0);
  });
});

describe('pull gesture', () => {
  it('starts only at the top of the list', () => {
    expect(pullStart(0, 100)).toEqual({ startY: 100, distance: 0 });
    expect(pullStart(12, 100)).toBe(PULL_IDLE);
  });

  it('refreshes when released past the trigger', () => {
    let s = pullStart(0, 100);
    s = pullMove(s, 100 + PULL_TRIGGER_PX * 2);
    expect(s.distance).toBe(PULL_TRIGGER_PX);
    expect(pullEnd(s)).toEqual({ refresh: true, next: PULL_IDLE });
  });

  it('does not refresh a short pull, or one that turned upward', () => {
    expect(pullEnd(pullMove(pullStart(0, 100), 150)).refresh).toBe(false);
    const up = pullMove(pullMove(pullStart(0, 100), 300), 90);
    expect(up).toBe(PULL_IDLE);
    expect(pullEnd(up).refresh).toBe(false);
  });

  it('ignores moves when no pull started', () => {
    expect(pullMove(PULL_IDLE, 500)).toBe(PULL_IDLE);
    expect(pullEnd(PULL_IDLE).refresh).toBe(false);
  });
});
