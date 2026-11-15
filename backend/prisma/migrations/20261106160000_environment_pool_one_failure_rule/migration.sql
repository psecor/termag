-- Environment pools, one failure rule (services/envPoolPlanner.ts failureHold): a failed prepare or refresh is
-- `terminated` at once with its log, and holds its pool at the setup hash and heads it ran at for an hour, whatever
-- failed. The `env-failed` status and the column that told setup failures apart go. Deploys sync the schema with
-- `prisma db push`; this file is the record.
UPDATE "instances" SET "status" = 'terminated', "terminatedAt" = COALESCE("terminatedAt", now()) WHERE "status" = 'env-failed';
ALTER TABLE "instances" DROP COLUMN "poolSetupFailed";
