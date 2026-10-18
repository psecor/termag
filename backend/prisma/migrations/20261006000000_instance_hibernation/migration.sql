-- Box hibernation. hibernationConfigured is fixed at launch (EC2 only takes
-- HibernationOptions on RunInstances), so every existing box stays false.
ALTER TABLE "instances" ADD COLUMN "hibernationConfigured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instances" ADD COLUMN "hibernatedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "rehibernatePending" BOOLEAN NOT NULL DEFAULT false;
