-- The project record: user_projects and
-- user_project_repos, and projects.userProjectId. Additive: two new tables and
-- one nullable column, nothing renamed or dropped. Read and written only for
-- people with user-projects-enabled on, and by its backfill script. Rollback:
-- drop the column and the two tables.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "userProjectId" TEXT;

-- CreateTable
CREATE TABLE "user_projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "repoSetKey" TEXT NOT NULL,
    "formerRepoSetKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filesSpaceId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'checkout',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_project_repos" (
    "id" TEXT NOT NULL,
    "userProjectId" TEXT NOT NULL,
    "repoKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_project_repos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_projects_filesSpaceId_key" ON "user_projects"("filesSpaceId");

-- CreateIndex
CREATE INDEX "user_projects_userId_repoSetKey_idx" ON "user_projects"("userId", "repoSetKey");

-- CreateIndex
CREATE UNIQUE INDEX "user_projects_userId_nameKey_key" ON "user_projects"("userId", "nameKey");

-- CreateIndex
CREATE INDEX "user_project_repos_userProjectId_idx" ON "user_project_repos"("userProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "user_project_repos_userProjectId_repoKey_key" ON "user_project_repos"("userProjectId", "repoKey");

-- CreateIndex
CREATE INDEX "projects_userProjectId_idx" ON "projects"("userProjectId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userProjectId_fkey" FOREIGN KEY ("userProjectId") REFERENCES "user_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_projects" ADD CONSTRAINT "user_projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_projects" ADD CONSTRAINT "user_projects_filesSpaceId_fkey" FOREIGN KEY ("filesSpaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_project_repos" ADD CONSTRAINT "user_project_repos_userProjectId_fkey" FOREIGN KEY ("userProjectId") REFERENCES "user_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

