-- CreateTable
CREATE TABLE "software_update_runs" (
    "id" TEXT NOT NULL,
    "hostKey" TEXT NOT NULL,
    "instanceId" TEXT,
    "component" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "requestedById" TEXT,
    "restart" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "target" TEXT,
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "detail" TEXT,
    "sessions" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "software_update_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "software_update_runs_hostKey_requestedAt_idx" ON "software_update_runs"("hostKey", "requestedAt");
