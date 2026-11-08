-- The environment a project's checkouts came from,
-- when one did. Null on every project from before, and on one made from
-- repositories. No foreign key: it outlives the environment. Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "environmentId" TEXT;
