import { prisma } from '../db';

/** The email comparison every identity path uses (HTTP bridge, WebSocket, sign-in). */
export const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The user whose stored email is `email` under sameEmail, the comparison the
 * HTTP bridge uses, so the HTTP, WebSocket and sign-in paths cannot disagree on
 * who an identity is. googleEmail is unique only case-sensitively, so an exact
 * lookup misses a row stored in another casing. Prisma's insensitive `equals`
 * is ILIKE on Postgres, where `_` and `%` are wildcards: the query only narrows
 * candidates and sameEmail decides. An exact-case row wins over a duplicate
 * that differs only in casing.
 */
export async function findUserByEmail(email: string) {
  const candidates = await prisma.user.findMany({
    where: { googleEmail: { equals: email, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
  });
  return candidates.find(u => u.googleEmail === email) ?? candidates.find(u => sameEmail(u.googleEmail, email)) ?? null;
}
