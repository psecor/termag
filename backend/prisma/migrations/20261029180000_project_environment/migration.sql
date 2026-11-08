-- A project's environment file and the box's last report of its steps.
-- Additive only: two nullable columns.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "environmentFile" JSONB,
ADD COLUMN "environmentStatus" JSONB;
