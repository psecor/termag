-- The Slack agent session tables from #555 (slack/agentStore.ts), which reached
-- production through `prisma db push` with no migration of their own. Recorded
-- here so `prisma migrate deploy` from scratch has them before the next
-- migration alters them; IF NOT EXISTS, so it is a no-op where they exist.

-- CreateTable
CREATE TABLE IF NOT EXISTS "slack_agent_threads" (
    "channelId" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "ownerSlackId" TEXT,
    "claudeSessionId" TEXT,
    "workingDir" TEXT,
    "resetAt" TIMESTAMP(3),
    "runHolder" TEXT,
    "runBeatAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_agent_threads_pkey" PRIMARY KEY ("channelId","threadTs")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "slack_agent_threads_updatedAt_idx" ON "slack_agent_threads"("updatedAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "slack_agent_dm_last" (
    "channelId" TEXT NOT NULL,
    "claudeSessionId" TEXT NOT NULL,
    "workingDir" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_agent_dm_last_pkey" PRIMARY KEY ("channelId")
);
