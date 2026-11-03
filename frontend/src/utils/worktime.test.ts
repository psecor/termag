import { describe, expect, it } from 'vitest';
import { localToday } from './dates';
import { worktimeToday } from './worktime';

describe('worktimeToday', () => {
  it("is the day termag answers as the reader's today", () => {
    // termag banks working time by the zone the reader sends, and says which day is theirs.
    expect(worktimeToday({ today: '2026-10-29' })).toBe('2026-10-29');
  });

  it("is this browser's day when termag doesn't say", () => {
    expect(worktimeToday({})).toBe(localToday());
  });
});
