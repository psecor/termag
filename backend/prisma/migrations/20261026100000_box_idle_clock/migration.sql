-- Auto-stop idle boxes, PR 1: when the box last came up
-- (its agent's connect after a start, a resume or a first boot), for the
-- lifecycle sweep's start grace, and the last box-update push, for its
-- box-update busy check. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "lastReadyAt" TIMESTAMP(3),
ADD COLUMN     "updatePushedAt" TIMESTAMP(3);
