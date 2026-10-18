// The Search tab's recent searches: newest first, de-duplicated
// case-insensitively, capped. Kept in localStorage per device; pure helpers
// so the list rules are unit-tested.
export const RECENT_SEARCHES_KEY = 'termag-mobile-recent-searches';
export const RECENT_SEARCHES_MAX = 10;

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

export function readRecentSearches(store: Store): string[] {
  try {
    const v = JSON.parse(store?.getItem(RECENT_SEARCHES_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_SEARCHES_MAX) : [];
  } catch { return []; }
}

export function pushRecentSearch(list: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return list;
  return [q, ...list.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_SEARCHES_MAX);
}

export function removeRecentSearch(list: string[], query: string): string[] {
  return list.filter(x => x !== query);
}

export function writeRecentSearches(store: Store, list: string[]): void {
  try { store?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
