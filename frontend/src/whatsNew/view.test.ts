import { describe, expect, it } from 'vitest';
import type { FlagKey } from '../flags';
import { WINDOW_DAYS, addDays, addSeen, groupByWeek, localDay, parseSeen, tabEntries, unseenIds, weekLabel, weekStart } from './view';
import type { WhatsNewEntry } from './whatsNew';

const entry = (id: string, over: Partial<WhatsNewEntry> = {}): WhatsNewEntry => ({
  id, title: id, surface: 'termag', category: 'new', date: '2026-10-28', flags: [], body: 'Body.', ...over,
});

const TODAY = '2026-10-28'; // a Wednesday
const FLAG = 'simple-ui-chrome-refresh-enabled' as FlagKey;
const SPACES = 'spaces-enabled' as FlagKey;

describe('days and weeks', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-10-28', 5)).toBe('2026-11-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('starts a week on Monday', () => {
    expect(weekStart('2026-10-28')).toBe('2026-10-26');
    expect(weekStart('2026-10-26')).toBe('2026-10-26');
    expect(weekStart('2026-11-01')).toBe('2026-10-26'); // a Sunday
  });

  it('labels this week, last week, then the week of its Monday', () => {
    expect(weekLabel('2026-10-26', TODAY)).toBe('This week');
    expect(weekLabel('2026-10-19', TODAY)).toBe('Last week');
    expect(weekLabel('2026-10-12', TODAY)).toBe('Week of Oct 12');
  });

  it('reads today in the browser\'s own time zone', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('tabEntries', () => {
  const entries = [
    entry('lab-one', { surface: 'lab' }),
    entry('flagged', { flags: [FLAG] }),
    entry('two-flags', { flags: [FLAG, SPACES] }),
    entry('plain'),
    entry('tomorrow', { date: '2026-10-29' }),
    entry('edge', { date: addDays(TODAY, -(WINDOW_DAYS - 1)) }),
    entry('too-old', { date: addDays(TODAY, -WINDOW_DAYS) }),
  ];

  it("keeps the surface's entries from the window, in order", () => {
    expect(tabEntries(entries, 'termag', () => false, TODAY).map(e => e.id)).toEqual(['plain', 'edge']);
    expect(tabEntries(entries, 'lab', () => false, TODAY).map(e => e.id)).toEqual(['lab-one']);
  });

  it('shows an entry behind flags only while every one of them is on', () => {
    expect(tabEntries(entries, 'termag', k => k === FLAG, TODAY).map(e => e.id)).toEqual(['flagged', 'plain', 'edge']);
    expect(tabEntries(entries, 'termag', k => k === SPACES, TODAY).map(e => e.id)).toEqual(['plain', 'edge']);
    expect(tabEntries(entries, 'termag', () => true, TODAY).map(e => e.id)).toEqual(['flagged', 'two-flags', 'plain', 'edge']);
  });
});

describe('groupByWeek', () => {
  it('groups consecutive entries by the week they fall in', () => {
    const groups = groupByWeek([
      entry('a', { date: '2026-10-28' }),
      entry('b', { date: '2026-10-26' }),
      entry('c', { date: '2026-10-25' }),
      entry('d', { date: '2026-10-08' }),
    ], TODAY);
    expect(groups.map(g => [g.label, g.entries.map(e => e.id)])).toEqual([
      ['This week', ['a', 'b']],
      ['Last week', ['c']],
      ['Week of Oct 5', ['d']],
    ]);
  });

  it('is empty for no entries', () => {
    expect(groupByWeek([], TODAY)).toEqual([]);
  });
});

describe('seen', () => {
  it('reads a stored list and treats anything else as nothing seen', () => {
    expect([...parseSeen('["a","b"]')]).toEqual(['a', 'b']);
    expect([...parseSeen('["a",3,null]')]).toEqual(['a']);
    for (const raw of [null, '', 'not json', '{"a":1}', '"a"']) expect(parseSeen(raw).size, String(raw)).toBe(0);
  });

  it('adds ids and keeps only the ones that still exist', () => {
    expect(addSeen(new Set(['gone', 'a']), ['b'], ['a', 'b', 'c'])).toBe('["a","b"]');
  });

  it('lists what is unseen', () => {
    expect(unseenIds([entry('a'), entry('b')], new Set(['a']))).toEqual(['b']);
  });
});
