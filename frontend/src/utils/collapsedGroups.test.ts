import { describe, expect, it } from 'vitest';
import { COLLAPSED_GROUPS_KEY, groupRollup, pruneCollapsedGroups, readCollapsedGroups, writeCollapsedGroups } from './collapsedGroups';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

describe('collapsed groups storage', () => {
  it('round-trips the keys; empty when absent, junk or without storage', () => {
    const s = memory();
    expect(readCollapsedGroups(s).size).toBe(0);
    writeCollapsedGroups(s, new Set(['box-b', '__shared', 'box-a']));
    expect(s.m.get(COLLAPSED_GROUPS_KEY)).toBe('["__shared","box-a","box-b"]');
    expect([...readCollapsedGroups(s)].sort()).toEqual(['__shared', 'box-a', 'box-b']);
    s.setItem(COLLAPSED_GROUPS_KEY, '{not json'); expect(readCollapsedGroups(s).size).toBe(0);
    s.setItem(COLLAPSED_GROUPS_KEY, '{"a":1}'); expect(readCollapsedGroups(s).size).toBe(0);
    s.setItem(COLLAPSED_GROUPS_KEY, '["a",2,null]'); expect([...readCollapsedGroups(s)]).toEqual(['a']);
    expect(readCollapsedGroups(null).size).toBe(0);
  });
  it('prunes box ids that are gone, keeps fixed groups, and returns the same set when nothing changed', () => {
    const keys = new Set(['box-a', 'box-gone', '__local']);
    expect([...pruneCollapsedGroups(keys, new Set(['box-a']))].sort()).toEqual(['__local', 'box-a']);
    const kept = new Set(['box-a', '__local']);
    expect(pruneCollapsedGroups(kept, new Set(['box-a']))).toBe(kept);
  });
});

describe('group rollup', () => {
  it('counts sessions, working and waiting, and picks the strongest status', () => {
    const r = groupRollup(['idle', 'working', 'waiting', 'not_running', 'working']);
    expect(r).toMatchObject({ sessions: 5, top: 'working', working: 2, waiting: 1 });
    expect(r.label).toBe('5 sessions · 2 working · 1 waiting');
  });
  it('leaves out zero counts and adds unseen stops', () => {
    expect(groupRollup(['idle']).label).toBe('1 session');
    expect(groupRollup(['idle', 'waiting'], 2)).toMatchObject({ top: 'waiting', label: '2 sessions · 1 waiting · 2 stopped unseen' });
  });
  it('is not running with no sessions', () => {
    expect(groupRollup([])).toMatchObject({ sessions: 0, top: 'not_running', label: '0 sessions' });
  });
});
