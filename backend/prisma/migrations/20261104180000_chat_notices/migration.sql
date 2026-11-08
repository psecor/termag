-- A tool update's restart notice in a chat's timeline.
-- A new table, additive only.

-- CreateTable
CREATE TABLE "chat_notices" (
    "id" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pane" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "runId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_notices_workstreamId_at_idx" ON "chat_notices"("workstreamId", "at");

-- AddForeignKey
ALTER TABLE "chat_notices" ADD CONSTRAINT "chat_notices_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
