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

/**
 * tokenSourceSql split by model, for a report grouped by `model` or `backend`:
 * token_usage_model_days, plus every token_usage_days row that has no model rows
 * (an agent from before the split, vibe, poller estimates) as model '', plus
 * cloud sessions with the model they posted. Its totals equal tokenSourceSql's.
 */
export function modelTokenSourceSql(sinceKey: string, untilKey: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT "userId", "hostKey", "provider", "date", "sourceKey", "projectId", "workstream", "model", "backend",
           "input", "output", "cacheRead", "cacheCreate", "reasoning", "calls", false AS "estimated"
    FROM token_usage_model_days
    WHERE "date" >= ${sinceKey} AND "date" <= ${untilKey}
    UNION ALL
    SELECT d."userId", d."hostKey", d."provider", d."date", d."sourceKey", d."projectId", d."workstream", ''::text AS "model", ''::text AS "backend",
           d."input", d."output", d."cacheRead", d."cacheCreate", d."reasoning", d."calls", d."estimated"
    FROM token_usage_days d
    WHERE d."date" >= ${sinceKey} AND d."date" <= ${untilKey}
      AND NOT EXISTS (
        SELECT 1 FROM token_usage_model_days m
        WHERE m."userId" = d."userId" AND m."hostKey" = d."hostKey" AND m."provider" = d."provider"
          AND m."date" = d."date" AND m."sourceKey" = d."sourceKey")
    UNION ALL
    SELECT "userId", "instanceId" AS "hostKey", ${CLOUD_TOKEN_PROVIDER}::text AS "provider",
           to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date", "orderId" AS "sourceKey",
           NULL::text AS "projectId", NULL::text AS "workstream", COALESCE("model", '') AS "model", ''::text AS "backend",
           COALESCE("inputTokens", 0) AS "input", COALESCE("outputTokens", 0) AS "output",
           COALESCE("cacheReadTokens", 0) AS "cacheRead", COALESCE("cacheCreateTokens", 0) AS "cacheCreate",
           0::bigint AS "reasoning", COALESCE("usageCalls", 1) AS "calls", false AS "estimated"
    FROM claude_runner_sessions
    WHERE "usageAt" IS NOT NULL
      AND to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= ${sinceKey}
      AND to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= ${untilKey}
  )`;
}
