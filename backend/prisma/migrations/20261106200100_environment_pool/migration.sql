-- Environment pools: what a pool box was prepared with, and where it is.
-- Deploys sync the schema with `prisma db push`; this file is the record.
ALTER TABLE "instances" ADD COLUMN "poolSetupHash" TEXT;
ALTER TABLE "instances" ADD COLUMN "preparedCommit" JSONB;
ALTER TABLE "instances" ADD COLUMN "preparedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "poolRepos" JSONB;
ALTER TABLE "instances" ADD COLUMN "poolLog" TEXT;
ALTER TABLE "instances" ADD COLUMN "poolSetupFailed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instances" ADD COLUMN "availabilityZone" TEXT;
ALTER TABLE "instances" ADD COLUMN "subnetId" TEXT;
CREATE INDEX "instances_status_poolEnvironmentId_idx" ON "instances"("status", "poolEnvironmentId");
