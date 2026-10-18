-- CreateTable
CREATE TABLE "agent_handoffs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstream" TEXT NOT NULL,
    "instanceId" TEXT,
    "session" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "requestedMode" TEXT NOT NULL,
    "fromProvider" TEXT NOT NULL,
    "toProvider" TEXT,
    "initiator" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "reason" TEXT,
    "body" TEXT,
    "storageRef" TEXT,
    "contextTokensBefore" INTEGER,
    "writeRequestedAt" TIMESTAMP(3),
    "writtenAt" TIMESTAMP(3),
    "resetAt" TIMESTAMP(3),
    "killedAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_handoffs_userId_createdAt_idx" ON "agent_handoffs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_handoffs_projectId_workstream_state_idx" ON "agent_handoffs"("projectId", "workstream", "state");

-- CreateIndex
CREATE INDEX "agent_handoffs_state_idx" ON "agent_handoffs"("state");

-- AddForeignKey
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
