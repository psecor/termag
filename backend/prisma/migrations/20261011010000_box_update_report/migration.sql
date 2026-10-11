-- the outcome of the last termag-box-update run on a box, posted by the box
-- (POST /api/box-update/report), so the admin Fleet table shows whether a box pulled,
-- reconciled, installed and restarted without that box's journal. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "lastUpdateAt" TIMESTAMP(3),
ADD COLUMN     "lastUpdateOutcome" TEXT,
ADD COLUMN     "lastUpdateDetail" TEXT,
ADD COLUMN     "lastUpdateCommit" TEXT;
