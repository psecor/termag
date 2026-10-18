-- The browser session recording a project was created from, kept for the agent
-- launch the box's clone defers (services/projectClone.ts), so the session's
-- Claude Code spans are filed under that recording. Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "launchReplaySessionId" TEXT;
