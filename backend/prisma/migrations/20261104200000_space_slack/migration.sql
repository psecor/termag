-- Spaces in Slack, migration 2 (milestone M3):
-- the space's Slack row, its linked channels, a thread's routing history, the
-- asks an orchestrator started, the turns waiting for a box, and who a space
-- event was for. Additive only: new tables, and two nullable columns on
-- space_events that every existing writer leaves null. No backfill.

-- AlterTable
ALTER TABLE "space_events" ADD COLUMN     "onBehalfOfUserId" TEXT,
ADD COLUMN     "surface" TEXT;

-- CreateTable
CREATE TABLE "space_slack" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "enabledById" TEXT NOT NULL,
    "runnerUserId" TEXT NOT NULL,
    "projectId" TEXT,
    "instanceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "suspendReason" TEXT,
    "approvalPolicy" JSONB,
    "limits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "space_slack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_channels" (
    "channelId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "spaceSlackId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdByTermag" BOOLEAN NOT NULL DEFAULT false,
    "linkedById" TEXT NOT NULL,
    "linkedVia" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmTs" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "unlinkedAt" TIMESTAMP(3),
    "unlinkReason" TEXT,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "space_channels_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "slack_thread_routes" (
    "channelId" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "spaceId" TEXT NOT NULL,
    "requestedBySlackId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "orchestratorWorkstream" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_thread_routes_pkey" PRIMARY KEY ("channelId","threadTs","seq")
);

-- CreateTable
CREATE TABLE "space_slack_tasks" (
    "agentThreadId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_slack_tasks_pkey" PRIMARY KEY ("agentThreadId")
);

-- CreateTable
CREATE TABLE "space_slack_pending" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "slackId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_slack_pending_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "space_slack_spaceId_key" ON "space_slack"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_slack_projectId_key" ON "space_slack"("projectId");

-- CreateIndex
CREATE INDEX "space_slack_runnerUserId_idx" ON "space_slack"("runnerUserId");

-- CreateIndex
CREATE INDEX "space_channels_spaceSlackId_idx" ON "space_channels"("spaceSlackId");

-- CreateIndex
CREATE INDEX "slack_thread_routes_spaceId_at_idx" ON "slack_thread_routes"("spaceId", "at");

-- CreateIndex
CREATE INDEX "space_slack_tasks_spaceId_idx" ON "space_slack_tasks"("spaceId");

-- CreateIndex
CREATE INDEX "space_slack_pending_spaceId_queuedAt_idx" ON "space_slack_pending"("spaceId", "queuedAt");

-- AddForeignKey
ALTER TABLE "space_slack" ADD CONSTRAINT "space_slack_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_channels" ADD CONSTRAINT "space_channels_spaceSlackId_fkey" FOREIGN KEY ("spaceSlackId") REFERENCES "space_slack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

