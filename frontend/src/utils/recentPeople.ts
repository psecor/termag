/**
 * The people this browser last shared something with (a preview, a space), so
 * the person picker can offer them before anything is typed. Per browser
 * (localStorage), newest first, at most RECENT_PEOPLE_MAX; nothing about them
 * goes to the server. Pure helpers over a storage, testable without a DOM.
 */
export const RECENT_PEOPLE_KEY = 'termag-recent-people';
export const RECENT_PEOPLE_MAX = 10;

export interface RecentPerson {
  email: string;
  displayName: string;
  at: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function browserStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}

export function readRecentPeople(storage: StorageLike | null): RecentPerson[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_PEOPLE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is RecentPerson => !!p && typeof p.email === 'string' && p.email.includes('@')
        && typeof p.displayName === 'string' && typeof p.at === 'number')
      .slice(0, RECENT_PEOPLE_MAX);
  } catch { return []; /* corrupt or unavailable: none */ }
}

/** Puts `email` first (replacing an older entry for it), keeping a name already known when none is given. */
export function rememberPerson(storage: StorageLike | null, person: { email: string; displayName?: string }, now = Date.now()): void {
  const email = person.email.trim();
  if (!email.includes('@')) return;
  const all = readRecentPeople(storage);
  const before = all.find(p => p.email.toLowerCase() === email.toLowerCase());
  const next = [
    { email, displayName: person.displayName?.trim() || before?.displayName || '', at: now },
    ...all.filter(p => p !== before),
  ].slice(0, RECENT_PEOPLE_MAX);
  try { storage?.setItem(RECENT_PEOPLE_KEY, JSON.stringify(next)); } catch { /* full or unavailable */ }
}

/** Whether `person` matches what was typed: a prefix of the email, or of any word of the name. */
export function personMatches(person: { email: string; displayName: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (person.email.toLowerCase().startsWith(q)) return true;
  return person.displayName.toLowerCase().split(/\s+/).some(word => word && word.startsWith(q));
}
