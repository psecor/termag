-- Auto-stop idle boxes: the default window's
-- warning before a stop and the stop time it promised, and when the sweep
-- last parked the box. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "idleWarnedAt" TIMESTAMP(3),
ADD COLUMN     "idleParkAt" TIMESTAMP(3),
ADD COLUMN     "autoParkedAt" TIMESTAMP(3);
