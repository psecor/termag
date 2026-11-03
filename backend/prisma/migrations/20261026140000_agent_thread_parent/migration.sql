-- The session that started an ask thread: its project and workstream, so the simple UI nests the thread's
-- chat under it. Null on threads from before this and on asks sent from
-- outside a session (a laptop shell). Additive only.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "parentProjectId" TEXT,
ADD COLUMN     "parentWorkstream" TEXT;
