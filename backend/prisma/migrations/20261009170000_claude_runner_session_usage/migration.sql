-- token usage a cloud session posts about itself (cumulative, newest post wins),
-- so the Usage tab, the Users leaderboard and the signals see cloud work as provider
-- `claude-cloud` (services/admin/tokenSource.ts). Additive only.

-- AlterTable
ALTER TABLE "claude_runner_sessions" ADD COLUMN     "inputTokens" BIGINT,
ADD COLUMN     "outputTokens" BIGINT,
ADD COLUMN     "cacheReadTokens" BIGINT,
ADD COLUMN     "cacheCreateTokens" BIGINT,
ADD COLUMN     "usageCalls" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "usageAt" TIMESTAMP(3);
