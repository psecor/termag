-- A session archived from a space's Files (chat-nested-agents-enabled): Files
-- lists it in its Archived fold instead. Additive and nullable; nothing else
-- reads it.
ALTER TABLE "workstreams" ADD COLUMN "explorerArchivedAt" TIMESTAMP(3);
