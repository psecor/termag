-- PR link shares from the PR's own checkout (4d): the
-- checkout a share shows when it isn't the workstream's own, and the PR's
-- head branch when shared. Additive only.

-- AlterTable
ALTER TABLE "preview_shares" ADD COLUMN     "prHeadBranch" TEXT,
ADD COLUMN     "checkoutDir" TEXT;
