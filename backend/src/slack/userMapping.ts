/**
 * Slack User → Termag User Mapping
 *
 * Resolves a Slack user ID to a termag user by matching email, in any casing
 * (findUserByEmail, as sign-in does).
 * Caches the mapping in the DB (slackUserId field) after first lookup.
 */

import { User } from '@prisma/client';
import { prisma } from '../db';
import { findUserByEmail } from '../services/userByEmail';
import type { WebClient } from '@slack/web-api';


// In-memory cache: slackUserId → termag User
const cache = new Map<string, User>();
// slackUserId → when a lookup last found no termag user. The Slack gate
// (access.ts) refuses an unmatched account, so a miss is retried after a while:
// someone who signs in to termag after first writing to the bot gets in without
// a backend restart. A failed Slack call or a call without a client is not a miss.
const misses = new Map<string, number>();
const MISS_TTL_MS = 5 * 60 * 1000;

/**
 * Look up the termag user for a Slack user ID.
 * Returns null if no matching termag user exists.
 */
export async function resolveTermagUser(slackUserId: string, slackClient?: WebClient, now: number = Date.now()): Promise<User | null> {
  // Check in-memory cache
  const cached = cache.get(slackUserId);
  if (cached) return cached;
  const missedAt = misses.get(slackUserId);
  if (missedAt !== undefined && now - missedAt < MISS_TTL_MS) return null;

  // Check DB — maybe we already linked this Slack ID
  const bySlackId = await prisma.user.findUnique({ where: { slackUserId } });
  if (bySlackId) {
    cache.set(slackUserId, bySlackId);
    misses.delete(slackUserId);
    return bySlackId;
  }

  // Not linked yet — look up email via Slack API and match to googleEmail
  if (!slackClient) return null;

  try {
    const info = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) {
      misses.set(slackUserId, now);
      return null;
    }

    const byEmail = await findUserByEmail(email);
    if (!byEmail) {
      misses.set(slackUserId, now);
      return null;
    }

    // Link the Slack ID to this user for future lookups
    const updated = await prisma.user.update({
      where: { id: byEmail.id },
      data: { slackUserId },
    });

    cache.set(slackUserId, updated);
    misses.delete(slackUserId);
    return updated;
  } catch (err) {
    console.error('[USER_MAPPING] Failed to resolve Slack user:', (err as Error).message);
    return null;
  }
}

/**
 * Whether resolveTermagUser's last null for this account was a real miss: Slack
 * answered and no termag user has that email. False after a failed Slack call
 * (or a call without a client), which says nothing about the account.
 */
export function isKnownMiss(slackUserId: string, now: number = Date.now()): boolean {
  const missedAt = misses.get(slackUserId);
  return missedAt !== undefined && now - missedAt < MISS_TTL_MS;
}

/**
 * Clear the cache (e.g. if user mapping changes)
 */
export function clearUserCache(): void {
  cache.clear();
  misses.clear();
}
