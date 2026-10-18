-- Automatic box terminate: the per-box limit,
-- the unsaved-work scan behind it, and when the sweep terminated a box.
-- Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "hibernatedTerminateDays" INTEGER,
ADD COLUMN     "unsavedWork" JSONB,
ADD COLUMN     "unsavedWorkCheckedAt" TIMESTAMP(3),
ADD COLUMN     "autoTerminatedAt" TIMESTAMP(3);
