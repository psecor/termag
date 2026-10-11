/**
 * Every token reader's source: the
 * scanner's `token_usage_days` rows plus the token usage cloud sessions post
 * about themselves, shaped like those rows as provider `claude-cloud`. One
 * fragment, so the admin token report, the Users leaderboard, the owner's
 * usage route and the signals' per-user days cannot disagree.
 *
 * A cloud run's tokens are dated to the UTC day it started: a run lives at
 * most twelve hours, so it spans at most two UTC days and token_burn's "today"
 * may miss a long run's tail (said in the doc). Its `hostKey` is the box, its
 * `sourceKey` the order id, it has no project, and `calls` is the number of
 * API responses the session counted (1 when it did not).
 */
import { Prisma } from '@prisma/client';

export const CLOUD_TOKEN_PROVIDER = 'claude-cloud';

/** Inclusive UTC day keys; `userId` narrows both halves to one owner. Use as `FROM ${tokenSourceSql(...)} t`. */
export function tokenSourceSql(sinceKey: string, untilKey: string, userId?: string): Prisma.Sql {
  const user = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;
  return Prisma.sql`(
    SELECT "userId", "hostKey", "provider", "date", "sourceKey", "projectId", "workstream",
           "input", "output", "cacheRead", "cacheCreate", "reasoning", "calls", "estimated"
    FROM token_usage_days
    WHERE "date" >= ${sinceKey} AND "date" <= ${untilKey} ${user}
    UNION ALL
    SELECT "userId", "instanceId" AS "hostKey", ${CLOUD_TOKEN_PROVIDER}::text AS "provider",
           to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date", "orderId" AS "sourceKey",
           NULL::text AS "projectId", NULL::text AS "workstream",
           COALESCE("inputTokens", 0) AS "input", COALESCE("outputTokens", 0) AS "output",
           COALESCE("cacheReadTokens", 0) AS "cacheRead", COALESCE("cacheCreateTokens", 0) AS "cacheCreate",
           0::bigint AS "reasoning", COALESCE("usageCalls", 1) AS "calls", false AS "estimated"
    FROM claude_runner_sessions
    WHERE "usageAt" IS NOT NULL
      AND to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= ${sinceKey}
      AND to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= ${untilKey} ${user}
  )`;
}
