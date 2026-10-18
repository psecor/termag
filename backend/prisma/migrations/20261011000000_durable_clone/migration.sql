ALTER TABLE "projects" ADD COLUMN "repoDefaultBranch" TEXT;
ALTER TABLE "projects" ADD COLUMN "setupStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "projects" ADD COLUMN "setupError" TEXT;
ALTER TABLE "projects" ADD COLUMN "setupAttempt" INTEGER NOT NULL DEFAULT 0;
