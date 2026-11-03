-- Multi-repo projects: a project's layout and
-- its repositories. Additive only; every existing project stays
-- layout = 'repo' with no rows.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "layout" TEXT NOT NULL DEFAULT 'repo';

-- CreateTable
CREATE TABLE "project_repos" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "setupStatus" TEXT NOT NULL DEFAULT 'pending',
    "setupError" TEXT,
    "setupAttempt" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_repos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_repos_projectId_idx" ON "project_repos"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_repos_projectId_name_key" ON "project_repos"("projectId", "name");

-- AddForeignKey
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
