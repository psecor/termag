-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'full',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "prOnChange" BOOLEAN NOT NULL DEFAULT true,
    "wakeBox" BOOLEAN NOT NULL DEFAULT false,
    "maxRunMinutes" INTEGER NOT NULL DEFAULT 60,
    "keepRuns" INTEGER NOT NULL DEFAULT 20,
    "spaceName" TEXT,
    "pausedReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "lastOccurrence" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "workstreamId" TEXT,
    "instanceId" TEXT,
    "chatSessionId" TEXT,
    "summary" TEXT,
    "branch" TEXT,
    "prUrl" TEXT,
    "costUsd" DOUBLE PRECISION,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automations_projectId_key" ON "automations"("projectId");

-- CreateIndex
CREATE INDEX "automations_userId_idx" ON "automations"("userId");

-- CreateIndex
CREATE INDEX "automations_enabled_nextRunAt_idx" ON "automations"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_workstreamId_key" ON "automation_runs"("workstreamId");

-- CreateIndex
CREATE INDEX "automation_runs_automationId_createdAt_idx" ON "automation_runs"("automationId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_state_startedAt_idx" ON "automation_runs"("state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_automationId_scheduledFor_trigger_key" ON "automation_runs"("automationId", "scheduledFor", "trigger");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
