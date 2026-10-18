ALTER TABLE "instances" ADD COLUMN "githubDeliveredAt" TIMESTAMP(3);

UPDATE "instances"
SET "githubDeliveredAt" = "lastConnectedAt"
WHERE "githubDeliveredAt" IS NULL
  AND "lastConnectedAt" IS NOT NULL
  AND "userId" IS NOT NULL
  AND status NOT IN ('warm', 'warming');
