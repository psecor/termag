-- What a project or box was made for, when its creator said:
-- 'ask' from
-- `termag project create … --for-ask` / `termag box create --for-ask`. The
-- simple UI folds away the never-run main of a project made for asks. Null
-- on everything else, and on everything from before. Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "createdFor" TEXT;

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "createdFor" TEXT;
