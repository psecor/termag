import { prisma } from '../db';

/**
 * Finding a termag user by what someone types into an email field: the share
 * dialog's and the space dialog's person picker (`GET /api/users/search`).
 * Prefix matches only, at most PEOPLE_MAX of them, and nothing beyond what the
 * caller would type anyway (email and name): everyone signed in sits behind
 * Okta, so the directory is not secret, but it is not handed out wholesale.
 */
export const PEOPLE_MIN_QUERY = 2;
export const PEOPLE_MAX_QUERY = 100;
export const PEOPLE_MAX = 8;
/** Rows each rank's query narrows to before peopleMatching decides; ILIKE's `_` and `%` can over-match. */
const CANDIDATES = 50;

export interface PersonRow {
  id: string;
  googleEmail: string;
  displayName: string;
  unixUsername: string;
  lastSeenAt: Date | null;
}

export interface Person {
  email: string;
  displayName: string;
}

/** 0 the email itself, 1 an email prefix, 2 a name (any word) or username prefix; null no match. */
function rankOf(row: PersonRow, q: string): number | null {
  const email = row.googleEmail.toLowerCase();
  if (email === q) return 0;
  if (email.startsWith(q)) return 1;
  const name = row.displayName.toLowerCase();
  if (name.startsWith(q) || name.split(/\s+/).some(word => word.startsWith(q))) return 2;
  if (row.unixUsername.toLowerCase().startsWith(q)) return 2;
  return null;
}

/**
 * Of `rows`, the ones `query` matches, best first: the exact email, then email
 * prefixes, then name or username prefixes; within each, the most recently
 * seen first (never seen last), then by email. `selfId` is left out.
 */
export function peopleMatching(rows: PersonRow[], query: string, selfId: string): Person[] {
  const q = query.trim().toLowerCase();
  if (q.length < PEOPLE_MIN_QUERY) return [];
  return rows
    .filter(row => row.id !== selfId)
    .map(row => ({ row, rank: rankOf(row, q) }))
    .filter((r): r is { row: PersonRow; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank
      || (b.row.lastSeenAt?.getTime() ?? 0) - (a.row.lastSeenAt?.getTime() ?? 0)
      || a.row.googleEmail.localeCompare(b.row.googleEmail))
    .slice(0, PEOPLE_MAX)
    .map(({ row }) => ({ email: row.googleEmail, displayName: row.displayName }));
}

type UserWhere = NonNullable<Parameters<typeof prisma.user.findMany>[0]>['where'];
export type FindPeople = (where: UserWhere, take: number) => Promise<PersonRow[]>;

const findPeople: FindPeople = (where, take) => prisma.user.findMany({
  where,
  select: { id: true, googleEmail: true, displayName: true, unixUsername: true, lastSeenAt: true },
  orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { googleEmail: 'asc' }],
  take,
});

/**
 * The database half, one query per rank (the email itself, email prefixes,
 * then names and usernames), each capped on its own: a cap shared by all of
 * them would be filled by the most recently seen, and newer name matches
 * could push out the exact email. Prisma's insensitive equals/startsWith/
 * contains is ILIKE, where `_` and `%` are wildcards, so the queries only
 * narrow candidates and peopleMatching decides (the same split as
 * findUserByEmail).
 */
export async function searchPeople(query: string, selfId: string, find: FindPeople = findPeople): Promise<Person[]> {
  const q = query.trim();
  if (q.length < PEOPLE_MIN_QUERY) return [];
  const notMe = { id: { not: selfId } };
  const ranks = await Promise.all([
    find({ ...notMe, googleEmail: { equals: q, mode: 'insensitive' } }, PEOPLE_MAX),
    find({ ...notMe, googleEmail: { startsWith: q, mode: 'insensitive' } }, CANDIDATES),
    find({
      ...notMe,
      OR: [
        { displayName: { startsWith: q, mode: 'insensitive' } },
        { displayName: { contains: ` ${q}`, mode: 'insensitive' } },
        { unixUsername: { startsWith: q, mode: 'insensitive' } },
      ],
    }, CANDIDATES),
  ]);
  const byId = new Map<string, PersonRow>();
  for (const row of ranks.flat()) byId.set(row.id, row);
  return peopleMatching([...byId.values()], q, selfId);
}
