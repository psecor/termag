-- Space memory: which S3 version a file.put stored, and the writer's note.
ALTER TABLE "space_events" ADD COLUMN "versionId" TEXT;
ALTER TABLE "space_events" ADD COLUMN "note" TEXT;
