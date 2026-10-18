-- CreateTable
CREATE TABLE "project_visits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "previousProjectId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionTag" TEXT,

    CONSTRAINT "project_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warp_samples" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "meanWarp" DOUBLE PRECISION NOT NULL,
    "maxWarp" DOUBLE PRECISION NOT NULL,
    "p95Warp" DOUBLE PRECISION NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "activeMs" INTEGER NOT NULL,

    CONSTRAINT "warp_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_visits_userId_timestamp_idx" ON "project_visits"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "project_visits_projectId_timestamp_idx" ON "project_visits"("projectId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "warp_samples_userId_bucket_key" ON "warp_samples"("userId", "bucket");

-- CreateIndex
CREATE INDEX "warp_samples_userId_bucket_idx" ON "warp_samples"("userId", "bucket");

-- AddForeignKey
ALTER TABLE "project_visits" ADD CONSTRAINT "project_visits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_visits" ADD CONSTRAINT "project_visits_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warp_samples" ADD CONSTRAINT "warp_samples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
