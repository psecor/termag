-- Review groups of the PR overlay: a user's own ordered lists of PRs reviewed together.
CREATE TABLE "pr_review_groups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pr_review_group_members" (
    "groupId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_group_members_pkey" PRIMARY KEY ("groupId","repo","number")
);

CREATE INDEX "pr_review_groups_userId_idx" ON "pr_review_groups"("userId");

ALTER TABLE "pr_review_groups" ADD CONSTRAINT "pr_review_groups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pr_review_group_members" ADD CONSTRAINT "pr_review_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "pr_review_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
