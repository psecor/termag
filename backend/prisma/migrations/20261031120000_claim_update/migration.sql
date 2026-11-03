-- A warm claim's update to the orchestrator's commit before its first launch
-- (services/claimUpdate.ts). Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "claimUpdateDetail" TEXT,
ADD COLUMN     "claimUpdateStartedAt" TIMESTAMP(3),
ADD COLUMN     "claimUpdateStatus" TEXT;
