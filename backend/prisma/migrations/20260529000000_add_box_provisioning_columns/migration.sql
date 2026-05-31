-- AlterTable: per-box AWS resource handles + provisioning error, for
-- orchestrator-driven box provisioning (boxProvisioner.ts). All nullable.
ALTER TABLE "instances" ADD COLUMN "securityGroupId" TEXT;
ALTER TABLE "instances" ADD COLUMN "iamRoleName" TEXT;
ALTER TABLE "instances" ADD COLUMN "provisioningError" TEXT;
