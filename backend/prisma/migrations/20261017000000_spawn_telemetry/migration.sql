-- AlterTable
ALTER TABLE "agent_spawns" ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "rootSpawnId" TEXT;

-- CreateTable
CREATE TABLE "spawn_events" (
    "id" TEXT NOT NULL,
    "spawnId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "instanceId" TEXT,
    "parentProjectId" TEXT,
    "parentWorkstream" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spawn_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_samples" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diskUsedPct" INTEGER,
    "memUsedPct" INTEGER,
    "load1" DOUBLE PRECISION,
    "cores" INTEGER,
    "memTotalMb" INTEGER,
    "liveAgents" INTEGER,
    "spawnedLive" INTEGER,

    CONSTRAINT "host_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spawn_events_userId_at_idx" ON "spawn_events"("userId", "at");

-- CreateIndex
CREATE INDEX "spawn_events_kind_at_idx" ON "spawn_events"("kind", "at");

-- CreateIndex
CREATE INDEX "spawn_events_spawnId_idx" ON "spawn_events"("spawnId");

-- CreateIndex
CREATE INDEX "host_samples_instanceId_at_idx" ON "host_samples"("instanceId", "at");

-- CreateIndex
CREATE INDEX "host_samples_at_idx" ON "host_samples"("at");

-- CreateIndex
CREATE INDEX "agent_spawns_rootSpawnId_idx" ON "agent_spawns"("rootSpawnId");

