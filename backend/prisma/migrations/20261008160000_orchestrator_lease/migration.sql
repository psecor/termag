-- orchestrator_leases: the one row that says which orchestrator process runs
-- the sweeps, so a blue/green deploy can overlap two processes. Only processes
-- started with ORCHESTRATOR_LEASE=true read or write it.
CREATE TABLE "orchestrator_leases" (
    "id" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "holderLabel" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orchestrator_leases_pkey" PRIMARY KEY ("id")
);
