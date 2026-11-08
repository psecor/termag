-- The static layout: a repo project's checkout at ~/code/<repo> on a
-- box made from an environment. Deploys sync the schema with `prisma db push`; this file is the record. Additive and
-- nullable: every existing project keeps its directory under ~/termag/projects.
ALTER TABLE "projects" ADD COLUMN "dir" TEXT;
