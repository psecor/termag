-- An ask thread that publishes to an existing pull request of the asker's
-- (`termag ask --update-pr`):
-- its number, repository and head branch, remembered so later turns publish
-- there too. Additive; every existing thread stays null and publishes to its
-- own branch.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "targetPr" INTEGER,
ADD COLUMN     "targetRepo" TEXT,
ADD COLUMN     "targetBranch" TEXT;
