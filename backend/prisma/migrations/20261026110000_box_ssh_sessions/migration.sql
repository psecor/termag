-- Auto-stop idle boxes, PR 2: open SSH and SSM sessions
-- in the agent's latest host sample, for the lifecycle sweep's `ssh` busy
-- check. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "sshSessions" INTEGER;
