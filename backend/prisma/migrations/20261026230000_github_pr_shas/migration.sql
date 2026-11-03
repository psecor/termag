-- A PR's head and merge commits, so a shipped PR joins the deploys and the
-- observability service.version that contain it (docs/agents/data-and-schema.md).
-- Additive only; filled by the PR analytics ingester as it next reads each PR.

-- AlterTable
ALTER TABLE "github_prs" ADD COLUMN     "headSha" TEXT,
ADD COLUMN     "mergeSha" TEXT;

-- CreateIndex
CREATE INDEX "github_prs_mergeSha_idx" ON "github_prs"("mergeSha");
