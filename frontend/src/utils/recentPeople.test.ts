import { describe, expect, it } from 'vitest';
import { personMatches, readRecentPeople, rememberPerson, RECENT_PEOPLE_KEY, RECENT_PEOPLE_MAX } from './recentPeople';

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
}

describe('recent people', () => {
  it('remembers newest first, one entry per email in any casing, keeping a known name', () => {
    const s = memory();
    rememberPerson(s, { email: 'gus@x.test', displayName: 'Gus' }, 1);
    rememberPerson(s, { email: 'ada@x.test' }, 2);
    rememberPerson(s, { email: 'GUS@x.test' }, 3);
    expect(readRecentPeople(s)).toEqual([
      { email: 'GUS@x.test', displayName: 'Gus', at: 3 },
      { email: 'ada@x.test', displayName: '', at: 2 },
    ]);
  });

  it(`keeps at most ${RECENT_PEOPLE_MAX}`, () => {
    const s = memory();
    for (let i = 0; i < 15; i++) rememberPerson(s, { email: `p${i}@x.test` }, i);
    const all = readRecentPeople(s);
    expect(all).toHaveLength(RECENT_PEOPLE_MAX);
    expect(all[0].email).toBe('p14@x.test');
  });

  it('reads nothing from corrupt, foreign or missing storage, and ignores what is not an email', () => {
    expect(readRecentPeople(memory({ [RECENT_PEOPLE_KEY]: '{nope' }))).toEqual([]);
    expect(readRecentPeople(memory({ [RECENT_PEOPLE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readRecentPeople(memory({ [RECENT_PEOPLE_KEY]: '[{"email":"x"},{"email":"a@b","displayName":"A","at":1},null]' }))).toEqual([{ email: 'a@b', displayName: 'A', at: 1 }]);
    expect(readRecentPeople(null)).toEqual([]);
    const s = memory();
    rememberPerson(s, { email: 'not an email' });
    expect(s.data[RECENT_PEOPLE_KEY]).toBeUndefined();
    rememberPerson(null, { email: 'a@b' });
  });

  it('matches a prefix of the email or of any word of the name', () => {
    const gus = { email: 'gus.g@x.test', displayName: 'Gus Grissom' };
    expect(personMatches(gus, '')).toBe(true);
    expect(personMatches(gus, 'GUS.')).toBe(true);
    expect(personMatches(gus, 'gris')).toBe(true);
    expect(personMatches(gus, 'x.test')).toBe(false);
    expect(personMatches(gus, 'som')).toBe(false);
  });
});
