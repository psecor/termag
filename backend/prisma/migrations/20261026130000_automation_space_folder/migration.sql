-- Automations bound to a folder of their space (
-- decision 13): the folder, stored once, and why a run's space step was
-- skipped or failed. Additive. Automations already mirroring notes keep
-- them where they are: their folder is the project-id path the one-file
-- mirror used (automations/<projectId>/memory/MEMORY.md).

-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "spaceFolder" TEXT;

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "spaceSyncError" TEXT;

-- Backfill
UPDATE "automations" SET "spaceFolder" = 'automations/' || "projectId" WHERE "spaceName" IS NOT NULL AND "spaceFolder" IS NULL;
