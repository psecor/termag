/**
 * One "Continue on a new box" per chat at a time, held
 * in the database so it holds across orchestrator processes (two of them serve
 * requests during an overlapping deploy). A row in `chat_continue_locks`,
 * keyed by the project, is the lock:
 *
 *   - taken by one INSERT … ON CONFLICT DO UPDATE … WHERE stale: a free
 *     project, or one whose row is older than CONTINUE_LOCK_STALE_MS (a
 *     process that crashed mid-continue), is taken; a live row is not;
 *   - released by deleting the row with this holder's token, so a late
 *     release from a holder whose lock was taken over leaves the new one be.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../db';

/** Longer than any continue takes: createBox answers once the launch is asked for, not when the box is up. */
export const CONTINUE_LOCK_STALE_MS = 5 * 60_000;

/** The holder's token, or null when another continue holds a live lock. */
export async function acquireContinueLock(projectId: string, now = new Date(), staleMs = CONTINUE_LOCK_STALE_MS): Promise<string | null> {
  const token = randomUUID();
  const staleBefore = new Date(now.getTime() - staleMs);
  const rows = await prisma.$queryRaw<Array<{ token: string }>>`
    INSERT INTO "chat_continue_locks" ("projectId", "token", "startedAt")
    VALUES (${projectId}, ${token}, ${now})
    ON CONFLICT ("projectId") DO UPDATE SET "token" = EXCLUDED."token", "startedAt" = EXCLUDED."startedAt"
    WHERE "chat_continue_locks"."startedAt" < ${staleBefore}
    RETURNING "token"`;
  return rows[0]?.token === token ? token : null;
}

export async function releaseContinueLock(projectId: string, token: string): Promise<void> {
  await prisma.chatContinueLock.deleteMany({ where: { projectId, token } });
}

/** Whether a continue holds a live lock on the project: the chat shows it as under way. */
export async function continueUnderWay(projectId: string, now = new Date(), staleMs = CONTINUE_LOCK_STALE_MS): Promise<boolean> {
  const row = await prisma.chatContinueLock.findUnique({ where: { projectId }, select: { startedAt: true } });
  return row != null && row.startedAt.getTime() >= now.getTime() - staleMs;
}
