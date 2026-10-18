-- Daily briefing: a per-user schedule (opt-in, {} = off)
-- and one row per composed briefing. Additive only.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "briefingSchedule" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "briefings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "since" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "tz" TEXT NOT NULL,
    "windowLabel" TEXT NOT NULL,
    "windowBasis" TEXT NOT NULL DEFAULT 'since_last',
    "instanceId" TEXT,
    "scheduleKey" TEXT,
    "deliverSlack" BOOLEAN NOT NULL DEFAULT false,
    "slackSentAt" TIMESTAMP(3),
    "content" JSONB,
    "stats" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "briefings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "briefings_scheduleKey_key" ON "briefings"("scheduleKey");
CREATE INDEX "briefings_userId_createdAt_idx" ON "briefings"("userId", "createdAt");
CREATE INDEX "briefings_status_createdAt_idx" ON "briefings"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
