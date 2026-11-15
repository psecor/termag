import { describe, expect, it } from 'vitest';
import {
  activityOf, compareActivity, holdListOrder, holdOrder, newestActivity, sameListOrder, sortByActivity, sortGroupsByActivity, type Activity,
} from './sidebarSort';

const idle = (at: number): Activity => ({ working: false, at });
const working = (at: number): Activity => ({ working: true, at });

describe('activityOf (Sort by recent activity)', () => {
  const status = (since: number | null, stoppedAt: number | null = null) => ({ since, stoppedAt });

  it("is the newest of the card's time, the last turn's end and when the session started", () => {
    expect(activityOf({ state: 'other', startedAt: 100, status: status(300), projectAt: 900 })).toEqual(idle(300));
    expect(activityOf({ state: 'other', startedAt: 500, status: status(300), projectAt: 900 })).toEqual(idle(500));
    expect(activityOf({ state: 'other', startedAt: 100, status: status(300, 400), projectAt: 900 })).toEqual(idle(400));
    expect(activityOf({ state: 'working', startedAt: 100, status: null, projectAt: 900 })).toEqual(working(100));
  });

  it("doesn't count not running's time, which is the box's or the process's: only its last turn", () => {
    expect(activityOf({ state: 'off', startedAt: 100, status: status(800), projectAt: 900 })).toEqual(idle(100));
    expect(activityOf({ state: 'off', startedAt: 100, status: status(800, 300), projectAt: 900 })).toEqual(idle(300));
  });

  it("takes its project's time only when the session has none of its own, and is unknown with none at all", () => {
    expect(activityOf({ state: 'other', startedAt: null, status: null, projectAt: 900 })).toEqual(idle(900));
    expect(activityOf({ state: 'other', startedAt: NaN, status: status(null), projectAt: 900 })).toEqual(idle(900));
    expect(activityOf({ state: 'other', startedAt: null, status: null, projectAt: null })).toEqual(idle(-Infinity));
  });
});

describe('compareActivity and sortByActivity', () => {
  it('puts a working session first, then the newest', () => {
    expect(compareActivity(working(1), idle(9))).toBeLessThan(0);
    expect(compareActivity(idle(9), idle(1))).toBeLessThan(0);
    expect(compareActivity(idle(1), idle(9))).toBeGreaterThan(0);
    expect(compareActivity(idle(-Infinity), idle(-Infinity))).toBe(0);
    // Two working: the one that started working later. A started at 10:00 and has worked since 12:00; B started at
    // 11:00 and has worked since 11:30: A's work is the more recent.
    const a = activityOf({ state: 'working', startedAt: 1000, status: { since: 1200, stoppedAt: null }, projectAt: null });
    const b = activityOf({ state: 'working', startedAt: 1100, status: { since: 1130, stoppedAt: null }, projectAt: null });
    expect(compareActivity(a, b)).toBeLessThan(0);
  });

  it('sorts newest first, working ones first, and keeps a tie in its order', () => {
    const at: Record<string, Activity> = { a: idle(1), b: idle(5), c: working(2), d: idle(5), e: idle(-Infinity), f: working(3) };
    expect(sortByActivity(['a', 'b', 'c', 'd', 'e', 'f'], k => at[k])).toEqual(['f', 'c', 'b', 'd', 'a', 'e']);
    expect(newestActivity(['a', 'b', 'c'], k => at[k])).toEqual(working(2));
    expect(newestActivity([], k => at[k])).toBeNull();
  });
});

describe('sortGroupsByActivity', () => {
  const at: Record<string, Activity> = { a1: idle(10), a2: idle(40), b1: idle(30), c1: working(5), d1: idle(50) };
  const groups = [
    { key: 'a', rows: ['a1', 'a2'] }, { key: 'b', rows: ['b1'] }, { key: 'c', rows: ['c1'] }, { key: 'd', rows: ['d1'], none: true },
    { key: 'empty', rows: [] as string[] }, { key: 'new', rows: [] as string[], own: 35 },
  ];
  const keys = (gs: ReadonlyArray<{ key: string }>) => gs.map(g => g.key);

  it('orders groups by their most recently active session; an empty one by its own time, else after the rest', () => {
    expect(keys(sortGroupsByActivity(groups, g => g.rows, k => at[k], { emptyAt: g => g.own ?? null })))
      .toEqual(['c', 'd', 'a', 'new', 'b', 'empty']);
  });

  it('keeps the first ones first and the last ones last, each in its own order', () => {
    expect(keys(sortGroupsByActivity(groups, g => g.rows, k => at[k], { first: g => g.key === 'b', last: g => g.none === true })))
      .toEqual(['b', 'c', 'a', 'empty', 'new', 'd']);
  });
});

describe('holdOrder: the order shown while the list is in use', () => {
  it('keeps the held order, drops what is gone, and slots a new key in after the one before it', () => {
    expect(holdOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(holdOrder(['c', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(holdOrder(['c', 'n', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c', 'n']);
    expect(holdOrder(['n', 'm', 'c', 'a'], ['a', 'c'])).toEqual(['n', 'm', 'a', 'c']);
    expect(holdOrder(['b', 'a'], null)).toEqual(['b', 'a']);
  });

  it('holds each group and its rows', () => {
    const live = { groups: ['p2', 'p1', 'p3'], rows: { p1: ['y', 'x'], p2: ['z'], p3: ['w'] } };
    const held = { groups: ['p1', 'p2'], rows: { p1: ['x', 'y'], p2: ['z'] } };
    // p3 is new: it goes after p1, the group before it in the live order.
    expect(holdListOrder(live, held)).toEqual({ groups: ['p1', 'p3', 'p2'], rows: { p1: ['x', 'y'], p2: ['z'], p3: ['w'] } });
    expect(holdListOrder(live, null)).toBe(live);
  });

  it('compares orders by their keys', () => {
    const a = { groups: ['p1'], rows: { p1: ['x', 'y'] } };
    expect(sameListOrder(a, { groups: ['p1'], rows: { p1: ['x', 'y'] } })).toBe(true);
    expect(sameListOrder(a, { groups: ['p1'], rows: { p1: ['y', 'x'] } })).toBe(false);
    expect(sameListOrder(a, { groups: ['p1'], rows: { p1: ['x', 'y'], p2: [] } })).toBe(false);
    expect(sameListOrder(a, null)).toBe(false);
    expect(sameListOrder(null, null)).toBe(true);
  });
});
