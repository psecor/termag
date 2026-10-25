-- AlterTable
ALTER TABLE "github_prs" ADD COLUMN     "comments" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "humanComments" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "reviewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewRequests" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "reviewsReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "github_repo_sync" ADD COLUMN     "reviewsCursor" TEXT,
ADD COLUMN     "reviewsDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewsTop" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "github_pr_reviews" (
    "id" TEXT NOT NULL,
    "prId" TEXT NOT NULL,
    "reviewerLogin" TEXT NOT NULL,
    "reviewerClass" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "comments" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "github_pr_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_pr_reviews_prId_idx" ON "github_pr_reviews"("prId");

-- CreateIndex
CREATE INDEX "github_pr_reviews_submittedAt_idx" ON "github_pr_reviews"("submittedAt");

-- CreateIndex
CREATE INDEX "github_pr_reviews_reviewerLogin_submittedAt_idx" ON "github_pr_reviews"("reviewerLogin", "submittedAt");

-- AddForeignKey
ALTER TABLE "github_pr_reviews" ADD CONSTRAINT "github_pr_reviews_prId_fkey" FOREIGN KEY ("prId") REFERENCES "github_prs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

