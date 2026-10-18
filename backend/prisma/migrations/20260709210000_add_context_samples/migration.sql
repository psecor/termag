-- CreateTable
CREATE TABLE "context_samples" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstream" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "meanTokens" INTEGER NOT NULL,
    "maxTokens" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL,

    CONSTRAINT "context_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "context_samples_projectId_bucket_idx" ON "context_samples"("projectId", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "context_samples_projectId_workstream_bucket_key" ON "context_samples"("projectId", "workstream", "bucket");

-- AddForeignKey
ALTER TABLE "context_samples" ADD CONSTRAINT "context_samples_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
