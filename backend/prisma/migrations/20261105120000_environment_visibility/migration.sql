-- Environments are personal or shared.
-- Deploys sync the schema with `prisma db push`; this file is the record. Existing rows keep a null
-- visibility, which backfillEnvironmentVisibility (services/environments.ts) decides at startup against
-- GitHub: shared, owned by its creator, when it keeps to the shared rules, else personal to its creator.
ALTER TABLE "environments" ADD COLUMN "visibility" TEXT;
ALTER TABLE "environments" ADD COLUMN "ownerUserId" TEXT;
CREATE INDEX "environments_ownerUserId_idx" ON "environments"("ownerUserId");
