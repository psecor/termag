-- The environment pool's refresh: when a refresh started a stopped box,
-- and when the refresh last checked it. Deploys sync the schema with `prisma db push`; this file is the record.
ALTER TABLE "instances" ADD COLUMN "refreshStartedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "refreshCheckedAt" TIMESTAMP(3);
