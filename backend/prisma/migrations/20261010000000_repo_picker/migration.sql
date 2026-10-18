ALTER TABLE "projects" ADD COLUMN "repoUrl" TEXT;

ALTER TABLE "instances" ADD COLUMN "repoPromptDismissedAt" TIMESTAMP(3);
