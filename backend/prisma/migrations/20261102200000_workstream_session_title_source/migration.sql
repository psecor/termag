-- When a chat's session title last changed and who set it (a person's rename,
-- or Claude's title at a turn end), so termag web and the desktop app keep the
-- newer title and Claude's never replaces a person's. Additive only.

-- AlterTable
ALTER TABLE "workstreams" ADD COLUMN     "sessionTitleAt" TIMESTAMP(3),
ADD COLUMN     "sessionTitleSource" TEXT;
