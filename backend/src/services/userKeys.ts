/**
 * The user id behind a unix username, for telemetry that only has a session
 * name (services/status.ts parses `<username>-<project>-agent`). The id is
 * the key every signal carries as
 * termag.user.id; the username is not, so an event about a session
 * resolves it here. Cached for the process: usernames never change.
 */
import { prisma } from '../db';

type Lookup = (unixUsername: string) => Promise<string | null>;

const cache = new Map<string, string>();

const fromDb: Lookup = async (unixUsername) => {
  const row = await prisma.user.findUnique({ where: { unixUsername }, select: { id: true } });
  return row?.id ?? null;
};

/** The user id for a unix username, or null for a username no user has. Never throws. */
export async function userIdForUnixUsername(unixUsername: string, lookup: Lookup = fromDb): Promise<string | null> {
  const hit = cache.get(unixUsername);
  if (hit) return hit;
  try {
    const id = await lookup(unixUsername);
    if (id) cache.set(unixUsername, id);
    return id;
  } catch {
    return null;
  }
}

/** Seed from a place that already knows both, so the common case never reads the DB. */
export function rememberUserKey(unixUsername: string, userId: string): void {
  cache.set(unixUsername, userId);
}

/** Test hook. */
export function resetUserKeysForTests(): void {
  cache.clear();
}
