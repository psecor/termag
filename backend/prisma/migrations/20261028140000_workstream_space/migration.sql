-- A chat belongs to one space, fixed when it starts.
-- Additive: existing chats get theirs at first use (services/chatSpace.ts).
ALTER TABLE "workstreams" ADD COLUMN "spaceId" TEXT;
ALTER TABLE "workstreams" ADD COLUMN "spaceFixedAt" TIMESTAMP(3);
CREATE INDEX "workstreams_spaceId_idx" ON "workstreams"("spaceId");
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
