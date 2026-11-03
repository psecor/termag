-- Who drives a chat's Claude session, termag's chat runner or the desktop
-- app's T3 thread (the single writer), and the ids that match a workstream to
-- its thread and its session. Additive only: nullable columns.

-- AlterTable
ALTER TABLE "workstreams" ADD COLUMN     "chatHolder" TEXT,
ADD COLUMN     "chatHolderAt" TIMESTAMP(3),
ADD COLUMN     "chatSessionId" TEXT,
ADD COLUMN     "t3ThreadId" TEXT;
