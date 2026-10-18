-- CreateTable
CREATE TABLE "github_prs" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "repoVisibility" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorClass" TEXT NOT NULL,
    "creditedLogin" TEXT,
    "creditSource" TEXT NOT NULL,
    "agentAssisted" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "baseRef" TEXT NOT NULL DEFAULT '',
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "prUpdatedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_prs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repo_sync" (
    "repo" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT '',
    "backfillCursor" TEXT,
    "backfillTop" TIMESTAMP(3),
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "highWater" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repo_sync_pkey" PRIMARY KEY ("repo")
);

-- CreateTable
CREATE TABLE "repo_groups" (
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "members" JSONB NOT NULL DEFAULT '[]',
    "excluded" JSONB NOT NULL DEFAULT '[]',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_groups_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "repo_group_members" (
    "groupSlug" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_group_members_pkey" PRIMARY KEY ("groupSlug","repo")
);

-- CreateTable
CREATE TABLE "pr_analytics_settings" (
    "id" TEXT NOT NULL DEFAULT 'settings',
    "tokenUserId" TEXT,
    "groupsSeeded" BOOLEAN NOT NULL DEFAULT false,
    "botLogins" JSONB NOT NULL DEFAULT '[]',
    "agentLogins" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_analytics_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_prs_repo_mergedAt_idx" ON "github_prs"("repo", "mergedAt");

-- CreateIndex
CREATE INDEX "github_prs_repo_createdAt_idx" ON "github_prs"("repo", "createdAt");

-- CreateIndex
CREATE INDEX "github_prs_creditedLogin_mergedAt_idx" ON "github_prs"("creditedLogin", "mergedAt");

-- CreateIndex
CREATE UNIQUE INDEX "github_prs_repo_number_key" ON "github_prs"("repo", "number");

-- CreateIndex
CREATE INDEX "repo_group_members_repo_idx" ON "repo_group_members"("repo");

