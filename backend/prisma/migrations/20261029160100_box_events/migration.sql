-- Fleet operations on a box (services/boxEvents.ts): resize and disk grow,
-- one append-only row per operation. A new table only, so an older process
-- neither reads nor needs it.
CREATE TABLE "box_events" (
    "id" TEXT NOT NULL,
    "boxId" TEXT,
    "boxName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT,
    "from" TEXT,
    "to" TEXT,
    "phase" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "detail" JSONB,

    CONSTRAINT "box_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "box_events_boxId_startedAt_idx" ON "box_events"("boxId", "startedAt");
CREATE INDEX "box_events_kind_startedAt_idx" ON "box_events"("kind", "startedAt");

ALTER TABLE "box_events" ADD CONSTRAINT "box_events_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
