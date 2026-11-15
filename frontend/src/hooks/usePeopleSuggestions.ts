import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usersApi, type PersonMatch } from '../services/api';
import { browserStorage, personMatches, readRecentPeople } from '../utils/recentPeople';

/** Wait this long after the last keystroke before asking the server. */
export const PERSON_SEARCH_DEBOUNCE_MS = 150;
/** The server answers [] below this many characters, so it isn't asked. */
export const PERSON_SEARCH_MIN_QUERY = 2;

/**
 * Who to suggest for what's typed: the people this browser last shared with
 * (utils/recentPeople.ts) that match, then whoever GET /api/users/search finds,
 * without repeats. The search waits for typing to pause, and only the newest
 * question's answer lands. `refreshRecent` reads the recent people again (call
 * it when the list opens, so a share made in another dialog shows up).
 * PersonPicker and the preview links' TeammatePicker both draw from this.
 */
export function usePeopleSuggestions(query: string): { people: PersonMatch[]; refreshRecent: () => void } {
  const q = query.trim();
  const [found, setFound] = useState<{ query: string; people: PersonMatch[] }>({ query: '', people: [] });
  const [recent, setRecent] = useState(() => readRecentPeople(browserStorage()));
  const request = useRef(0);

  useEffect(() => {
    if (q.length < PERSON_SEARCH_MIN_QUERY) return;
    const id = ++request.current;
    const timer = setTimeout(() => {
      usersApi.search(q)
        .then(people => { if (request.current === id) setFound({ query: q, people }); })
        .catch(() => { if (request.current === id) setFound({ query: q, people: [] }); });
    }, PERSON_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const people = useMemo(() => {
    const seen = new Set<string>();
    const out: PersonMatch[] = [];
    const add = (p: PersonMatch) => {
      const key = p.email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };
    for (const p of recent) if (personMatches(p, q)) add(p);
    if (q.length >= PERSON_SEARCH_MIN_QUERY && found.query === q) for (const p of found.people) add(p);
    return out;
  }, [recent, found, q]);

  const refreshRecent = useCallback(() => setRecent(readRecentPeople(browserStorage())), []);
  return { people, refreshRecent };
}
