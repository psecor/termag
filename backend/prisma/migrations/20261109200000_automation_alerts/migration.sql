-- Automation alerts and the outbound webhook ("Alerts
-- and the outbound webhook"). Additive: new columns with defaults or
-- nullable, and a new table. Read and written only under
-- automation-alerts-enabled; rollback is the flag off.

-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "alertPrefix" TEXT,
ADD COLUMN     "alertRegex" TEXT,
ADD COLUMN     "alertTarget" TEXT NOT NULL DEFAULT 'dm',
ADD COLUMN     "healthAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "webhookHost" TEXT;

-- CreateTable
CREATE TABLE "automation_notices" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "runId" TEXT,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_notices_dedupeKey_key" ON "automation_notices"("dedupeKey");

-- CreateIndex
CREATE INDEX "automation_notices_deliveredAt_failedAt_nextAttemptAt_idx" ON "automation_notices"("deliveredAt", "failedAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "automation_notices_automationId_createdAt_idx" ON "automation_notices"("automationId", "createdAt");

-- AddForeignKey
ALTER TABLE "automation_notices" ADD CONSTRAINT "automation_notices_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
