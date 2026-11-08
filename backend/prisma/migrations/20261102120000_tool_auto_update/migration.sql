-- Automatic tool updates (phase 3). All additive.

-- Why an automatic run was made (the sweep's decision, in words).
ALTER TABLE "software_update_runs" ADD COLUMN "reason" TEXT;

-- The resume marker: when a start resumed the box from hibernated (not a
-- refresh resume). The sweep sends a run on the box's first hello after it.
ALTER TABLE "instances" ADD COLUMN "resumedFromHibernationAt" TIMESTAMP(3);

-- What the sweep keeps per box and tool: when it first saw the box with the
-- flag on, and the floor breach it is timing for force (and when a pass last saw it).
CREATE TABLE "tool_auto_update_states" (
    "hostKey" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "breachFloor" TEXT,
    "breachSince" TIMESTAMP(3),
    "breachSeenAt" TIMESTAMP(3),

    CONSTRAINT "tool_auto_update_states_pkey" PRIMARY KEY ("hostKey","component")
);
