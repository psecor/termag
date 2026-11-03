-- `termag ask --new-box` made the thread's box and project for it.
-- False on every thread from
-- before, and on threads to a box that already existed. Additive only.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "newBox" BOOLEAN NOT NULL DEFAULT false;
