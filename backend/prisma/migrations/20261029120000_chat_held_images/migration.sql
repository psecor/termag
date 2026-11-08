-- Held messages keep their images: additive only.
ALTER TABLE "chat_held_messages" ADD COLUMN "images" JSONB;
ALTER TABLE "chat_held_messages" ADD COLUMN "imageTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "chat_held_messages" ADD COLUMN "boxStartedAt" TIMESTAMP(3);
