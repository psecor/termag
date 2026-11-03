-- The session that sent each ask, and what became of the notice termag gives
-- it when the ask finishes.
-- Null on every message from before. Additive only.

-- AlterTable
ALTER TABLE "agent_messages" ADD COLUMN     "notice" TEXT,
ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifyProjectId" TEXT,
ADD COLUMN     "notifyVia" TEXT,
ADD COLUMN     "notifyWorkstream" TEXT;

-- CreateIndex
CREATE INDEX "agent_messages_notifiedAt_completedAt_idx" ON "agent_messages"("notifiedAt", "completedAt");
