-- the session ordinal among its owner's sessions ("Claude Cloud 3"), set as a
-- session's first run is recorded and the same on every run; rows from before are
-- numbered by the startup backfill (services/claudeSessions.ts). Additive only.

-- AlterTable
ALTER TABLE "claude_runner_sessions" ADD COLUMN     "sessionSeq" INTEGER;

-- CreateIndex
CREATE INDEX "claude_runner_sessions_userId_sessionSeq_idx" ON "claude_runner_sessions"("userId", "sessionSeq");

