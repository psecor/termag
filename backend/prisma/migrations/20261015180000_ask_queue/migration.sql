-- An ask to a parked box waits for its agent. Additive only: both columns are nullable, so a process from
-- before them keeps working during an overlapping deploy.

-- AlterTable
ALTER TABLE "agent_messages" ADD COLUMN "queuedPrompt" TEXT,
ADD COLUMN "queuedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_messages_queuedUntil_idx" ON "agent_messages"("queuedUntil");
