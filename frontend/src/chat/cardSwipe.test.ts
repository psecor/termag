import { describe, expect, it } from 'vitest';
import { SWIPE_ACT_PX, swipeAction, swipeActs, swipeLock, swipeOffset } from './cardSwipe';

const both = { pin: true, archive: true };

describe('a card\'s swipe on a phone', () => {
  it('is a swipe only once it goes sideways more than down; a scroll otherwise', () => {
    expect(swipeLock(4, 3)).toBeNull();
    expect(swipeLock(20, 4)).toBe('swipe');
    expect(swipeLock(-20, 6)).toBe('swipe');
    expect(swipeLock(12, 10)).toBe('scroll');
    expect(swipeLock(2, 30)).toBe('scroll');
  });

  it('pins to the right and archives to the left, only where the card offers it', () => {
    expect(swipeAction(40, both)).toBe('pin');
    expect(swipeAction(-40, both)).toBe('archive');
    expect(swipeAction(-40, { pin: true, archive: false })).toBeNull();
    expect(swipeAction(40, { pin: false, archive: true })).toBeNull();
  });

  it('follows the finger to the threshold, then resists, and never moves the way nothing is offered', () => {
    expect(swipeOffset(50, both)).toBe(50);
    expect(swipeOffset(-SWIPE_ACT_PX, both)).toBe(-SWIPE_ACT_PX);
    expect(swipeOffset(SWIPE_ACT_PX + 100, both)).toBeCloseTo(SWIPE_ACT_PX + 35);
    expect(swipeOffset(-50, { pin: true, archive: false })).toBe(0);
  });

  it('acts on release past the threshold, a third of a narrow card', () => {
    expect(swipeActs(90, 300, both)).toBe('pin');
    expect(swipeActs(-90, 300, both)).toBe('archive');
    expect(swipeActs(60, 300, both)).toBeNull();
    expect(swipeActs(60, 150, both)).toBe('pin');
    expect(swipeActs(-200, 300, { pin: true, archive: false })).toBeNull();
  });
});
