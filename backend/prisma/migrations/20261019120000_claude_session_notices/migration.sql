-- owner notices (a Slack DM about a cloud session), the dedupe
-- record for services/claudeRunnerNotices.ts. Additive.
CREATE TABLE "claude_session_notices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claude_session_notices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claude_session_notices_userId_code_at_idx" ON "claude_session_notices"("userId", "code", "at");

ALTER TABLE "claude_session_notices" ADD CONSTRAINT "claude_session_notices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
