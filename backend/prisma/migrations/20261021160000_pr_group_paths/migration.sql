-- Path-scoped repo group members.
ALTER TABLE "repo_group_members" ADD COLUMN "scope" JSONB;

CREATE TABLE "repo_group_prs" (
    "groupSlug" TEXT NOT NULL,
    "prId" TEXT NOT NULL,
    "matchedFiles" INTEGER NOT NULL,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_group_prs_pkey" PRIMARY KEY ("groupSlug","prId")
);

CREATE INDEX "repo_group_prs_prId_idx" ON "repo_group_prs"("prId");

-- Seed groups are now created once each by slug. Where the original four were
-- seeded, record them, so one an admin deleted is not created again.
ALTER TABLE "pr_analytics_settings" ADD COLUMN "seededGroups" JSONB NOT NULL DEFAULT '[]';
UPDATE "pr_analytics_settings" SET "seededGroups" = '["termag","webapp","sdks","o11y"]' WHERE "groupsSeeded";
