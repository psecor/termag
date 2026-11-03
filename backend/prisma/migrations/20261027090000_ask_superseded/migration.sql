-- A follow-up steered into a working ask's turn supersedes it.
-- Additive only.

-- AlterTable
ALTER TABLE "agent_messages" ADD COLUMN     "supersededById" TEXT;
