-- Migration 1 of spaces in Slack: what a
-- Slack agent thread is bound to, and the least-privilege columns M10 uses.
-- Additive: every column is nullable or defaulted, existing rows stay
-- `personal`, and IF NOT EXISTS keeps it safe where `db push` added them first.

-- AlterTable
ALTER TABLE "slack_agent_threads" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'personal',
ADD COLUMN IF NOT EXISTS "spaceId" TEXT,
ADD COLUMN IF NOT EXISTS "routeSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "frozenAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "mixedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "mixedReasons" JSONB,
ADD COLUMN IF NOT EXISTS "memoryVersions" JSONB;

-- AlterTable
ALTER TABLE "slack_agent_dm_last" ADD COLUMN IF NOT EXISTS "spaceId" TEXT;
