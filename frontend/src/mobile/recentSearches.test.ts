import { describe, it, expect } from 'vitest';
import { pushRecentSearch, readRecentSearches, RECENT_SEARCHES_KEY, RECENT_SEARCHES_MAX, removeRecentSearch, writeRecentSearches } from './recentSearches';

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('recent searches', () => {
  it('puts the newest first, de-duplicates case-insensitively and caps the list', () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_SEARCHES_MAX + 3; i++) list = pushRecentSearch(list, `q${i}`);
    expect(list).toHaveLength(RECENT_SEARCHES_MAX);
    expect(list[0]).toBe(`q${RECENT_SEARCHES_MAX + 2}`);
    expect(pushRecentSearch(['Foo', 'bar'], ' foo ')).toEqual(['foo', 'bar']);
    expect(pushRecentSearch(['a'], '   ')).toEqual(['a']);
    expect(removeRecentSearch(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('round-trips through storage and survives junk', () => {
    const store = memoryStore();
    writeRecentSearches(store, ['x', 'y']);
    expect(readRecentSearches(store)).toEqual(['x', 'y']);
    store.setItem(RECENT_SEARCHES_KEY, '{not json');
    expect(readRecentSearches(store)).toEqual([]);
    store.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['ok', 3, null]));
    expect(readRecentSearches(store)).toEqual(['ok']);
    expect(readRecentSearches(null)).toEqual([]);
  });
});
