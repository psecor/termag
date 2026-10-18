-- Convert AgentProvider enum columns to plain text (app-level validation)
-- Must drop enum defaults before altering column types
ALTER TABLE "users" ALTER COLUMN "defaultAgentProvider" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "defaultAgentProvider" TYPE TEXT;
ALTER TABLE "users" ALTER COLUMN "defaultAgentProvider" SET DEFAULT 'codex';

ALTER TABLE "workflows" ALTER COLUMN "provider" TYPE TEXT;

-- Drop the enum type (no longer needed) — CASCADE removes remaining dependencies
DROP TYPE IF EXISTS "AgentProvider" CASCADE;

-- Working time tracking table
CREATE TABLE "work_time_entries" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "totalMs" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_time_entries_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one entry per user+project+provider+date
CREATE UNIQUE INDEX "work_time_entries_username_project_provider_date_key"
    ON "work_time_entries"("username", "project", "provider", "date");

-- Index for querying by user and date range
CREATE INDEX "work_time_entries_username_date_idx"
    ON "work_time_entries"("username", "date");
