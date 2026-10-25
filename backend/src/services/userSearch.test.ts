import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ prisma: {} }));
import { PEOPLE_MAX, peopleMatching, searchPeople, type FindPeople, type PersonRow } from './userSearch';

const row = (over: Partial<PersonRow> & { id: string }): PersonRow => ({
  googleEmail: `${over.id}@x.test`, displayName: over.id, unixUsername: over.id, lastSeenAt: null, ...over,
});

describe('peopleMatching', () => {
  it('needs two characters, and never lists the caller', () => {
    const rows = [row({ id: 'gus' }), row({ id: 'me', googleEmail: 'gus.me@x.test' })];
    expect(peopleMatching(rows, 'g', 'me')).toEqual([]);
    expect(peopleMatching(rows, ' gu ', 'me')).toEqual([{ email: 'gus@x.test', displayName: 'gus' }]);
  });

  it('matches email, any word of the name and the username by prefix only', () => {
    const rows = [
      row({ id: 'a', googleEmail: 'ada@x.test', displayName: 'Ada Lovelace' }),
      row({ id: 'b', googleEmail: 'bob@x.test', displayName: 'Bob Love' }),
      row({ id: 'c', googleEmail: 'cleo@x.test', displayName: 'Cleo', unixUsername: 'lovec' }),
      row({ id: 'd', googleEmail: 'glove@x.test', displayName: 'Dee Glover' }),
    ];
    expect(peopleMatching(rows, 'LOVE', 'nobody').map(p => p.email).sort()).toEqual(['ada@x.test', 'bob@x.test', 'cleo@x.test']);
    expect(peopleMatching(rows, 'x.test', 'nobody')).toEqual([]);
  });

  it('puts the exact email first, then email prefixes, then names; recently seen first within each', () => {
    const seen = (d: string) => new Date(d);
    const rows = [
      row({ id: 'n1', googleEmail: 'zed@x.test', displayName: 'Sam Old', lastSeenAt: seen('2026-01-01') }),
      row({ id: 'n2', googleEmail: 'yan@x.test', displayName: 'Sam New', lastSeenAt: seen('2026-10-01') }),
      row({ id: 'e1', googleEmail: 'sam.b@x.test', lastSeenAt: null }),
      row({ id: 'e2', googleEmail: 'sam.a@x.test', lastSeenAt: null }),
      row({ id: 'e3', googleEmail: 'sam.c@x.test', lastSeenAt: seen('2026-05-01') }),
      row({ id: 'x', googleEmail: 'sam@x.test' }),
    ];
    expect(peopleMatching(rows, 'sam', 'nobody').map(p => p.email)).toEqual([
      'sam.c@x.test', 'sam.a@x.test', 'sam.b@x.test', 'sam@x.test', 'yan@x.test', 'zed@x.test',
    ]);
    // The whole email beats a longer one it is a prefix of, however recently that one was seen.
    rows.push(row({ id: 'y', googleEmail: 'sam@x.test.example', lastSeenAt: seen('2026-10-20') }));
    expect(peopleMatching(rows, 'Sam@x.test', 'nobody').map(p => p.email)).toEqual(['sam@x.test', 'sam@x.test.example']);
  });

  it('returns at most PEOPLE_MAX, with only email and name', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `kim${i}` }));
    const found = peopleMatching(rows, 'kim', 'nobody');
    expect(found).toHaveLength(PEOPLE_MAX);
    expect(Object.keys(found[0]).sort()).toEqual(['displayName', 'email']);
  });

  it('decides on the text, not ILIKE: `_` and `%` are not wildcards here', () => {
    const rows = [row({ id: 'a', googleEmail: 'ab@x.test' }), row({ id: 'b', googleEmail: 'a_b@x.test' })];
    expect(peopleMatching(rows, 'a_', 'nobody').map(p => p.email)).toEqual(['a_b@x.test']);
    expect(peopleMatching(rows, 'a%', 'nobody')).toEqual([]);
  });
});

describe('searchPeople', () => {
  it('asks once per rank, so 50 newer name matches cannot push out the exact email', async () => {
    const names = Array.from({ length: 50 }, (_, i) => row({ id: `n${i}`, googleEmail: `n${i}@x.test`, displayName: `sam@x.test fan ${i}`, lastSeenAt: new Date(2026, 9, 1, 0, i) }));
    const exact = row({ id: 'old', googleEmail: 'sam@x.test', displayName: 'Sam', lastSeenAt: new Date(2020, 0, 1) });
    const asked: { where: unknown; take: number }[] = [];
    const find: FindPeople = async (where, take) => {
      asked.push({ where, take });
      const w = where as { googleEmail?: { equals?: string; startsWith?: string } };
      if (w.googleEmail?.equals) return [exact];
      if (w.googleEmail?.startsWith) return [exact];
      return names.slice(0, take);
    };
    const found = await searchPeople(' sam@x.test ', 'me', find);
    expect(found[0]).toEqual({ email: 'sam@x.test', displayName: 'Sam' });
    expect(found).toHaveLength(PEOPLE_MAX);
    expect(asked).toHaveLength(3);
    for (const { where } of asked) expect(where).toMatchObject({ id: { not: 'me' } });
    expect(asked.map(a => a.take)).toEqual([PEOPLE_MAX, 50, 50]);
  });

  it('asks nothing under two characters', async () => {
    const find = vi.fn();
    expect(await searchPeople(' s ', 'me', find)).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
