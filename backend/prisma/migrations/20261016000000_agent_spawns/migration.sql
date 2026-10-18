-- CreateTable
CREATE TABLE "agent_spawns" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "parentProjectId" TEXT,
    "parentWorkstream" TEXT,
    "parentRole" TEXT,
    "parentSession" TEXT,
    "parentInstanceId" TEXT,
    "childProjectId" TEXT,
    "childProjectName" TEXT NOT NULL,
    "childWorkstream" TEXT NOT NULL,
    "childInstanceId" TEXT,
    "provider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'starting',
    "error" TEXT,
    "report" JSONB,
    "launchedAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "nudgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_spawns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_spawns_userId_createdAt_idx" ON "agent_spawns"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_spawns_parentProjectId_parentWorkstream_idx" ON "agent_spawns"("parentProjectId", "parentWorkstream");

-- CreateIndex
CREATE INDEX "agent_spawns_childProjectName_childWorkstream_idx" ON "agent_spawns"("childProjectName", "childWorkstream");

-- AddForeignKey
ALTER TABLE "agent_spawns" ADD CONSTRAINT "agent_spawns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

