-- An admin can quarantine a box for forensics (services/boxQuarantine.ts).
ALTER TABLE "instances" ADD COLUMN "quarantinedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "quarantinedById" TEXT;
ALTER TABLE "instances" ADD COLUMN "quarantineReason" TEXT;
ALTER TABLE "instances" ADD COLUMN "quarantineFromStatus" TEXT;
ALTER TABLE "instances" ADD COLUMN "quarantineSteps" JSONB;
