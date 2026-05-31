/**
 * Slack User → Termag User Mapping
 *
 * Resolves a Slack user ID to a termag user by matching email.
 * Caches the mapping in the DB (slackUserId field) after first lookup.
 */

import { PrismaClient, User } from '@prisma/client';
import type { WebClient } from '@slack/web-api';

const prisma = new PrismaClient();

// In-memory cache: slackUserId → termag User
const cache = new Map<string, User | null>();

/**
 * Look up the termag user for a Slack user ID.
 * Returns null if no matching termag user exists.
 */
export async function resolveTermagUser(slackUserId: string, slackClient?: WebClient): Promise<User | null> {
  // Check in-memory cache
  if (cache.has(slackUserId)) return cache.get(slackUserId) ?? null;

  // Check DB — maybe we already linked this Slack ID
  const bySlackId = await prisma.user.findUnique({ where: { slackUserId } });
  if (bySlackId) {
    cache.set(slackUserId, bySlackId);
    return bySlackId;
  }

  // Not linked yet — look up email via Slack API and match to googleEmail
  if (!slackClient) {
    cache.set(slackUserId, null);
    return null;
  }

  try {
    const info = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) {
      cache.set(slackUserId, null);
      return null;
    }

    const byEmail = await prisma.user.findUnique({ where: { googleEmail: email } });
    if (!byEmail) {
      cache.set(slackUserId, null);
      return null;
    }

    // Link the Slack ID to this user for future lookups
    const updated = await prisma.user.update({
      where: { id: byEmail.id },
      data: { slackUserId },
    });

    cache.set(slackUserId, updated);
    return updated;
  } catch (err) {
    console.error('[USER_MAPPING] Failed to resolve Slack user:', (err as Error).message);
    cache.set(slackUserId, null);
    return null;
  }
}

/**
 * Clear the cache (e.g. if user mapping changes)
 */
export function clearUserCache(): void {
  cache.clear();
}
