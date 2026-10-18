import { describe, expect, it } from 'vitest';
import { RULES, segmentFor, isActiveDay, AGENT_FLOOR_MS } from './rules';

// The ladder's cases, plus the agent-time floor.
describe('segmentFor (the engagement ladder)', () => {
  const emptyCreations = new Map();

  it('fresh join is New for 3 days including the join day', () => {
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      expect(segmentFor('2026-10-05', new Set(), emptyCreations, day)).toBe('New');
    }
    expect(segmentFor('2026-10-05', new Set(), emptyCreations, '2026-10-08')).toBe('Dormant');
  });

  it('day-4 quiet user is Dormant, not New', () => {
    expect(segmentFor('2026-10-01', new Set(), emptyCreations, '2026-10-05')).toBe('Dormant');
  });

  it('3 active days in the window count as Active', () => {
    const act = new Set(['2026-10-08', '2026-10-10', '2026-10-12']);
    expect(segmentFor('2026-10-01', act, emptyCreations, '2026-10-12')).toBe('Active');
  });

  it('Power needs the creation volume on top of the 5/7 cadence', () => {
    const act = new Set(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    const oneday = new Map([['2026-10-08', { boxes: 2, projects: 0, workstreams: 0 }]]);
    expect(segmentFor('2026-10-01', act, new Map(), '2026-10-12')).toBe('Active');
    expect(segmentFor('2026-10-01', act, oneday, '2026-10-12')).toBe('Power');
  });

  it('5/7 needs five distinct days; 4 of 7 stays Active (PTO tolerated)', () => {
    const act = new Set(['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10']);
    const twoDays = new Map([['2026-10-06', { boxes: 2, projects: 0, workstreams: 0 }]]);
    expect(segmentFor('2026-10-01', act, twoDays, '2026-10-12')).toBe('Active');
    const five = new Set([...act, '2026-10-11', '2026-10-12']);
    expect(segmentFor('2026-10-01', five, twoDays, '2026-10-12')).toBe('Power');
  });

  it('one activity day is Passive; cadence ages out of the sliding window', () => {
    const act = new Set(['2026-10-10']);
    expect(segmentFor('2026-10-01', act, emptyCreations, '2026-10-14')).toBe('Passive');
    expect(segmentFor('2026-10-01', act, emptyCreations, '2026-10-17')).toBe('Dormant');
  });

  it('30-day Dormant window: a user from Oct 1 is Dormant on Nov 15 with no activity', () => {
    const act = new Set(['2026-10-10']); // long gone by Nov 15
    expect(segmentFor('2026-10-01', act, emptyCreations, '2026-11-15')).toBe('Dormant');
  });

  it('agent time below the 5-min floor does not fire the day', () => {
    expect(isActiveDay({ agentMs: AGENT_FLOOR_MS - 1, humanMs: 0, tokenRows: 0, visited: true })).toBe(false);
    expect(isActiveDay({ agentMs: AGENT_FLOOR_MS, humanMs: 0, tokenRows: 0, visited: false })).toBe(true);
    expect(isActiveDay({ agentMs: 0, humanMs: 1, tokenRows: 0, visited: false })).toBe(true);
    expect(isActiveDay({ agentMs: 0, humanMs: 0, tokenRows: 3, visited: false })).toBe(true);
  });

  it('RULES hold the ladder thresholds', () => {
    expect(RULES).toMatchObject({
      NEW_DAYS: 3, ACTIVE_WINDOW: 7, ACTIVE_MIN: 3, PASSIVE_WINDOW: 7, PASSIVE_MIN: 1,
      POWER_WINDOW: 7, POWER_MIN: 5, POWER_CREAT_WINDOW: 30, POWER_BOXES: 2,
      POWER_CREATIONS: 5, DORMANT_WINDOW: 30,
    });
  });
});
