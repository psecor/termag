-- Teams for PR analytics: a roster of people,
-- sourced from the org-tree, with effective-dated membership intervals.
-- Additive only.

-- CreateTable
CREATE TABLE "teams" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "teamKey" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3),
    "openStart" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'synced',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("teamKey","login","start")
);

-- AlterTable
ALTER TABLE "pr_analytics_settings" ADD COLUMN "seededTeams" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "team_memberships_login_start_idx" ON "team_memberships"("login", "start");

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_teamKey_fkey" FOREIGN KEY ("teamKey") REFERENCES "teams"("key") ON DELETE CASCADE ON UPDATE CASCADE;
