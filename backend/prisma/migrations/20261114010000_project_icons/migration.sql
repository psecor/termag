-- Project icons: the images a person's
-- project icons can be (project_icons: a favicon or app icon read from one of
-- their repositories, or an upload, stored here and served by the orchestrator
-- to its owner only), the icon each project shows (user_projects.iconChoice and
-- iconId; null is automatic) and each repository's detected icon and when it
-- was last looked for (user_project_repos.iconId and iconsCheckedAt). Read and
-- written only under user-projects-enabled. Additive: one new table and four
-- nullable columns, nothing renamed or dropped. Rollback: drop the four columns
-- and the table.
-- AlterTable
ALTER TABLE "user_projects" ADD COLUMN     "iconChoice" TEXT,
ADD COLUMN     "iconId" TEXT;

-- AlterTable
ALTER TABLE "user_project_repos" ADD COLUMN     "iconId" TEXT,
ADD COLUMN     "iconsCheckedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "project_icons" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoKey" TEXT NOT NULL DEFAULT '',
    "path" TEXT,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_icons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_icons_userId_repoKey_sha256_key" ON "project_icons"("userId", "repoKey", "sha256");

-- AddForeignKey
ALTER TABLE "user_projects" ADD CONSTRAINT "user_projects_iconId_fkey" FOREIGN KEY ("iconId") REFERENCES "project_icons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_project_repos" ADD CONSTRAINT "user_project_repos_iconId_fkey" FOREIGN KEY ("iconId") REFERENCES "project_icons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_icons" ADD CONSTRAINT "project_icons_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

