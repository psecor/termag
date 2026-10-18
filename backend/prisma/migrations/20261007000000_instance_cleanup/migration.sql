-- Instance.cleanedUpAt / cleanupAttemptedAt: whether a terminated ec2 box's
-- AWS teardown finished, and when it last started. No backfill: rows
-- terminated before this column keep NULL, so the provisioning sweep re-checks
-- them a few at a time, and a box whose resources are already gone costs only
-- NotFound answers.
ALTER TABLE "instances" ADD COLUMN "cleanedUpAt" TIMESTAMP(3),
ADD COLUMN "cleanupAttemptedAt" TIMESTAMP(3);
