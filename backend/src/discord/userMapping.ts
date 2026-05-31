/**
 * Discord User → Termag User Mapping
 *
 * Resolves a Discord user ID to a termag user.
 * Uses the discordUserId field on the User model.
 * Initial linking is done via DISCORD_USER_MAP env var (discordId:unixUser pairs)
 * or manually in the database.
 */

import { PrismaClient, User } from '@prisma/client';

const prisma = new PrismaClient();
const cache = new Map<string, User | null>();

/**
 * Look up the termag user for a Discord user ID.
 */
export async function resolveDiscordUser(discordUserId: string): Promise<User | null> {
  if (cache.has(discordUserId)) return cache.get(discordUserId) ?? null;

  // Check DB
  const user = await prisma.user.findUnique({ where: { discordUserId } });
  if (user) {
    cache.set(discordUserId, user);
    return user;
  }

  // Check env-based mapping: DISCORD_USER_MAP=discordId:unixUser,discordId2:unixUser2
  const mapping = process.env.DISCORD_USER_MAP;
  if (mapping) {
    for (const pair of mapping.split(',')) {
      const [did, unixUser] = pair.trim().split(':');
      if (did === discordUserId && unixUser) {
        try {
          const byUnix = await prisma.user.findUnique({ where: { unixUsername: unixUser } });
          if (byUnix) {
            // Link for future lookups
            const updated = await prisma.user.update({
              where: { id: byUnix.id },
              data: { discordUserId },
            });
            cache.set(discordUserId, updated);
            return updated;
          }
        } catch (err) {
          console.error('[DISCORD_USER_MAP] Failed to link user:', (err as Error).message);
        }
      }
    }
  }

  cache.set(discordUserId, null);
  return null;
}
