-- cloud sessions in the termag UI.
-- ClaudeRunnerSession learns the Anthropic session id (runs of one session
-- group together), the client platform and the owner-only title, all nullable
-- since rows from before this change have none. ClaudeSessionEvent is the
-- append-only log of what happened to a session: every spawn outcome, the
-- box's started and ended, the lost sweep, an end requested from the UI.
-- Additive only.

-- AlterTable
ALTER TABLE "claude_runner_sessions" ADD COLUMN     "clientPlatform" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "claude_session_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "instanceId" TEXT,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claude_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claude_session_events_sessionId_at_idx" ON "claude_session_events"("sessionId", "at");

-- CreateIndex
CREATE INDEX "claude_session_events_userId_at_idx" ON "claude_session_events"("userId", "at");

-- CreateIndex
CREATE INDEX "claude_session_events_orderId_idx" ON "claude_session_events"("orderId");

-- CreateIndex
CREATE INDEX "claude_runner_sessions_sessionId_startedAt_idx" ON "claude_runner_sessions"("sessionId", "startedAt");

-- AddForeignKey
ALTER TABLE "claude_session_events" ADD CONSTRAINT "claude_session_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claude_session_events" ADD CONSTRAINT "claude_session_events_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

