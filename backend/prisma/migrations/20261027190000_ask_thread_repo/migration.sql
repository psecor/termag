-- Asks into one repository of a multi-repo project (
-- "Asks"): the repository a thread runs in. Additive; every existing thread
-- stays null, a single-repository target.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "repoName" TEXT;
