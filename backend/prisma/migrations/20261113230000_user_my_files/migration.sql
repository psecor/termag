-- My files: the person's own
-- space, made the first time it's needed or chosen in Settings, and whether it
-- is granted to their boxes ("Put My files on my boxes", on by default). Read
-- and written only under project-files-enabled. Additive: one nullable column
-- (indexed, set null with the space) and one defaulted column. Not a unique
-- index: on an existing table that is a change the boot-time additive db:push
-- refuses; services/projectFiles.ts keeps one space to one role under a lock.
ALTER TABLE "users" ADD COLUMN "myFilesSpaceId" TEXT;
ALTER TABLE "users" ADD COLUMN "myFilesOnBoxes" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "users_myFilesSpaceId_idx" ON "users"("myFilesSpaceId");

ALTER TABLE "users" ADD CONSTRAINT "users_myFilesSpaceId_fkey" FOREIGN KEY ("myFilesSpaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
